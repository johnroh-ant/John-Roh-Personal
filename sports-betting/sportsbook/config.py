"""Configuration for the sports betting model app.

Everything is overridable via environment variables so the app can run
unattended from cron without editing code.
"""

import os
from pathlib import Path

# --- Paths -----------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent


def _load_env_file():
    """Load KEY=VALUE lines from a gitignored .env in the project root, so
    the API key survives shell sessions and stays out of crontabs and git.
    Real environment variables always win. Only the app's own keys are
    accepted — a .env must not be able to set process-wide variables like
    HTTP_PROXY or SSL_CERT_FILE that the HTTP stack honors."""
    env_path = ROOT / ".env"
    if not env_path.exists():
        return
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        key = key.strip()
        if key == "ODDS_API_KEY" or key.startswith("SPORTSBOOK_"):
            # a non-empty real environment variable wins; an EMPTY one
            # (stray `export ODDS_API_KEY=`) must not shadow the file
            if not os.environ.get(key):
                os.environ[key] = value.strip().strip("'\"")


_load_env_file()
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

# `bet.py daily` does real work only at/after this local time (HH:MM), and
# only once per day — so cron can fire it every few minutes and a sleeping
# laptop just catches up on wake.
RUN_AFTER = os.environ.get("SPORTSBOOK_RUN_AFTER", "09:30")
