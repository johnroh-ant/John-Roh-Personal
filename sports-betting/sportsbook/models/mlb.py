"""MLB model.

Lineage: FiveThirtyEight's pitcher-adjusted MLB Elo + Pythagorean-era team
strength thinking. Baseball differs from the other three sports in ways the
constants encode (full rationale in MODEL.md):

  - strength gaps are tiny relative to noise (a 100-win team is ~+0.6
    runs/game vs average, margin sigma is ~4.3 runs), so ratings move very
    slowly (K=0.025, time constant ~40 of 162 games) and edges are small;
  - the starting pitcher is the single biggest game-level variable: each
    starter carries a learned runs-prevented-per-start rating and the gap
    feeds the margin directly. ESPN's probable pitchers fill the context;
  - home advantage is small (~54% win rate, prior 0.25 runs);
  - run margins are discrete with no zero (extra innings), and the walk-off
    truncation skew makes "home by exactly 1" far likelier than the curve
    says — encoded in MARGIN_MULT below;
  - "sides" in baseball means the run line (always +/-1.5) — the generic
    spread machinery handles it, and because the run line price is often
    badly skewed, the moneyline-vs-spread EV comparison matters most here.

Park effects are absorbed partly by the team scoring EWMAs (a team's
offense and defense are always measured half in its own park) with the
home-game residual learned as a per-venue offset on the total.
"""

from .. import db
from .base import SportModel

STARTER_SHARE = 0.6          # share of a game's run prevention credited
                             # to the starting pitcher
PITCHER_EWMA = 0.15          # per-start learning rate for pitcher ratings
PITCHER_CAP = 2.5            # max runs above/below average per start

PARK_LR = 0.02               # per-game learning rate for park totals offsets
PARK_CAP = 2.0               # max learned park effect in runs on the total


class MLBModel(SportModel):
    SPORT = "MLB"

    SIGMA_MARGIN = 4.3
    SIGMA_TOTAL = 4.4

    # Baseball margins are integers with no zero (extra innings) and a
    # heavy walk-off truncation skew: the HOME team wins by exactly 1 in
    # ~32% of its wins (it stops batting the moment it leads in the 9th+)
    # vs ~25% for road teams. Relative to the normal curve: no mass at 0,
    # ~1.85x at +1, ~1.3x at -1. This is why home run lines (-1.5) cover
    # less often than a continuous model thinks.
    MARGIN_MULT = {0: 0.0, 1: 1.85, -1: 1.30}
    PMF_SPAN = 25

    K_RATING = 0.025
    MOV_CAP = 6.0           # a 10-run blowout says little more than a 6-run one
    SEASON_REGRESS = 0.70
    LEAGUE_TOTAL = 8.8
    EWMA_ALPHA = 0.04

    # MLB seasons live inside one calendar year (Mar-Oct)
    SEASON_CUTOVER_MONTH = 1

    # prefer the moneyline side unless the run line beats it by a clear
    # margin — the discrete tails (where +/-1.5 lives) carry the most
    # model risk in baseball
    SPREAD_SELECTION_PENALTY = 0.01

    # FanDuel rules for rain-shortened finals: markets need 9 innings
    FULL_GAME_PERIODS = 9

    WEIGHT_PRIORS = {
        "home_adv": 0.25,    # runs
        "pitcher_gap": 1.0,  # multiplier on (home starter - away starter) runs
        "total_bias": 0.0,
    }

    def market_implied_margin(self, line):
        # the run line is a fixed +/-1.5 carrying no margin information;
        # the market's opinion lives in the moneyline
        return self._moneyline_implied_margin(line)

    def feature_vector(self, game, context):
        feats = super().feature_vector(game, context)
        hp = context.get("home_pitcher")
        ap = context.get("away_pitcher")
        gap = 0.0
        if hp:
            gap += db.get_pitcher(self.conn, hp)[0]
        if ap:
            gap -= db.get_pitcher(self.conn, ap)[0]
        feats["pitcher_gap"] = gap
        return feats

    # -- park effects ------------------------------------------------------
    # Each home venue carries a learned runs offset on the total (prior 0,
    # capped). Coors-like parks converge high during bootstrap; the offset
    # rides on top of the team scoring EWMAs, which already carry about
    # half of a park's effect (half of every team's sample is home games).

    def park_adj(self, home_team):
        return self.w.get(f"park:{home_team}", 0.0)

    def predict_total(self, game):
        return super().predict_total(game) + self.park_adj(game["home_team"])

    def learn(self, game, prediction):
        # park learning uses the PRE-update scoring rates, so compute the
        # baseline before the parent shifts the EWMAs
        baseline_total = (self.predict_total(
            {"home_team": game["home_team"], "away_team": game["away_team"]})
            + self.w["total_bias"])
        super().learn(game, prediction)
        key = f"park:{game['home_team']}"
        adj = self.w.get(key, 0.0)
        err = (game["home_score"] + game["away_score"]) - baseline_total
        adj += PARK_LR * err
        self.w[key] = max(-PARK_CAP, min(PARK_CAP, adj))

        # credit/blame the starters: prediction-time probables first, else
        # the names ESPN attached to the game row (bootstrap / settlement)
        ctx = prediction["features"].get("ctx", {}) if prediction else {}
        if not ctx.get("home_pitcher") and not ctx.get("away_pitcher"):
            ctx = {"home_pitcher": _field(game, "home_pitcher"),
                   "away_pitcher": _field(game, "away_pitcher")}
        league_runs_per_team = self.league_total / 2.0
        for who, allowed in (("home_pitcher", game["away_score"]),
                             ("away_pitcher", game["home_score"])):
            name = ctx.get(who)
            if not name:
                continue
            rating, starts = db.get_pitcher(self.conn, name)
            target = STARTER_SHARE * (league_runs_per_team - allowed)
            alpha = max(PITCHER_EWMA, 1.0 / (starts + 1))
            rating += alpha * (target - rating)
            rating = max(-PITCHER_CAP, min(PITCHER_CAP, rating))
            db.set_pitcher(self.conn, name, rating, starts + 1)


def _field(row, key):
    """Key lookup that works on both sqlite3.Row and plain dicts."""
    try:
        return row[key]
    except (KeyError, IndexError):
        return None
