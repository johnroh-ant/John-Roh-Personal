"""Shared model machinery for all four sports.

Every sport model is the same three-layer architecture with different
constants and features (see MODEL.md for the full rationale):

  1. POWER RATINGS (sides). Each team carries a rating measured directly in
     points (runs for MLB) above an average team on a neutral floor/field.
     Expected margin = home_rating - away_rating + learned home advantage
     + learned situational adjustments. After every final score the ratings
     move toward the result by a sport-specific K, with the margin capped
     so blowouts don't poison the rating. This is the FiveThirtyEight /
     Sagarin "predictor" lineage, just denominated in points instead of
     Elo so the rating difference IS the model's spread.

  2. SCORING RATES (totals). Each team carries opponent-adjusted EWMAs of
     points scored and allowed. Expected team score = own offense pushed by
     how the opponent's defense differs from league average; the predicted
     total is the sum plus a learned bias that absorbs league-wide scoring
     drift (rule changes, juiced/dead balls, pace trends).

  3. LEARNED LAYER (the machine-learning loop). Three groups of parameters
     update from every settled game we analyzed — bet or not:
       - feature weights w (home adv, rest, back-to-back, pitcher gap, ...)
         via SGD on the margin error, L2-anchored to researched priors;
       - a market-blend alpha from inverse-MSE tracking of model vs market,
         so the final number leans on whichever has been more accurate;
       - Platt calibration (a, b) per sport fitted online from win/loss
         outcomes, so stated win probabilities match observed frequencies
         and the 1-100 confidence score stays honest.
"""

import math

from .. import db, mathutils


