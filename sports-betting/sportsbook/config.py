"""Configuration for the sports betting model app.

Everything is overridable via environment variables so the app can run
unattended from cron without editing code.
"""

import os
from pathlib import Path

# --- Paths -----------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = Path(os.environ.get("SPORTSBOOK_DATA_DIR", ROOT / "data"))
DB_PATH = Path(os.environ.get("SPORTSBOOK_DB", DATA_DIR / "betting.db"))
REPORTS_DIR = Path(os.environ.get("SPORTSBOOK_REPORTS_DIR", ROOT / "reports"))

# --- The Odds API (FanDuel lines) -------------------------------------------

ODDS_API_KEY = os.environ.get("ODDS_API_KEY", "")
ODDS_API_BASE = "https://api.the-odds-api.com/v4"
BOOKMAKER = "fanduel"

# --- Sports ------------------------------------------------------------------
# key: our internal sport code
# odds_key: The Odds API sport key
# espn: (sport, league) path segments for ESPN's public scoreboard API

SPORTS = {
    "NFL": {
        "odds_key": "americanfootball_nfl",
        "espn": ("football", "nfl"),
    },
    "NBA": {
        "odds_key": "basketball_nba",
        "espn": ("basketball", "nba"),
    },
    "MLB": {
        "odds_key": "baseball_mlb",
        "espn": ("baseball", "mlb"),
    },
    "NCAAB": {
        "odds_key": "basketball_ncaab",
        "espn": ("basketball", "mens-college-basketball"),
        "espn_params": {"groups": 50},  # all of Division I
    },
}

# --- Betting -----------------------------------------------------------------

BETS_PER_DAY = int(os.environ.get("SPORTSBOOK_BETS_PER_DAY", "10"))
STARTING_BANKROLL = float(os.environ.get("SPORTSBOOK_BANKROLL", "10000"))

# A game's slate window: bet on games starting within this many hours of the run.
SLATE_HOURS = int(os.environ.get("SPORTSBOOK_SLATE_HOURS", "24"))

# Local timezone for "the betting day" (report naming, day boundaries).
TIMEZONE = os.environ.get("SPORTSBOOK_TZ", "America/Los_Angeles")
