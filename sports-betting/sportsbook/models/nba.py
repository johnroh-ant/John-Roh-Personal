"""NBA model.

Lineage: FiveThirtyEight NBA Elo / net-rating power ratings + the
schedule-fatigue adjustments every sharp NBA bettor prices in.
Key constants (full rationale in MODEL.md):

  - margin noise sigma ~11.7; totals noise much wider (~18) because pace
    and shooting variance compound;
  - K=0.07 (time constant ~14 games of an 82-game season) — slow enough to
    resist single-game noise, fast enough to catch real form changes;
  - home advantage prior 2.4 points (down from the historic ~3.5);
  - back-to-backs are the big situational edge: prior -2.2 points for the
    tired team, learned from there. Load management/star availability is
    deliberately NOT modeled from news — the market-blend layer absorbs
    what the line already knows about lineups.
"""

from .base import SportModel


class NBAModel(SportModel):
    SPORT = "NBA"

    SIGMA_MARGIN = 11.7
    SIGMA_TOTAL = 18.0

    K_RATING = 0.07
    MOV_CAP = 28.0
    SEASON_REGRESS = 0.75
    LEAGUE_TOTAL = 233.0   # 2025-26 scoring boom (~117.7 ppg/team); the
                           # league_total EWMA keeps tracking the regime
    EWMA_ALPHA = 0.06

    WEIGHT_PRIORS = {
        "home_adv": 2.4,     # points
        "home_b2b": -2.2,    # home team on a back-to-back
        "away_b2b": 2.2,     # away team on a back-to-back (helps home)
        "total_bias": 0.0,
    }

    def feature_vector(self, game, context):
        feats = super().feature_vector(game, context)
        feats["home_b2b"] = 1.0 if context.get("home_rest_days") == 0 else 0.0
        feats["away_b2b"] = 1.0 if context.get("away_rest_days") == 0 else 0.0
        return feats
