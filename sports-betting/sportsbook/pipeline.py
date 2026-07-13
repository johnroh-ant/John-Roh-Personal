"""The daily run.

    1. SETTLE   pull final scores for everything pending, grade yesterday's
                bets, and run the learning loop over every analyzed matchup
                (bet or not).
    2. ANALYZE  fetch today's FanDuel lines for all four sports, predict
                every game on the slate, and store the full analysis.
    3. BET      rank candidates by confidence, place the top 10 as fake
                bets with stake = confidence.
    4. REPORT   write the daily report (lines vs our lines for every game,
                the card, yesterday's results, running P/L by sport).
"""

import datetime as dt
import zoneinfo

from . import betting, config, db, espn, mathutils, odds, report, settle
from .models import MODELS


def daily_run_due(now=None):
    """Has today's run not happened yet, and is it past the scheduled time?

    Drives `bet.py daily`, designed for laptops that sleep: cron fires it
    every few minutes, this gate makes exactly one real run per day at the
    first opportunity at/after RUN_AFTER local time. Costs no API calls
    when it says no.
    """
    tz = zoneinfo.ZoneInfo(config.TIMEZONE)
    now_local = (now or dt.datetime.now(dt.timezone.utc)).astimezone(tz)
    if now_local.strftime("%H:%M") < config.RUN_AFTER:
        return False
    with db.session() as conn:
        return db.get_meta(conn, "last_run_date") != now_local.date().isoformat()


def local_today(now=None):
    tz = zoneinfo.ZoneInfo(config.TIMEZONE)
    return (now or dt.datetime.now(dt.timezone.utc)).astimezone(tz).date()


def run_daily(now=None, verbose=print):
    now = now or dt.datetime.now(dt.timezone.utc)
    run_date = local_today(now).isoformat()

    with db.session() as conn:
        verbose(f"== sportsbook daily run for {run_date} ==")

        verbose("-- settling pending games and learning from results...")
        settled = settle.settle(conn, now=now, verbose=verbose)
        verbose(f"   settled {len(settled['settled_bets'])} bets, "
                f"voided {settled['voided']}, "
                f"learned from {settled['learned_games']} games")

        dropped = _drop_future_day_bets(conn)
        if dropped:
            verbose(f"   removed {dropped} pending bet(s) on games outside "
                    f"their betting day")

        verbose("-- fetching FanDuel lines and analyzing slates...")
        active = odds.fetch_active_sport_keys()  # free call; None = unknown
        analyses, candidates = [], []
        for sport in config.SPORTS:
            if active is not None and \
                    config.SPORTS[sport]["odds_key"] not in active:
                verbose(f"   {sport}: out of season")
                continue
            rows = odds.slate_filter(odds.fetch_fanduel_lines(sport), now=now)
            # exhibitions (All-Star Games, Pro Bowl) are on the board at
            # FanDuel but are not model-able competitive games — never
            # analyze or bet them
            rows = [r for r in rows
                    if not espn.is_exhibition(r["home_team"], r["away_team"])]
            if not rows:
                verbose(f"   {sport}: no games on the slate")
                continue
            context_index = _espn_context(sport, now, verbose)
            model = MODELS[sport](conn)
            for row in rows:
                analysis = _analyze_game(conn, model, row, run_date, now,
                                         context_index)
                analyses.append(analysis)
                candidates.extend(analysis["candidates"])
            model.save()
            verbose(f"   {sport}: analyzed {len(rows)} games "
                    f"(model weight vs market: "
                    f"sides {model.alpha_margin:.0%}, "
                    f"totals {model.alpha_total:.0%})")

        # Idempotency on re-runs: a game has one 'side' slot (spread or
        # moneyline) and one 'total' slot; never refill a slot already bet
        # today, and only place up to the day's remaining allowance.
        existing = conn.execute(
            "SELECT game_id, market FROM bets WHERE run_date=?",
            (run_date,)).fetchall()
        slot = lambda m: "side" if m in ("spread", "moneyline") else "total"
        taken = {(r["game_id"], slot(r["market"])) for r in existing}
        # Belt and braces on top of the slate filter: never place a bet on
        # a game that has already started.
        fresh = [c for c in candidates
                 if (c["game_id"], slot(c["market"])) not in taken
                 and mathutils.parse_ts(c["commence_time"]) > now]
        card = betting.pick_card(
            fresh, max(0, config.BETS_PER_DAY - len(existing)))
        for bet in card:
            conn.execute(
                """INSERT INTO bets (run_date, sport, game_id, market,
                       selection, line, price, model_line, win_prob, edge,
                       confidence, stake)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (run_date, bet["sport"], bet["game_id"], bet["market"],
                 bet["selection"], bet.get("line"), bet["price"],
                 bet["model_line"], round(bet["win_prob"], 4),
                 round(bet["edge"], 4), bet["confidence"], bet["stake"]))
        verbose(f"-- placed {len(card)} bets "
                f"(${sum(b['stake'] for b in card):.0f} total stake)")

        path = report.write_report(conn, run_date, analyses, card,
                                   settled["settled_bets"])
        verbose(f"-- report: {path}")
        db.set_meta(conn, "last_run_date", run_date)
        return {"run_date": run_date, "analyses": analyses, "card": card,
                "settled": settled, "report": path}


def _drop_future_day_bets(conn):
    """Enforce the bets-only-today invariant retroactively: a pending bet
    whose game starts on a LATER local calendar day than the bet's
    run_date should never have been placed — remove it, freeing that
    day's slot to be refilled from the correct slate. (Settled bets are
    history and are never touched.)"""
    tz = zoneinfo.ZoneInfo(config.TIMEZONE)
    rows = conn.execute(
        """SELECT b.id, b.run_date, g.commence_time
           FROM bets b JOIN games g ON g.id = b.game_id
           WHERE b.status='pending'""").fetchall()
    doomed = []
    for r in rows:
        game_day = mathutils.parse_ts(
            r["commence_time"]).astimezone(tz).date().isoformat()
        if game_day > r["run_date"]:
            doomed.append(r["id"])
    for bet_id in doomed:
        conn.execute("DELETE FROM bets WHERE id=?", (bet_id,))
    return len(doomed)


def _espn_context(sport, now, verbose):
    """Today's ESPN scoreboard, for probable pitchers / neutral-site flags
    and espn-id matching. Keyed by normalized 'away@home'; each key holds a
    LIST because an MLB doubleheader puts the same matchup on the board
    twice — callers pick the row closest in start time."""
    out = {}
    for offset in (0, 1):  # UTC date straddles US evenings
        ymd = (now + dt.timedelta(days=offset)).strftime("%Y%m%d")
        try:
            for row in espn.fetch_scoreboard(sport, ymd):
                key = _matchup_key(row["away_team"], row["home_team"])
                out.setdefault(key, []).append(row)
        except Exception as e:
            verbose(f"   espn context {sport} {ymd} failed: {e}")
    return out


def _matchup_key(away, home):
    return f"{espn.normalize_team(away)}@{espn.normalize_team(home)}"


def _closest_espn_row(candidates, game_start):
    """The ESPN row whose start time best matches the odds event's."""
    best, best_gap = None, dt.timedelta(hours=3)
    for row in candidates or []:
        try:
            start = mathutils.parse_ts(row["commence_time"])
        except (TypeError, ValueError):
            continue
        gap = abs(start - game_start)
        if gap < best_gap:
            best, best_gap = row, gap
    return best


