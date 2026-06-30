"""SQLite persistence layer.

One database holds everything the app learns and records:

  games        every matchup we have ever seen (odds feed, ESPN feed, or both)
  lines        FanDuel line snapshots per game (spread / total / moneyline)
  predictions  the model's full analysis of EVERY game on a slate — not just
               the ones we bet — so the learning loop trains on all of them
  bets         the fake bets actually placed, with stake = confidence
  ratings      per-team power ratings (Elo-style), per sport
  scoring      per-team EWMA scoring rates used by the totals model
  pitchers     per-pitcher run-prevention ratings (MLB starter adjustment)
  weights      learned model parameters, per sport (feature weights,
               calibration params, market-blend alpha, ...)
  meta         bookkeeping (bankroll, last run, bootstrap markers)
"""

import json
import sqlite3
from contextlib import contextmanager

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS games (
    id            INTEGER PRIMARY KEY,
    sport         TEXT NOT NULL,
    odds_id       TEXT,                -- The Odds API event id
    espn_id       TEXT,                -- ESPN event id
    commence_time TEXT NOT NULL,       -- ISO8601 UTC
    home_team     TEXT NOT NULL,
    away_team     TEXT NOT NULL,
    neutral_site  INTEGER NOT NULL DEFAULT 0,
    completed     INTEGER NOT NULL DEFAULT 0,
    home_score    INTEGER,
    away_score    INTEGER,
    periods       INTEGER,             -- innings (MLB) / quarters at final
    home_pitcher  TEXT,                -- MLB starters (from ESPN), so the
    away_pitcher  TEXT,                -- learner can credit/blame them
    rated         INTEGER NOT NULL DEFAULT 0,  -- ratings/learning applied?
    UNIQUE (sport, odds_id),
    UNIQUE (sport, espn_id)
);

CREATE INDEX IF NOT EXISTS idx_games_sport_time ON games (sport, commence_time);
CREATE INDEX IF NOT EXISTS idx_games_sport_teams ON games (sport, home_team, away_team);

CREATE TABLE IF NOT EXISTS lines (
    id                INTEGER PRIMARY KEY,
    game_id           INTEGER NOT NULL REFERENCES games (id),
    fetched_at        TEXT NOT NULL,
    home_spread       REAL,
    home_spread_price INTEGER,
    away_spread_price INTEGER,
    total             REAL,
    over_price        INTEGER,
    under_price       INTEGER,
    home_ml           INTEGER,
    away_ml           INTEGER
);

CREATE INDEX IF NOT EXISTS idx_lines_game ON lines (game_id);

CREATE TABLE IF NOT EXISTS predictions (
    id               INTEGER PRIMARY KEY,
    game_id          INTEGER NOT NULL REFERENCES games (id),
    run_date         TEXT NOT NULL,        -- local betting day YYYY-MM-DD
    sport            TEXT NOT NULL,
    features         TEXT NOT NULL,        -- JSON: feature vector used
    pred_home_margin REAL NOT NULL,        -- model: home points - away points
    pred_total       REAL NOT NULL,
    pred_home_wp     REAL NOT NULL,        -- model home win probability
    market_home_spread REAL,
    market_total       REAL,
    market_home_ml     INTEGER,
    market_away_ml     INTEGER,
    side_edge        REAL,                 -- EV/$ of best side bet
    total_edge       REAL,                 -- EV/$ of best total bet
    outcome_margin   REAL,                 -- filled at settlement
    outcome_total    REAL,
    learned          INTEGER NOT NULL DEFAULT 0,
    UNIQUE (game_id, run_date)
);

CREATE TABLE IF NOT EXISTS bets (
    id         INTEGER PRIMARY KEY,
    run_date   TEXT NOT NULL,
    sport      TEXT NOT NULL,
    game_id    INTEGER NOT NULL REFERENCES games (id),
    market     TEXT NOT NULL,    -- 'spread' | 'total' | 'moneyline'
    selection  TEXT NOT NULL,    -- team name, or 'Over'/'Under'
    line       REAL,             -- points taken/laid; NULL for moneyline
    price      INTEGER NOT NULL, -- American odds
    model_line REAL,             -- what we think the line should be
    win_prob   REAL NOT NULL,    -- model probability the bet wins
    edge       REAL NOT NULL,    -- EV per dollar staked
    confidence INTEGER NOT NULL, -- 1-100
    stake      REAL NOT NULL,    -- == confidence, in fake dollars
    status     TEXT NOT NULL DEFAULT 'pending',  -- pending|won|lost|push|void
    profit     REAL,             -- +win amount, -stake, 0 push/void
    settled_at TEXT
);

