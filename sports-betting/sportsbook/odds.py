"""Client for The Odds API (https://the-odds-api.com) — FanDuel lines.

Free tier: 500 credits/month. One odds call costs (#markets x #regions)
credits, so a 3-market FanDuel pull is 3 credits per sport per day —
4 sports daily fits comfortably. Scores calls with daysFrom cost 2.
"""

import datetime as dt

import requests

from . import config, mathutils


class OddsAPIError(RuntimeError):
    def __init__(self, message, status=None):
        super().__init__(message)
        self.status = status


def _get(path, **params):
    if not config.ODDS_API_KEY:
        raise OddsAPIError(
            "ODDS_API_KEY is not set. Get a free key at https://the-odds-api.com "
            "and export ODDS_API_KEY=... before running.")
    params["apiKey"] = config.ODDS_API_KEY
    resp = requests.get(f"{config.ODDS_API_BASE}{path}", params=params, timeout=30)
    if resp.status_code != 200:
        raise OddsAPIError(
            f"Odds API {path} -> {resp.status_code}: {resp.text[:300]}",
            status=resp.status_code)
    return resp.json()


def _get_or(path, out_of_season_value, **params):
    """Like _get, but out-of-season sports (404/422) are a normal state,
    not a failure."""
    try:
        return _get(path, **params)
    except OddsAPIError as e:
        if e.status in (404, 422):
            return out_of_season_value
        raise


def fetch_active_sport_keys():
    """Sport keys currently in season, from the free /v4/sports endpoint
    (costs 0 credits). Lets the daily run skip out-of-season sports
    without spending odds credits on empty responses. Returns None when
    the lookup fails, meaning 'unknown — just try them all'."""
    try:
        sports = _get("/sports")
    except (OddsAPIError, requests.RequestException):
        return None
    return {s["key"] for s in sports if s.get("active")}


def fetch_fanduel_lines(sport):
    """Current FanDuel spread/total/moneyline for upcoming games of a sport.

    Returns a list of dicts:
      {odds_id, commence_time, home_team, away_team,
       home_spread, home_spread_price, away_spread_price,
       total, over_price, under_price, home_ml, away_ml}
    Games FanDuel hasn't priced yet are returned with None fields.
    """
    odds_key = config.SPORTS[sport]["odds_key"]
    # bookmakers= supersedes regions= for both filtering and credit math
    events = _get_or(f"/sports/{odds_key}/odds", [],
                     bookmakers=config.BOOKMAKER,
                     markets="h2h,spreads,totals", oddsFormat="american")
    out = []
    for ev in events:
        row = {
            "odds_id": ev["id"],
            "commence_time": ev["commence_time"],
            "home_team": ev["home_team"],
            "away_team": ev["away_team"],
            "home_spread": None, "home_spread_price": None,
            "away_spread_price": None,
            "total": None, "over_price": None, "under_price": None,
            "home_ml": None, "away_ml": None,
        }
        for book in ev.get("bookmakers", []):
            if book["key"] != config.BOOKMAKER:
                continue
            for market in book.get("markets", []):
                outcomes = market.get("outcomes", [])
                if market["key"] == "h2h":
                    for o in outcomes:
                        if o["name"] == ev["home_team"]:
                            row["home_ml"] = o["price"]
                        elif o["name"] == ev["away_team"]:
                            row["away_ml"] = o["price"]
                elif market["key"] == "spreads":
                    for o in outcomes:
                        if o["name"] == ev["home_team"]:
                            row["home_spread"] = o.get("point")
                            row["home_spread_price"] = o["price"]
                        elif o["name"] == ev["away_team"]:
                            row["away_spread_price"] = o["price"]
                elif market["key"] == "totals":
                    for o in outcomes:
                        if o["name"] == "Over":
                            row["total"] = o.get("point")
                            row["over_price"] = o["price"]
                        elif o["name"] == "Under":
                            row["under_price"] = o["price"]
        out.append(row)
    return out


def fetch_scores(sport, days_from=2):
    """Recent + live scores from The Odds API (backup to ESPN settlement).

    Returns {odds_id: (home_score, away_score, completed)}.
    """
    odds_key = config.SPORTS[sport]["odds_key"]
    events = _get_or(f"/sports/{odds_key}/scores", [], daysFrom=days_from)
    out = {}
    for ev in events:
        scores = ev.get("scores") or []
        home = away = None
        for s in scores:
            if s["name"] == ev["home_team"]:
                home = int(s["score"])
            elif s["name"] == ev["away_team"]:
                away = int(s["score"])
        if home is not None and away is not None:
            out[ev["id"]] = (home, away, bool(ev.get("completed")))
    return out


def slate_filter(rows, now=None):
    """Keep games starting between now and now + SLATE_HOURS."""
    now = now or dt.datetime.now(dt.timezone.utc)
    horizon = now + dt.timedelta(hours=config.SLATE_HOURS)
    out = []
    for r in rows:
        start = mathutils.parse_ts(r["commence_time"])
        if now <= start <= horizon:
            out.append(r)
    return out
