"""One-time historical backfill so the models don't start cold.

Pulls every final score from ESPN's scoreboards for the previous full
season and the current season to date, per sport, inserts them as
completed games, and replays them chronologically through each model's
learning loop (ratings + scoring rates; the SGD/calibration layers only
engage once real pre-game predictions exist).

This is how "look at historical data" enters the system: the opening
power ratings, scoring rates, league scoring environments, and pitcher
ratings are all estimated from the actual results of the last ~year-plus
of games before the first bet is ever placed.

Roughly 30-60s per in-season month of backfill (ESPN is rate-limited
politely). NCAAB pulls all of Division I (groups=50), so a full season is
~5,000 games — expect the college backfill to take the longest.
"""

import datetime as dt
import time

from . import config, db, espn, settle

# month windows (start_month, end_month-exclusive) each sport plays in,
# crossing the new year where needed
SEASON_WINDOWS = {
    "NFL": (9, 3),     # Sep .. Feb (Super Bowl)
    "NBA": (10, 7),    # Oct .. Jun (Finals)
    "MLB": (3, 12),    # late Mar .. early Nov
    "NCAAB": (11, 5),  # Nov .. early Apr
}


def season_dates(sport, today):
    """Daily YYYYMMDD strings covering last season + current season to date."""
    start_m, end_m = SEASON_WINDOWS[sport]
    # find the start of the PREVIOUS season
    this_season_start_year = today.year if today.month >= start_m else today.year - 1
    prev_start = dt.date(this_season_start_year - 1, start_m, 1)
    d, out = prev_start, []
    while d <= today:
        in_window = (d.month >= start_m or d.month < end_m) if start_m > end_m \
            else (start_m <= d.month < end_m)
        if in_window:
            out.append(d.strftime("%Y%m%d"))
        d += dt.timedelta(days=1)
    return out


def bootstrap(sports=None, verbose=print):
    today = dt.date.today()
    with db.session() as conn:
        for sport in (sports or config.SPORTS):
            if db.get_meta(conn, f"bootstrapped:{sport}"):
                verbose(f"{sport}: already bootstrapped, skipping "
                        f"(delete meta key 'bootstrapped:{sport}' to redo)")
                continue
            dates = season_dates(sport, today)
            verbose(f"{sport}: backfilling {len(dates)} days of scoreboards...")
            inserted = 0
            for i, ymd in enumerate(dates):
                time.sleep(0.25)  # be polite to ESPN
                try:
                    rows = espn.fetch_scoreboard(sport, ymd)
                except Exception:
                    continue
                for r in rows:
                    if not r["completed"] or r["home_score"] is None \
                            or r["away_score"] is None \
                            or not r["home_team"] or not r["away_team"]:
                        continue
                    if r["season_type"] == 1:  # preseason / spring training
                        continue
                    gid = db.upsert_game(
                        conn, sport, espn_id=r["espn_id"],
                        commence_time=r["commence_time"],
                        home_team=r["home_team"], away_team=r["away_team"],
                        neutral_site=r["neutral_site"],
                        home_pitcher=r["home_pitcher"],
                        away_pitcher=r["away_pitcher"])
                    db.record_result(conn, gid, r["home_score"],
                                     r["away_score"], r["periods"])
                    inserted += 1
                if i % 30 == 0:
                    conn.commit()
                    verbose(f"  ...{ymd}: {inserted} games so far")
            verbose(f"{sport}: replaying {inserted} games through the model")
            settle.learn_from_results(conn)
            db.set_meta(conn, f"bootstrapped:{sport}", today.isoformat())
            conn.commit()
            verbose(f"{sport}: done")
