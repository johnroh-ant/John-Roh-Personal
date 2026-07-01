"""Client for ESPN's public scoreboard JSON API.

Used for two things:
  1. Settlement — final scores for completed games (free, no key).
  2. Bootstrap — backfilling a season-plus of historical results so the
     rating systems start from informed values instead of cold.

Endpoint shape:
  https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard
      ?dates=YYYYMMDD[&groups=50][&limit=500]

groups=50 (configured per sport in config.SPORTS) is required for men's
college basketball to return all of D1 instead of just the top-25 slate.
"""

import json

from . import config, http

BASE = "https://site.api.espn.com/apis/site/v2/sports"


def normalize_team(name):
    """Normalize a team name for cross-feed matching — ESPN and The Odds
    API disagree on details ('LA Clippers' vs 'Los Angeles Clippers',
    'St.' vs 'Saint')."""
    return ((name or "").lower().replace("state", "st").replace("saint", "st")
            .replace("st.", "st").replace("los angeles", "la")
            .replace(" ", ""))


def team_match(a, b):
    """Same team across feeds? Equality or containment after normalizing."""
    if not a or not b:
        return False
    na, nb = normalize_team(a), normalize_team(b)
    return na == nb or na in nb or nb in na


# Exhibition entities ESPN serves alongside real games — Pro Bowl
# conferences, All-Star weekend squads, the MLB All-Star leagues. ESPN
# labels several of these as REGULAR season games, so they must be
# filtered by name. No real club matches these patterns.
_EXHIBITION_NAMES = {"AFC", "NFC", "American League", "National League",
                     "World", "USA"}


def is_exhibition(home_team, away_team):
    return any(
        t in _EXHIBITION_NAMES or (t or "").startswith("Team ")
        or "all-star" in (t or "").lower()
        for t in (home_team, away_team))


def _score_of(competitor):
    try:
        return int(competitor.get("score"))
    except (TypeError, ValueError):
        return None


def _pitcher_of(competitor):
    for prob in competitor.get("probables") or []:
        athlete = prob.get("athlete") or {}
        if athlete.get("displayName"):
            return athlete["displayName"]
    return None


def fetch_scoreboard(sport, yyyymmdd):
    """All games for a sport on a date.

    Returns a list of dicts:
      {espn_id, season_type, commence_time, home_team, away_team,
       neutral_site, completed, periods, home_score, away_score,
       home_pitcher, away_pitcher}
    Pitcher fields are probable starters (MLB only, pre-game) — None
    elsewhere.
    """
    sp, league = config.SPORTS[sport]["espn"]
    params = {"dates": yyyymmdd, "limit": 500}
    params.update(config.SPORTS[sport].get("espn_params", {}))
    status, body = http.get(f"{BASE}/{sp}/{league}/scoreboard", params=params)
    if status != 200:
        raise RuntimeError(f"ESPN scoreboard {sport} {yyyymmdd} -> {status}")
    data = json.loads(body)

    out = []
    for event in data.get("events", []):
        comp = (event.get("competitions") or [{}])[0]
        competitors = comp.get("competitors", [])
        home = next((c for c in competitors if c.get("homeAway") == "home"), None)
        away = next((c for c in competitors if c.get("homeAway") == "away"), None)
        if not home or not away:
            continue
        status = event.get("status") or {}
        completed = bool((status.get("type") or {}).get("completed"))
        period = status.get("period")  # innings for MLB, quarters for NFL

        out.append({
            "espn_id": event["id"],
            "season_type": (event.get("season") or {}).get("type"),  # 1=pre
            "commence_time": event.get("date"),
            "home_team": (home.get("team") or {}).get("displayName"),
            "away_team": (away.get("team") or {}).get("displayName"),
            "neutral_site": bool(comp.get("neutralSite")),
            "completed": completed,
            "periods": period if completed else None,
            "home_score": _score_of(home) if completed else None,
            "away_score": _score_of(away) if completed else None,
            "home_pitcher": _pitcher_of(home),
            "away_pitcher": _pitcher_of(away),
        })
    return out
