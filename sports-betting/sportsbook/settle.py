"""Settlement: pull final scores, grade pending bets, and feed every
settled matchup back into the learning loop.

Runs at the start of every daily run, before new bets are placed. Scores
come from ESPN's scoreboard (free) with The Odds API's scores endpoint as
a fallback for games ESPN couldn't be matched to.

Grading rules:
  spread     selection's score + line vs opponent: more = win, equal = push
  total      over/under vs the line, exactly on it = push
  moneyline  selection won = win; a tie (possible in NFL) refunds the stake
  void       stake refunded (a push, in effect): games ESPN marks
             postponed/canceled void immediately; games with no result
             within VOID_AFTER_DAYS void as a backstop; and markets
             FanDuel voids on shortened finals (a model's
             FULL_GAME_PERIODS declares what a full game is — in MLB a
             rain-shortened final keeps the moneyline, voids the run line,
             and keeps totals only when already unequivocally over)
"""

import datetime as dt
import json

from . import config, db, espn, mathutils, odds
from .models import MODELS

VOID_AFTER_DAYS = 3   # pending this long with no score -> assume dead, refund
LIKELY_OVER_HOURS = 4 # only look for scores once a game should be finished

# ESPN statuses meaning the game will NOT produce a result today: bets are
# refunded immediately (FanDuel voids postponed/canceled games). Mere
# delays and suspensions are NOT here — those games usually still finish,
# so their bets ride until a final arrives or the stale rule refunds them.
ABANDONED_STATUSES = {"STATUS_POSTPONED", "STATUS_CANCELED",
                      "STATUS_CANCELLED", "STATUS_FORFEIT"}


def settle(conn, now=None, verbose=print):
    now = now or dt.datetime.now(dt.timezone.utc)
    results = {"settled_bets": [], "learned_games": 0, "voided": 0}
    # don't chase scores for long-abandoned games (postponements already
    # voided) — an unbounded query would re-fetch them forever
    floor = (now - dt.timedelta(days=VOID_AFTER_DAYS + 2)).isoformat()

    for sport in config.SPORTS:
        pending = conn.execute(
            """SELECT * FROM games WHERE sport=? AND completed=0
               AND commence_time > ?
               AND julianday(?) - julianday(commence_time) > ?
               ORDER BY commence_time""",
            (sport, floor, now.isoformat(),
             LIKELY_OVER_HOURS / 24.0)).fetchall()
        if not pending:
            continue

        _fill_scores_from_espn(conn, sport, pending, now, results, verbose)
        _fill_scores_from_odds_api(conn, sport, floor, verbose)

    _grade_bets(conn, now, results)
    _void_stale(conn, now, results)
    results["learned_games"] = learn_from_results(conn)
    return results


def _fill_scores_from_espn(conn, sport, pending, now, results, verbose):
    # ESPN scoreboards are keyed by US calendar date; an evening US game has
    # a NEXT-day UTC commence date, so fetch both candidate dates per game.
    dates = set()
    for g in pending:
        day = dt.date.fromisoformat(g["commence_time"][:10])
        dates.add(day.strftime("%Y%m%d"))
        dates.add((day - dt.timedelta(days=1)).strftime("%Y%m%d"))
    rows = []
    for d in sorted(dates):
        try:
            rows.extend(espn.fetch_scoreboard(sport, d))
        except Exception as e:  # network or schema hiccup: fallback covers it
            verbose(f"  espn scoreboard {sport} {d} failed: {e}")
    finals = [r for r in rows if r["completed"]
              and r["home_score"] is not None
              and r["away_score"] is not None]
    abandoned = [r for r in rows if r.get("status") in ABANDONED_STATUSES]

    for g in pending:
        best = _best_match(g, finals)
        if best:
            db.record_result(conn, g["id"], best["home_score"],
                             best["away_score"], best.get("periods"))
            conn.execute(
                """UPDATE games SET
                       espn_id = COALESCE(espn_id, ?),
                       home_pitcher = COALESCE(home_pitcher, ?),
                       away_pitcher = COALESCE(away_pitcher, ?)
                   WHERE id=?""",
                (best["espn_id"], best.get("home_pitcher"),
                 best.get("away_pitcher"), g["id"]))
            continue
        # no final — but if ESPN says the game was postponed or canceled,
        # refund its bets NOW instead of waiting out the 3-day stale rule
        if _best_match(g, abandoned):
            n = _void_pending_bets(conn, g["id"], now)
            if n:
                results["voided"] += n
                verbose(f"  {g['away_team']} @ {g['home_team']} "
                        f"postponed/canceled -> voided {n} bet(s), "
                        f"stake refunded")


def _best_match(g, rows):
    """The scoreboard row for a pending game: exact espn_id if known,
    otherwise team match with the closest start time (disambiguates MLB
    doubleheaders)."""
    start = mathutils.parse_ts(g["commence_time"])
    best, best_gap = None, dt.timedelta(hours=6)
    for row in rows:
        if g["espn_id"] and row["espn_id"] == g["espn_id"]:
            return row
        if not (espn.team_match(row["home_team"], g["home_team"]) and
                espn.team_match(row["away_team"], g["away_team"])):
            continue
        try:
            row_start = mathutils.parse_ts(row["commence_time"])
        except (TypeError, ValueError):
            continue
        gap = abs(row_start - start)
        if gap < best_gap:
            best, best_gap = row, gap
    return best