def _analyze_game(conn, model, row, run_date, now, context_index):
    sport = model.SPORT
    game_start = mathutils.parse_ts(row["commence_time"])
    espn_row = _closest_espn_row(
        context_index.get(_matchup_key(row["away_team"], row["home_team"])),
        game_start)
    neutral = bool(espn_row and espn_row["neutral_site"])
    game_id = db.upsert_game(
        conn, sport, odds_id=row["odds_id"],
        espn_id=espn_row["espn_id"] if espn_row else None,
        commence_time=row["commence_time"],
        home_team=row["home_team"], away_team=row["away_team"],
        neutral_site=neutral,
        home_pitcher=espn_row["home_pitcher"] if espn_row else None,
        away_pitcher=espn_row["away_pitcher"] if espn_row else None)
    db.insert_line(conn, game_id, now.isoformat(), row)

    context = {
        "home_rest_days": _rest_days(conn, sport, row["home_team"], game_start),
        "away_rest_days": _rest_days(conn, sport, row["away_team"], game_start),
        "home_pitcher": espn_row["home_pitcher"] if espn_row else None,
        "away_pitcher": espn_row["away_pitcher"] if espn_row else None,
    }
    game = {
        "game_id": game_id,
        "home_team": row["home_team"], "away_team": row["away_team"],
        "commence_time": row["commence_time"],
        "neutral_site": neutral,
    }
    pred = model.predict(game, context)
    game["pred"] = pred

    cands = []
    side = betting.side_candidates(model, game, row)
    if side:
        cands.append(side)
    total = betting.total_candidates(model, game, row)
    if total:
        cands.append(total)

    blended_margin = side["blended_margin"] if side else pred["margin"]
    blended_total = total["blended_total"] if total else pred["total"]
    p_home_wp = model.win_prob(blended_margin)
    db.upsert_prediction(conn, {
        "game_id": game_id, "run_date": run_date, "sport": sport,
        "features": {"x": pred["features"],
                     "ctx": {"home_pitcher": context["home_pitcher"],
                             "away_pitcher": context["away_pitcher"]},
                     # raw (unblended/uncalibrated) model numbers: the
                     # learning loop must grade the model itself — the
                     # market-leaning blend would inflate its own trust,
                     # and the calibrated probability would make the Platt
                     # layer chase its own output
                     "raw": {"margin": round(pred["margin"], 3),
                             "total": round(pred["total"], 3),
                             "wp": round(model.win_prob_raw(blended_margin),
                                         4)}},
        "pred_home_margin": round(blended_margin, 3),
        "pred_total": round(blended_total, 3),
        "pred_home_wp": round(p_home_wp, 4),
        "market_home_spread": row["home_spread"],
        "market_total": row["total"],
        "market_home_ml": row["home_ml"],
        "market_away_ml": row["away_ml"],
        "side_edge": round(side["edge"], 4) if side else None,
        "total_edge": round(total["edge"], 4) if total else None,
    })

    return {"sport": sport, "game": game, "line": row,
            "candidates": cands,
            "model_margin": pred["margin"],
            "blended_margin": blended_margin,
            "blended_total": blended_total,
            "home_wp": p_home_wp}


def _rest_days(conn, sport, team, game_start):
    """Full days off between the team's last game and the upcoming one.

    Dates are taken in the local timezone — a 7pm PT game carries a
    NEXT-day UTC date, and comparing UTC dates would brand every
    one-rest-day team a back-to-back.
    """
    row = conn.execute(
        """SELECT MAX(commence_time) AS last FROM games
           WHERE sport=? AND completed=1 AND (home_team=? OR away_team=?)""",
        (sport, team, team)).fetchone()
    if not row or not row["last"]:
        return None
    tz = zoneinfo.ZoneInfo(config.TIMEZONE)
    last = mathutils.parse_ts(row["last"]).astimezone(tz).date()
    upcoming = game_start.astimezone(tz).date()
    days = (upcoming - last).days - 1
    return max(0, min(days, 30))