class SportModel:
    """Subclasses set the class attributes and may extend feature_vector()."""

    SPORT = None

    # margin distribution
    SIGMA_MARGIN = None       # sd of (actual margin - true margin)
    SIGMA_TOTAL = None        # sd of (actual total - true total)
    # When set, spreads/moneylines are priced off a DISCRETE margin
    # distribution: a normal discretized onto integers, reweighted by these
    # multipliers (NFL key numbers, MLB walk-off truncation / no ties).
    MARGIN_MULT = None
    PMF_SPAN = 70

    # rating engine
    K_RATING = None           # points of rating moved per point of error
    MOV_CAP = None            # cap on margin used in rating updates
    SEASON_REGRESS = None     # fraction of rating kept across seasons
    LEAGUE_TOTAL = None       # prior league average total points/runs

    # scoring EWMA
    EWMA_ALPHA = None         # weight on the newest game

    # learned-layer priors: {weight_name: prior_value}; must include
    # 'home_adv' and 'total_bias'
    WEIGHT_PRIORS = {}

    SGD_LR = 0.01             # learning rate for feature-weight updates
    SGD_ANCHOR = 0.002        # pull of weights back toward their priors
    CAL_LR = 0.02             # learning rate for Platt calibration

    # market-blend: prior pseudo-observations make alpha start humble and
    # earn trust with evidence
    BLEND_PRIOR_GAMES = 60
    BLEND_PRIOR_ALPHA = 0.30  # initial weight on our model vs the market
    # alpha can never leave this band: the market always keeps a meaningful
    # say (cap), and the model is never silenced entirely (floor) — guards
    # against a lucky/unlucky early streak whipsawing the blend
    ALPHA_BOUNDS = (0.15, 0.70)

    # extra EV the spread must offer over the moneyline before it is
    # preferred for a side (MLB raises this — see MLBModel)
    SPREAD_SELECTION_PENALTY = 0.0

    # innings/periods that make a game's spread and total markets stand
    # when it ends early (None = shortened finals don't happen / all stand)
    FULL_GAME_PERIODS = None

    # NFL/NBA/NCAAB seasons span the new year and are labeled by their
    # start year (Oct 2026 NBA game -> '2026'); August is safely inside
    # every off-season. MLB sets 1, making seasons calendar years.
    SEASON_CUTOVER_MONTH = 8

    # -- parameter access ------------------------------------------------

    def __init__(self, conn):
        self.conn = conn
        self._pmf_cache = {}
        stored = db.get_weights(conn, self.SPORT)
        self.w = dict(self.WEIGHT_PRIORS)
        for k, v in stored.items():
            if k.startswith("w:"):
                self.w[k[2:]] = v  # includes learned keys beyond the priors
                                   # (e.g. MLB park offsets)
        self.cal_a = stored.get("cal_a", 1.0)
        self.cal_b = stored.get("cal_b", 0.0)
        # accuracy trackers for the market blend (sum of squared errors and
        # counts, seeded with priors)
        n = self.BLEND_PRIOR_GAMES
        a = self.BLEND_PRIOR_ALPHA
        # seed model as (1/a - 1)x the market's error so alpha starts at prior
        prior_mse = self.SIGMA_MARGIN ** 2
        self.margin_sse_model = stored.get("margin_sse_model", prior_mse * n * (1 - a) / a)
        self.margin_sse_market = stored.get("margin_sse_market", prior_mse * n)
        self.margin_n = stored.get("margin_n", n)
        prior_mse_t = self.SIGMA_TOTAL ** 2
        self.total_sse_model = stored.get("total_sse_model", prior_mse_t * n * (1 - a) / a)
        self.total_sse_market = stored.get("total_sse_market", prior_mse_t * n)
        self.total_n = stored.get("total_n", n)
        self.league_total = stored.get("league_total", float(self.LEAGUE_TOTAL))

    def save(self):
        for k, v in self.w.items():
            db.set_weight(self.conn, self.SPORT, f"w:{k}", v)
        for name in ("cal_a", "cal_b", "margin_sse_model", "margin_sse_market",
                     "margin_n", "total_sse_model", "total_sse_market",
                     "total_n", "league_total"):
            db.set_weight(self.conn, self.SPORT, name, getattr(self, name))

    # -- ratings ---------------------------------------------------------

    def rating_of(self, team, when):
        """(rating, games_played, season_label), applying season regression
        once when the team is first seen in a NEW season. Strictly
        forward-only: a stale game from a previous season must neither
        re-trigger regression nor roll the stamp backward (which would
        re-trigger it on the next prediction)."""
        rating, games, season = db.get_rating(self.conn, self.SPORT, team)
        season_now = self.season_of(when)
        label = season or season_now
        if season is not None and games > 0 and season_now > season:
            rating *= self.SEASON_REGRESS
            label = season_now
            db.set_rating(self.conn, self.SPORT, team, rating, games, label)
        return rating, games, label

    @classmethod
    def season_of(cls, when):
        return str(when.year if when.month >= cls.SEASON_CUTOVER_MONTH
                   else when.year - 1)

    # -- features ----------------------------------------------------------

    def feature_vector(self, game, context):
        """Situational features multiplying the learned weights.

        Returns {name: value}. The base provides home advantage; subclasses
        add rest, back-to-backs, pitchers, etc. via `context` (a dict the
        pipeline fills with whatever it could discover for this game).
        """
        return {"home_adv": 0.0 if game.get("neutral_site") else 1.0}

    # -- prediction -------------------------------------------------------

    def predict(self, game, context=None):
        """Model's own numbers for a game (before market blending).

        Returns {margin, total, features}: margin is home - away.
        """
        context = context or {}
        when = mathutils.parse_ts(game["commence_time"])
        base = self.rating_of(game["home_team"], when)[0] - \
            self.rating_of(game["away_team"], when)[0]
        feats = self.feature_vector(game, context)
        margin = base + sum(self.w[k] * v for k, v in feats.items())
        total = self.predict_total(game) + self.w["total_bias"]
        return {"margin": margin, "total": total, "features": feats}

    def predict_total(self, game):
        home_off, home_def, _ = db.get_scoring(self.conn, self.SPORT,
                                               game["home_team"])
        away_off, away_def, _ = db.get_scoring(self.conn, self.SPORT,
                                               game["away_team"])
        mean_side = self.league_total / 2.0
        home_off = home_off if home_off is not None else mean_side
        home_def = home_def if home_def is not None else mean_side
        away_off = away_off if away_off is not None else mean_side
        away_def = away_def if away_def is not None else mean_side
        exp_home = home_off + (away_def - mean_side)
        exp_away = away_off + (home_def - mean_side)
        return exp_home + exp_away

    # -- market blend --------------------------------------------------------

    def market_implied_margin(self, line):
        """The home margin the market expects, from FanDuel's prices: the
        spread when one is posted, otherwise the devigged moneyline. MLB
        overrides this — its run line is fixed at +/-1.5 and carries no
        margin information."""
        if line.get("home_spread") is not None:
            return -line["home_spread"]
        return self._moneyline_implied_margin(line)

    def _moneyline_implied_margin(self, line):
        if line.get("home_ml") is None or line.get("away_ml") is None:
            return None
        p_home, _ = mathutils.no_vig_probs(line["home_ml"], line["away_ml"])
        return mathutils.margin_from_win_prob(p_home, self.SIGMA_MARGIN)

    @staticmethod
    def _alpha(sse_model, sse_market, bounds):
        inv_model = 1.0 / max(sse_model, 1e-9)
        inv_market = 1.0 / max(sse_market, 1e-9)
        a = inv_model / (inv_model + inv_market)
        return min(max(a, bounds[0]), bounds[1])

    @property
    def alpha_margin(self):
        """Weight on our margin vs the market's (inverse-MSE weighting)."""
        return self._alpha(self.margin_sse_model, self.margin_sse_market,
                           self.ALPHA_BOUNDS)

    @property
    def alpha_total(self):
        return self._alpha(self.total_sse_model, self.total_sse_market,
                           self.ALPHA_BOUNDS)

    def blended_margin(self, model_margin, market_margin):
        if market_margin is None:
            return model_margin
        a = self.alpha_margin
        return a * model_margin + (1 - a) * market_margin

    def blended_total(self, model_total, market_total):
        if market_total is None:
            return model_total
        a = self.alpha_total
        return a * model_total + (1 - a) * market_total

    # -- probabilities ----------------------------------------------------

    def _calibrate(self, p):
        return mathutils.calibrated_prob(p, self.cal_a, self.cal_b)

    def _margin_pmf(self, margin):
        key = round(margin, 4)
        pmf = self._pmf_cache.get(key)
        if pmf is None:
            pmf = mathutils.discrete_margin_pmf(
                margin, self.SIGMA_MARGIN, self.MARGIN_MULT,
                span=self.PMF_SPAN)
            self._pmf_cache[key] = pmf
        return pmf

    def win_prob_raw(self, margin):
        """Home win probability BEFORE calibration — what the Platt layer
        trains against (training on the calibrated value would make the
        calibrator chase its own output)."""
        if self.MARGIN_MULT is None:
            return mathutils.win_prob_from_margin(margin, self.SIGMA_MARGIN)
        pmf = self._margin_pmf(margin)
        # a residual tie cell (NFL) splits moneyline expectations
        return sum(v for m, v in pmf.items() if m > 0) + \
            0.5 * pmf.get(0, 0.0)

    def win_prob(self, margin):
        return self._calibrate(self.win_prob_raw(margin))

    def ml_probs(self, margin):
        """(p_home_win, p_away_win, p_tie) for moneyline pricing.

        A tie refunds a two-way moneyline, so it must be priced as a push
        — folding half of it into each side's win probability overstates
        underdog EV at lopsided prices."""
        p_tie = (0.0 if self.MARGIN_MULT is None
                 else self._margin_pmf(margin).get(0, 0.0))
        p_home = self._calibrate(self.win_prob_raw(margin) - 0.5 * p_tie)
        p_home = min(p_home, 1.0 - p_tie)
        return p_home, max(0.0, 1.0 - p_tie - p_home), p_tie

    def cover_prob(self, margin, spread):
        """P(cover | no push) — callers re-multiply by (1 - push_prob)."""
        if self.MARGIN_MULT is None:
            push = mathutils.push_prob(margin, spread, self.SIGMA_MARGIN)
            # on an integer spread, the win region starts past the push
            # window — the unconditional CDF would count half the push
            # mass as a win
            threshold = -spread + (0.5 if push > 0 else 0.0)
            win = 1.0 - mathutils.normal_cdf(threshold, margin,
                                             self.SIGMA_MARGIN)
            p = win / max(1.0 - push, 1e-9)
        else:
            win, push = mathutils.discrete_cover_prob(
                self._margin_pmf(margin), spread)
            p = win / max(1.0 - push, 1e-9)
        return self._calibrate(p)

    def push_prob(self, margin, spread):
        if self.MARGIN_MULT is None:
            return mathutils.push_prob(margin, spread, self.SIGMA_MARGIN)
        return mathutils.discrete_cover_prob(self._margin_pmf(margin),
                                             spread)[1]

    def over_prob(self, total_pred, total_line):
        """P(over | no push) — same conditional contract as cover_prob."""
        push = mathutils.push_prob(total_pred, -total_line, self.SIGMA_TOTAL)
        threshold = total_line + (0.5 if push > 0 else 0.0)
        win = 1.0 - mathutils.normal_cdf(threshold, total_pred,
                                         self.SIGMA_TOTAL)
        return self._calibrate(win / max(1.0 - push, 1e-9))

    def total_push_prob(self, total_pred, total_line):
        return mathutils.push_prob(total_pred, -total_line, self.SIGMA_TOTAL)

    # -- learning (called once per settled game, bet or not) -----------------

    def learn(self, game, prediction):
        """Update ratings, scoring rates, weights, blend trackers, and
        calibration from a final score.

        `prediction` is the stored predictions row (or None if we never
        analyzed the game pre-game, e.g. bootstrap backfill — then only the
        ratings/scoring layers update).
        """
        home_pts, away_pts = game["home_score"], game["away_score"]
        margin = home_pts - away_pts
        when = mathutils.parse_ts(game["commence_time"])

        # 1. power ratings
        h_rating, h_games, h_season = self.rating_of(game["home_team"], when)
        a_rating, a_games, a_season = self.rating_of(game["away_team"], when)
        # predictions store features as {"x": numeric features, "ctx": extras}
        feats = (dict(prediction["features"]["x"]) if prediction is not None
                 else self.feature_vector(dict(game), {}))
        expected = h_rating - a_rating + sum(
            self.w.get(k, 0.0) * v for k, v in feats.items())
        capped = max(-self.MOV_CAP, min(self.MOV_CAP, margin))
        capped_expected = max(-self.MOV_CAP, min(self.MOV_CAP, expected))
        err = capped - capped_expected
        db.set_rating(self.conn, self.SPORT, game["home_team"],
                      h_rating + self.K_RATING * err, h_games + 1, h_season)
        db.set_rating(self.conn, self.SPORT, game["away_team"],
                      a_rating - self.K_RATING * err, a_games + 1, a_season)

        # 2. scoring EWMAs
        self._update_scoring(game["home_team"], scored=home_pts,
                             allowed=away_pts)
        self._update_scoring(game["away_team"], scored=away_pts,
                             allowed=home_pts)
        total = home_pts + away_pts
        self.league_total += 0.005 * (total - self.league_total)

        # 3. learned layer — needs a pre-game prediction to compare against
        if prediction is None:
            return

        # the learned layer grades the RAW model numbers (stored alongside
        # the features); pred_home_margin/pred_total are the market blend,
        # which must not be allowed to take credit for the market's half
        raw = prediction["features"].get("raw") or {}
        raw_margin = raw.get("margin", prediction["pred_home_margin"])
        raw_total = raw.get("total", prediction["pred_total"])
        margin_err = margin - raw_margin
        # SGD on feature weights, anchored to priors
        for k, v in feats.items():
            if v == 0.0 or k not in self.w:
                continue
            self.w[k] += self.SGD_LR * margin_err * v
            self.w[k] -= self.SGD_ANCHOR * (
                self.w[k] - self.WEIGHT_PRIORS.get(k, 0.0))
        # totals bias
        total_err = total - raw_total
        self.w["total_bias"] += self.SGD_LR * 0.5 * total_err
        self.w["total_bias"] -= self.SGD_ANCHOR * (
            self.w["total_bias"] - self.WEIGHT_PRIORS["total_bias"])

        # market-blend accuracy trackers (same margin derivation as betting
        # uses pre-game)
        market_margin = self.market_implied_margin({
            "home_spread": prediction.get("market_home_spread"),
            "home_ml": prediction.get("market_home_ml"),
            "away_ml": prediction.get("market_away_ml"),
        })
        if market_margin is not None:
            self.margin_sse_model += margin_err ** 2
            self.margin_sse_market += (margin - market_margin) ** 2
            self.margin_n += 1
        if prediction.get("market_total") is not None:
            self.total_sse_model += total_err ** 2
            self.total_sse_market += (total - prediction["market_total"]) ** 2
            self.total_n += 1

        # Platt calibration on the home-win probability (one logistic SGD
        # step per game; y = did home win). Trains on the RAW probability —
        # pred_home_wp is post-calibration and would double-calibrate.
        p = raw.get("wp", prediction["pred_home_wp"])
        if 0.0 < p < 1.0 and margin != 0:
            z = math.log(p / (1 - p))
            p_cal = mathutils.calibrated_prob(p, self.cal_a, self.cal_b)
            y = 1.0 if margin > 0 else 0.0
            self.cal_a += self.CAL_LR * (y - p_cal) * z
            self.cal_b += self.CAL_LR * (y - p_cal)
            self.cal_a = max(0.2, min(3.0, self.cal_a))
            self.cal_b = max(-1.0, min(1.0, self.cal_b))

    def _update_scoring(self, team, scored, allowed):
        off, dfn, games = db.get_scoring(self.conn, self.SPORT, team)
        mean_side = self.league_total / 2.0
        off = off if off is not None else mean_side
        dfn = dfn if dfn is not None else mean_side
        # warm-up: heavier alpha while the sample is tiny
        alpha = max(self.EWMA_ALPHA, 1.0 / (games + 1))
        off += alpha * (scored - off)
        dfn += alpha * (allowed - dfn)
        db.set_scoring(self.conn, self.SPORT, team, off, dfn, games + 1)

