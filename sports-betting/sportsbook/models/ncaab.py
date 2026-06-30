"""NCAA Men's Basketball model.

Lineage: KenPom/Torvik adjusted-efficiency thinking, compressed into the
shared rating architecture (our points-based ratings ARE an efficiency
margin once pace is folded into the scoring EWMAs). Key constants
(rationale in MODEL.md):

  - margin noise sigma ~10.6 — smaller in raw points than the NFL, but
    college spreads are far wider, and 3-point vol makes tails fat; the
    market-blend layer keeps us humble on teams we've barely seen;
  - K=0.10 (time constant ~10 games of a ~31-game season);
  - home court prior 3.2 points — the largest of the four sports, and the
    neutral_site flag (tournaments, March Madness) zeroes it out;
  - hardest season-over-season regression (keep 0.55): the transfer-portal
    and NIL era turns rosters over so fast that last year's rating says
    less than it used to.
"""

from .base import SportModel


class NCAABModel(SportModel):
    SPORT = "NCAAB"

    SIGMA_MARGIN = 10.4
    SIGMA_TOTAL = 16.5

    K_RATING = 0.10
    MOV_CAP = 28.0
    SEASON_REGRESS = 0.55
    LEAGUE_TOTAL = 145.0
    EWMA_ALPHA = 0.08

    WEIGHT_PRIORS = {
        "home_adv": 3.2,     # points; zeroed on neutral courts
        "total_bias": 0.0,
    }
