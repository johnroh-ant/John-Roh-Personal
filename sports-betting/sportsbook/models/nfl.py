"""NFL model.

Lineage: FiveThirtyEight NFL Elo + modern power-rating practice.
Constants and rationale are documented in MODEL.md; the load-bearing ones:

  - margins vs true spreads are ~N(0, 13.45) — the widest noise of the four
    sports relative to typical spreads, so edges convert to win probability
    slowly and confidence stays appropriately humble;
  - margins pile up on the field-goal/touchdown key numbers, so spreads
    are priced off the discrete distribution (MARGIN_MULT below), not the
    raw curve — that mass is exactly where NFL spread value lives;
  - ratings move fast (K=0.20, time constant ~5 games) because the season
    is only 17 games and roster/QB changes swamp slow priors;
  - home advantage prior 1.4 points — it has fallen from the historical 2.5-3
    over the last decade and the learner tracks it from there;
  - rest matters, but less than the market thinks: the post-2011-CBA bye
    edge is ~+0.3 points, well below the ~1.0 books still price.
"""

from .base import SportModel


class NFLModel(SportModel):
    SPORT = "NFL"

    SIGMA_MARGIN = 13.45
    SIGMA_TOTAL = 13.4

    # How much more (or less) often NFL margins land on each absolute
    # number than a normal curve says, post-2015 XP rules: 3 lands ~14.5%
    # of games, 7 ~8.7%, 6 ~8.1%, while 1- and 2-point finishes are rarer
    # than the curve implies and 0 (a tie) is nearly extinct under modern
    # overtime.
    MARGIN_MULT = {
        0: 0.15, 1: 0.75, 2: 0.70, 3: 2.60, 4: 1.05, 5: 0.95,
        6: 1.40, 7: 1.60, 8: 1.00, 9: 0.80, 10: 1.10, 14: 1.20,
    }

    K_RATING = 0.20
    MOV_CAP = 24.0          # 3+ score blowouts carry no extra information
    SEASON_REGRESS = 0.67   # keep 2/3 across seasons (538's fraction)
    LEAGUE_TOTAL = 44.5
    EWMA_ALPHA = 0.12

    WEIGHT_PRIORS = {
        "home_adv": 1.4,        # points
        "rest_diff": 0.4,       # points per week of rest difference
        "total_bias": 0.0,
    }

    def feature_vector(self, game, context):
        feats = super().feature_vector(game, context)
        home_rest = context.get("home_rest_days")
        away_rest = context.get("away_rest_days")
        if home_rest is not None and away_rest is not None:
            diff_weeks = (min(home_rest, 14) - min(away_rest, 14)) / 7.0
            feats["rest_diff"] = max(-1.5, min(1.5, diff_weeks))
        else:
            feats["rest_diff"] = 0.0
        return feats