CREATE TABLE IF NOT EXISTS ratings (
    sport   TEXT NOT NULL,
    team    TEXT NOT NULL,
    rating  REAL NOT NULL,
    games   INTEGER NOT NULL DEFAULT 0,
    season  TEXT,                -- last season this team was rated in
    PRIMARY KEY (sport, team)
);

CREATE TABLE IF NOT EXISTS scoring (
    sport    TEXT NOT NULL,
    team     TEXT NOT NULL,
    off_ewma REAL,               -- points scored per game, opponent-adjusted
    def_ewma REAL,               -- points allowed per game, opponent-adjusted
    games    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (sport, team)
);

CREATE TABLE IF NOT EXISTS pitchers (
    name   TEXT PRIMARY KEY,
    rating REAL NOT NULL,        -- runs better(-)/worse(+) than avg per start
    starts INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS weights (
    sport TEXT NOT NULL,
    name  TEXT NOT NULL,
    value REAL NOT NULL,
    PRIMARY KEY (sport, name)
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


# columns added after the initial schema: CREATE TABLE IF NOT EXISTS won't
# add them to an existing database, and the database holds accumulated
# learning state worth preserving across upgrades
MIGRATIONS = [
    ("games", "periods", "INTEGER"),
    ("games", "home_pitcher", "TEXT"),
    ("games", "away_pitcher", "TEXT"),
]


def connect():
    config.DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    for table, column, decl in MIGRATIONS:
        have = {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}
        if column not in have:
            conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {decl}")
    return conn


@contextmanager
def session():
    conn = connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


# --- games -------------------------------------------------------------------

def upsert_game(conn, sport, *, odds_id=None, espn_id=None, commence_time,
                home_team, away_team, neutral_site=False,
                home_pitcher=None, away_pitcher=None):
    """Insert or merge a game seen from either feed. Returns game id.

    Odds-feed games and ESPN-feed games are matched on (sport, teams, ~same
    start time) so that one logical game gets one row with both external
    ids. The fuzzy window is +/-2 hours: wide enough for cross-feed clock
    skew (minutes), narrow enough that the two games of an MLB doubleheader
    (3.5h+ apart) stay separate rows. Team names compare normalized, since
    the feeds spell them differently.
    """
    from . import espn  # late import: espn pulls config only, no cycle

    row = None
    if odds_id:
        row = conn.execute(
            "SELECT * FROM games WHERE sport=? AND odds_id=?",
            (sport, odds_id)).fetchone()
    if row is None and espn_id:
        row = conn.execute(
            "SELECT * FROM games WHERE sport=? AND espn_id=?",
            (sport, espn_id)).fetchone()
    if row is None:
        candidates = conn.execute(
            """SELECT * FROM games WHERE sport=?
               AND abs(julianday(commence_time) - julianday(?)) < 0.0834""",
            (sport, commence_time)).fetchall()
        for c in candidates:
            # strict normalized equality: containment-style matching would
            # false-merge distinct teams with nested names
            if espn.normalize_team(c["home_team"]) == \
                    espn.normalize_team(home_team) and \
                    espn.normalize_team(c["away_team"]) == \
                    espn.normalize_team(away_team):
                row = c
                break
    if row is None:
        cur = conn.execute(
            """INSERT INTO games (sport, odds_id, espn_id, commence_time,
                                  home_team, away_team, neutral_site,
                                  home_pitcher, away_pitcher)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (sport, odds_id, espn_id, commence_time, home_team, away_team,
             int(neutral_site), home_pitcher, away_pitcher))
        return cur.lastrowid

    conn.execute(
        """UPDATE games SET
               odds_id = COALESCE(odds_id, ?),
               espn_id = COALESCE(espn_id, ?),
               home_pitcher = COALESCE(home_pitcher, ?),
               away_pitcher = COALESCE(away_pitcher, ?)
           WHERE id=?""",
        (odds_id, espn_id, home_pitcher, away_pitcher, row["id"]))
    return row["id"]


def record_result(conn, game_id, home_score, away_score, periods=None):
    if home_score is None or away_score is None:
        # a completed game with a NULL score would poison settlement and
        # the learning replay forever — fail loudly at the write site
        raise ValueError(f"refusing to record game {game_id} as completed "
                         f"with scores {home_score}-{away_score}")
    conn.execute(
        """UPDATE games SET completed=1, home_score=?, away_score=?,
           periods=? WHERE id=?""",
        (home_score, away_score, periods, game_id))


# --- lines ---------------------------------------------------------------

def insert_line(conn, game_id, fetched_at, snap):
    conn.execute(
        """INSERT INTO lines (game_id, fetched_at, home_spread,
               home_spread_price, away_spread_price, total, over_price,
               under_price, home_ml, away_ml)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (game_id, fetched_at, snap.get("home_spread"),
         snap.get("home_spread_price"), snap.get("away_spread_price"),
         snap.get("total"), snap.get("over_price"), snap.get("under_price"),
         snap.get("home_ml"), snap.get("away_ml")))


# --- predictions -----------------------------------------------------------

def upsert_prediction(conn, p):
    conn.execute(
        """INSERT INTO predictions (game_id, run_date, sport, features,
               pred_home_margin, pred_total, pred_home_wp, market_home_spread,
               market_total, market_home_ml, market_away_ml, side_edge,
               total_edge)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (game_id, run_date) DO UPDATE SET
               features=excluded.features,
               pred_home_margin=excluded.pred_home_margin,
               pred_total=excluded.pred_total,
               pred_home_wp=excluded.pred_home_wp,
               market_home_spread=excluded.market_home_spread,
               market_total=excluded.market_total,
               market_home_ml=excluded.market_home_ml,
               market_away_ml=excluded.market_away_ml,
               side_edge=excluded.side_edge,
               total_edge=excluded.total_edge""",
        (p["game_id"], p["run_date"], p["sport"], json.dumps(p["features"]),
         p["pred_home_margin"], p["pred_total"], p["pred_home_wp"],
         p.get("market_home_spread"), p.get("market_total"),
         p.get("market_home_ml"), p.get("market_away_ml"),
         p.get("side_edge"), p.get("total_edge")))


# --- ratings / scoring / pitchers -------------------------------------------

def get_rating(conn, sport, team, default=0.0):
    row = conn.execute(
        "SELECT rating, games, season FROM ratings WHERE sport=? AND team=?",
        (sport, team)).fetchone()
    return (row["rating"], row["games"], row["season"]) if row else (default, 0, None)


def set_rating(conn, sport, team, rating, games, season=None):
    conn.execute(
        """INSERT INTO ratings (sport, team, rating, games, season)
           VALUES (?,?,?,?,?)
           ON CONFLICT (sport, team) DO UPDATE SET
               rating=excluded.rating, games=excluded.games,
               season=COALESCE(excluded.season, ratings.season)""",
        (sport, team, rating, games, season))


def get_scoring(conn, sport, team):
    row = conn.execute(
        "SELECT off_ewma, def_ewma, games FROM scoring WHERE sport=? AND team=?",
        (sport, team)).fetchone()
    return (row["off_ewma"], row["def_ewma"], row["games"]) if row else (None, None, 0)


def set_scoring(conn, sport, team, off_ewma, def_ewma, games):
    conn.execute(
        """INSERT INTO scoring (sport, team, off_ewma, def_ewma, games)
           VALUES (?,?,?,?,?)
           ON CONFLICT (sport, team) DO UPDATE SET
               off_ewma=excluded.off_ewma, def_ewma=excluded.def_ewma,
               games=excluded.games""",
        (sport, team, off_ewma, def_ewma, games))


def get_pitcher(conn, name):
    row = conn.execute(
        "SELECT rating, starts FROM pitchers WHERE name=?", (name,)).fetchone()
    return (row["rating"], row["starts"]) if row else (0.0, 0)


def set_pitcher(conn, name, rating, starts):
    conn.execute(
        """INSERT INTO pitchers (name, rating, starts) VALUES (?,?,?)
           ON CONFLICT (name) DO UPDATE SET
               rating=excluded.rating, starts=excluded.starts""",
        (name, rating, starts))


# --- weights -----------------------------------------------------------------

def get_weights(conn, sport):
    return {r["name"]: r["value"] for r in conn.execute(
        "SELECT name, value FROM weights WHERE sport=?", (sport,))}


def set_weight(conn, sport, name, value):
    conn.execute(
        """INSERT INTO weights (sport, name, value) VALUES (?,?,?)
           ON CONFLICT (sport, name) DO UPDATE SET value=excluded.value""",
        (sport, name, value))


# --- meta ----------------------------------------------------------------

def get_meta(conn, key, default=None):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(conn, key, value):
    conn.execute(
        """INSERT INTO meta (key, value) VALUES (?,?)
           ON CONFLICT (key) DO UPDATE SET value=excluded.value""",
        (key, str(value)))