def _void_pending_bets(conn, game_id, now):
    """Void (refund) every pending bet on a game. Returns how many."""
    cur = conn.execute(
        """UPDATE bets SET status='void', profit=0, settled_at=?
           WHERE game_id=? AND status='pending'""",
        (now.isoformat(), game_id))
    return cur.rowcount


def _fill_scores_from_odds_api(conn, sport, floor, verbose):
    if MODELS[sport].FULL_GAME_PERIODS is not None:
        # The Odds API reports no inning count, so a rain-shortened final
        # settled here would dodge the void rules. MLB settles via ESPN
        # only; a never-matched game voids conservatively after 3 days —
        # the same outcome FanDuel's "unequivocally determined" rule gives.
        return
    still = conn.execute(
        """SELECT * FROM games WHERE sport=? AND completed=0
           AND commence_time > ? AND odds_id IS NOT NULL""",
        (sport, floor)).fetchall()
    if not still:
        return
    try:
        scores = odds.fetch_scores(sport, days_from=3)
    except Exception as e:
        verbose(f"  odds-api scores {sport} failed: {e}")
        return
    for g in still:
        hit = scores.get(g["odds_id"])
        if hit and hit[2]:  # completed
            db.record_result(conn, g["id"], hit[0], hit[1])


def _grade_bets(conn, now, results):
    rows = conn.execute(
        """SELECT b.*, g.home_team, g.away_team, g.home_score, g.away_score,
                  g.periods
           FROM bets b JOIN games g ON g.id = b.game_id
           WHERE b.status='pending' AND g.completed=1""").fetchall()
    for b in rows:
        margin = b["home_score"] - b["away_score"]
        total = b["home_score"] + b["away_score"]
        sel_is_home = b["selection"] == b["home_team"]
        full = MODELS[b["sport"]].FULL_GAME_PERIODS
        shortened = (full is not None and b["periods"] is not None
                     and b["periods"] < full)

        if b["market"] == "spread":
            if shortened:
                status = "void"
            else:
                adj = (margin if sel_is_home else -margin) + b["line"]
                status = "won" if adj > 0 else ("push" if adj == 0 else "lost")
        elif b["market"] == "total":
            if shortened and total <= b["line"]:
                status = "void"  # could still have gone over in a full game
            else:
                val = total - b["line"]
                won_side = val > 0 if b["selection"] == "Over" else val < 0
                status = "push" if val == 0 else ("won" if won_side else "lost")
        else:  # moneyline
            if margin == 0:
                status = "push"
            else:
                won = margin > 0 if sel_is_home else margin < 0
                status = "won" if won else "lost"

        if status == "won":
            profit = b["stake"] * (mathutils.american_to_decimal(b["price"]) - 1)
        elif status == "lost":
            profit = -b["stake"]
        else:
            profit = 0.0
        conn.execute(
            "UPDATE bets SET status=?, profit=?, settled_at=? WHERE id=?",
            (status, round(profit, 2), now.isoformat(), b["id"]))
        results["settled_bets"].append(dict(b) | {"status": status,
                                                  "profit": round(profit, 2)})


def _void_stale(conn, now, results):
    cutoff = (now - dt.timedelta(days=VOID_AFTER_DAYS)).isoformat()
    stale = conn.execute(
        """SELECT b.id FROM bets b JOIN games g ON g.id = b.game_id
           WHERE b.status='pending' AND g.completed=0
           AND g.commence_time < ?""", (cutoff,)).fetchall()
    for row in stale:
        conn.execute(
            "UPDATE bets SET status='void', profit=0, settled_at=? WHERE id=?",
            (now.isoformat(), row["id"]))
    results["voided"] += len(stale)


def learn_from_results(conn):
    """Run the learning loop over every completed-but-unrated game, in
    chronological order, using the most recent pre-game prediction if one
    exists (we analyze every matchup on a slate, so in-season there nearly
    always is one). Also the bootstrap's replay engine."""
    games = conn.execute(
        """SELECT * FROM games WHERE completed=1 AND rated=0
           ORDER BY commence_time""").fetchall()
    models = {}
    n = 0
    for g in games:
        sport = g["sport"]
        model = models.get(sport)
        if model is None:
            model = models[sport] = MODELS[sport](conn)
        pred_row = conn.execute(
            """SELECT * FROM predictions WHERE game_id=?
               ORDER BY run_date DESC LIMIT 1""", (g["id"],)).fetchone()
        prediction = None
        if pred_row is not None:
            prediction = dict(pred_row)
            prediction["features"] = json.loads(prediction["features"])
        model.learn(g, prediction)
        conn.execute("UPDATE games SET rated=1 WHERE id=?", (g["id"],))
        if prediction is not None:
            conn.execute(
                """UPDATE predictions SET learned=1, outcome_margin=?,
                   outcome_total=? WHERE id=?""",
                (g["home_score"] - g["away_score"],
                 g["home_score"] + g["away_score"], prediction["id"]))
        n += 1
    for model in models.values():
        model.save()
    return n
