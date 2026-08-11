#!/usr/bin/env python3
"""Command-line entry point.

  python bet.py bootstrap        one-time: backfill last season + this season
                                 of results to seed ratings (per sport)
  python bet.py run              the daily run: settle yesterday, analyze
                                 today's slates, place the 10-bet card,
                                 write the report
  python bet.py daily            `run`, but only once per day and only
                                 at/after 9:30 AM local — cron fires it
                                 every 20 min, so a laptop asleep at 9:30
                                 catches up at next wake instead of
                                 skipping the day
  python bet.py status           bankroll, record by sport, pending bets
  python bet.py history [N]      last N settled bets (default 25) with
                                 results and running profit
  python bet.py analysis [DATE]  how the model saw every game on a day's
                                 slate (default: most recent run)
  python bet.py doctor           diagnose why pending bets aren't
                                 settling (connectivity + match dry-run)
  python bet.py weights          current learned model parameters

Scheduling: on a Mac run `sh setup-mac.sh` once (launchd agent that
catches up on wake); on an always-on machine a cron line works:
  */20 * * * *  cd ~/John-Roh-Personal/sports-betting && python3 bet.py daily
"""

import os
import sys
import zoneinfo

from sportsbook import bootstrap as bootstrap_mod
from sportsbook import config, db, espn, mathutils, pipeline, report
from sportsbook.odds import OddsAPIError

# --- terminal styling (auto-off when piped, NO_COLOR honored) ---------------

_COLOR = ((sys.stdout.isatty() or os.environ.get("FORCE_COLOR"))
          and not os.environ.get("NO_COLOR"))


def _c(code, s):
    return f"\033[{code}m{s}\033[0m" if _COLOR else str(s)


def bold(s):    return _c("1", s)
def dim(s):     return _c("2", s)
def green(s):   return _c("32", s)
def red(s):     return _c("31", s)
def cyan(s):    return _c("36", s)
def yellow(s):  return _c("33", s)


def money(x, fmt="+,.2f"):
    s = f"{x:{fmt}}"
    return green(s) if x > 0 else red(s) if x < 0 else dim(s)


def colored_status(status):
    s = status.upper()
    return {"WON": green(f"{s:<5}"), "LOST": red(f"{s:<5}")}.get(
        s, dim(f"{s:<5}"))


def local_start(ts):
    """'Tue 7/14 4:05 PM' in the configured timezone."""
    try:
        t = mathutils.parse_ts(ts).astimezone(
            zoneinfo.ZoneInfo(config.TIMEZONE))
    except (TypeError, ValueError):
        return ""
    return (f"{t.strftime('%a')} {t.month}/{t.day} "
            + t.strftime("%I:%M %p").lstrip("0"))


RULE = "─" * 64


# --- commands ----------------------------------------------------------------

def cmd_daily():
    if pipeline.daily_run_due():
        pipeline.run_daily()
    # silent exit otherwise: cron calls this every 20 minutes


def cmd_bootstrap():
    sports = [s.upper() for s in sys.argv[2:]] or None
    if sports:
        unknown = [s for s in sports if s not in config.SPORTS]
        if unknown:
            sys.exit(f"unknown sport(s): {', '.join(unknown)} "
                     f"(choose from {', '.join(config.SPORTS)})")
    bootstrap_mod.bootstrap(sports)


def cmd_status():
    with db.session() as conn:
        s = report.bankroll_summary(conn)
        bankroll = f"${s['bankroll']:,.2f}"
        print()
        print(f"  {bold('BANKROLL')}  {bold(bankroll)}"
              f"   net {money(s['profit'])}"
              f" {dim('·')} ${s['pending_stake']:,.0f} in play")
        if s["by_sport"]:
            print()
            print(dim(f"  {'sport':<7}{'record':>8}{'staked':>10}"
                      f"{'profit':>11}{'roi':>9}"))
            for r in s["by_sport"]:
                sport = cyan(f"{r['sport']:<7}")
                staked = f"${r['staked']:,.0f}"
                roi = f"{r['roi']:+.1f}%"
                print(f"  {sport}{r['record']:>8}"
                      f"{staked:>10} {money(r['profit'], '+10.2f')}{roi:>9}")
        pending = conn.execute(
            """SELECT b.*, g.home_team, g.away_team, g.commence_time
               FROM bets b JOIN games g ON g.id=b.game_id
               WHERE b.status='pending'
               ORDER BY b.stake DESC, g.commence_time""").fetchall()
        if pending:
            total = sum(b["stake"] for b in pending)
            print(f"\n  {bold('PENDING')} "
                  f"{dim(f'({len(pending)} bets, ${total:,.0f} at risk)')}")
            print(dim("  stake = confidence = EV per $ × 1000, capped at "
                      "100 (so conf 100 means a ≥ +10% edge)"))
            print(dim("  " + RULE))
            import datetime as _dt
            now = _dt.datetime.now(_dt.timezone.utc)
            for b in pending:
                desc = f"{report.bet_desc(b)} ({b['price']:+d})"
                meta = (f"{b['away_team']} @ {b['home_team']}"
                        f" · {local_start(b['commence_time'])}")
                try:
                    overdue = mathutils.parse_ts(b["commence_time"]) < now
                except (TypeError, ValueError):
                    overdue = False
                flag = ""
                if overdue:
                    # game started but no result recorded yet: settles on
                    # the next run, or voids 3 days after start
                    flag = "  " + yellow("⏳ awaiting result")
                print(f"  ${b['stake']:>3.0f}  {dim('conf')} "
                      f"{b['confidence']:>3}  {b['sport']:<6} "
                      f"{bold(f'{desc:<34}')} {dim(meta)}{flag}")
                for line in report.bet_reasoning(conn, b):
                    print(dim(f"        {line}"))
        print()


def cmd_history():
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 25
    with db.session() as conn:
        rows = conn.execute(
            """SELECT b.*, g.home_team, g.away_team, g.home_score,
                      g.away_score, g.completed
               FROM bets b JOIN games g ON g.id = b.game_id
               WHERE b.status != 'pending'
               ORDER BY b.settled_at DESC, b.id DESC LIMIT ?""",
            (n,)).fetchall()
        if not rows:
            print("no settled bets yet")
            return
        print()
        running = 0.0
        for b in reversed(rows):  # oldest first, running P/L reads naturally
            running += b["profit"]
            desc = f"{report.bet_desc(b)} ({b['price']:+d})"
            if b["completed"] and b["home_score"] is not None:
                matchup = (f"{b['away_team']} {b['away_score']} @ "
                           f"{b['home_team']} {b['home_score']}")
            else:
                matchup = f"{b['away_team']} @ {b['home_team']} (no result)"
            print(f"  {dim(b['run_date'])}  {b['sport']:<6}"
                  f"{bold(f'{desc:<32}')} ${b['stake']:>3.0f}  "
                  f"{colored_status(b['status'])} {money(b['profit'], '+8.2f')}"
                  f"  {dim(f'running {running:+,.2f}')}"
                  f"  {dim(matchup)}")
        print()


def cmd_analysis():
    """How the model saw every game on a day's slate: FanDuel's numbers,
    the model's blended fair line and raw unblended line, the situational
    features behind the margin, the edges found, the bet (if any), and
    the final score once it's in."""
    import json

    date = sys.argv[2] if len(sys.argv) > 2 else None
    with db.session() as conn:
        if date is None:
            row = conn.execute(
                "SELECT MAX(run_date) d FROM predictions").fetchone()
            date = row["d"]
        if not date:
            print("no analysis recorded yet — run `bet.py run` first")
            return
        preds = conn.execute(
            """SELECT p.*, g.home_team, g.away_team, g.completed,
                      g.home_score, g.away_score, g.commence_time
               FROM predictions p JOIN games g ON g.id = p.game_id
               WHERE p.run_date=? ORDER BY p.sport, g.commence_time""",
            (date,)).fetchall()
        if not preds:
            print(f"no analysis recorded for {date}")
            return
        bets = {}
        for b in conn.execute(
                "SELECT b.* FROM bets b WHERE b.run_date=?", (date,)):
            bets.setdefault(b["game_id"], []).append(b)

        print(f"\n  {bold(f'ANALYSIS — {date}')} "
              f"{dim(f'({len(preds)} games, every one feeds the learner)')}\n")
        for p in preds:
            feats = json.loads(p["features"])
            raw, x, ctx = (feats.get("raw", {}), feats.get("x", {}),
                           feats.get("ctx", {}))

            print(dim("  " + RULE))
            print(f"  {cyan(bold(p['sport']))}  "
                  f"{bold(p['away_team'] + ' @ ' + p['home_team'])}"
                  f"  {dim(local_start(p['commence_time']))}")
            print(dim("  " + RULE))

            head = f"  {'':<11}{'spread':>9}{'total':>9}   {'ml / win%':<12}"
            print(dim(head))
            ml = (f"{p['market_home_ml']:+d}/{p['market_away_ml']:+d}"
                  if p["market_home_ml"] is not None else "—")
            spread = (f"{p['market_home_spread']:+g}"
                      if p["market_home_spread"] is not None else "—")
            total = (f"{p['market_total']:g}"
                     if p["market_total"] is not None else "—")
            print(f"  {'FanDuel':<11}{spread:>9}{total:>9}   {ml:<12}")
            print(f"  {'fair':<11}{-p['pred_home_margin']:>+9.1f}"
                  f"{p['pred_total']:>9.1f}   {p['pred_home_wp']:.1%}")
            if raw.get("margin") is not None:
                print(dim(f"  {'model raw':<11}{-raw['margin']:>+9.1f}"
                          f"{raw['total']:>9.1f}"))

            edges = []
            if p["side_edge"] is not None:
                e = p["side_edge"]
                edges.append("side " + (green if e > 0 else red)(f"{e:+.1%}"))
            if p["total_edge"] is not None:
                e = p["total_edge"]
                edges.append("total " + (green if e > 0 else red)(f"{e:+.1%}"))
            if edges:
                print(f"  {'edges':<11}" + "   ".join(edges))

            inputs = " · ".join(f"{k} {v:+.2f}"
                                for k, v in sorted(x.items()) if v)
            if inputs:
                print(dim(f"  {'inputs':<11}{inputs}"))
            if ctx.get("home_pitcher") or ctx.get("away_pitcher"):
                print(dim(f"  {'starters':<11}{ctx.get('home_pitcher') or '?'}"
                          f" vs {ctx.get('away_pitcher') or '?'}"))

            for b in bets.get(p["game_id"], []):
                line = (f"{report.bet_desc(b)} ({b['price']:+d}) "
                        f"· conf {b['confidence']} · ${b['stake']:.0f}")
                if b["status"] != "pending":
                    line += f"  → {b['status'].upper()} "
                    print(f"  {yellow(bold('★ BET'.ljust(11)))}"
                          f"{yellow(line)}{money(b['profit'])}")
                else:
                    print(f"  {yellow(bold('★ BET'.ljust(11)))}{yellow(line)}")

            if p["completed"]:
                print(f"  {'final':<11}{p['away_team']} {p['away_score']}, "
                      f"{p['home_team']} {p['home_score']}")
            print()


def cmd_doctor():
    """Diagnose why pending bets aren't settling, from THIS machine:
    Python/SSL info, live probes of both data sources, then a dry-run of
    the real settlement match for every started-but-unsettled bet."""
    import datetime as _dt
    import platform
    import ssl
    import urllib.request

    from sportsbook import settle as settle_mod
    from sportsbook.odds import OddsAPIError

    print(f"\n  python  {platform.python_version()}  ({sys.executable})")
    print(f"  ssl     {ssl.OPENSSL_VERSION}")

    # --- ESPN probe: raw urllib, full error detail (no secrets in URL) ---
    espn_ok = False
    url = ("https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/"
           "scoreboard?limit=5")
    try:
        with urllib.request.urlopen(url, timeout=20) as r:
            print(f"  ESPN    {green('OK')} (HTTP {r.status})")
            espn_ok = True
    except Exception as e:
        print(f"  ESPN    {red('FAILED')}: {e!r}")
        print(dim("          settlement needs ESPN; this is why bets are "
                  "stuck. If the error mentions CERTIFICATE_VERIFY_FAILED,"
                  " run macOS's 'Install Certificates.command' for your "
                  "Python, or use /usr/bin/python3."))

    # --- ESPN through the app's own client (its UA/pathway) --------------
    yday = (_dt.datetime.now(_dt.timezone.utc)
            - _dt.timedelta(days=1)).strftime("%Y%m%d")
    try:
        n = len(espn.fetch_scoreboard("MLB", yday))
        print(f"  ESPN(app) {green('OK')} ({n} events on {yday})")
    except Exception as e:
        print(f"  ESPN(app) {red('FAILED')}: {e}")
        if espn_ok:
            print(dim("          raw fetch works but the app's client is "
                      "blocked — ESPN's CDN is rejecting the app's "
                      "user-agent from this network; send me this output"))

    # --- Odds API probe (sanitized errors; free endpoint) ----------------
    try:
        from sportsbook import odds as odds_mod
        odds_mod._get("/sports")
        print(f"  OddsAPI {green('OK')}")
    except OddsAPIError as e:
        print(f"  OddsAPI {red('FAILED')}: {e}")

    # --- per-bet settlement dry run --------------------------------------
    now = _dt.datetime.now(_dt.timezone.utc)
    with db.session() as conn:
        stuck = conn.execute(
            """SELECT b.id, b.selection, b.market, g.*
               FROM bets b JOIN games g ON g.id = b.game_id
               WHERE b.status='pending' AND g.completed=0
               ORDER BY g.commence_time""").fetchall()
        started = [g for g in stuck
                   if mathutils.parse_ts(g["commence_time"]) < now]
        if not started:
            print(f"\n  no started-but-unsettled bets — nothing stuck\n")
            return
        print(f"\n  {len(started)} stuck bet(s); replaying the settlement "
              f"match for each:")
        boards = {}
        for g in started:
            day = _dt.date.fromisoformat(g["commence_time"][:10])
            finals, abandoned, errs = [], [], []
            for d in (day, day - _dt.timedelta(days=1)):
                ymd = d.strftime("%Y%m%d")
                if ymd not in boards:
                    try:
                        boards[ymd] = espn.fetch_scoreboard(g["sport"], ymd)
                    except Exception as e:
                        boards[ymd] = e
                board = boards[ymd]
                if isinstance(board, Exception):
                    errs.append(f"{ymd}: {board}")
                    continue
                finals += [r for r in board if r["completed"]
                           and r["home_score"] is not None]
                abandoned += [r for r in board
                              if r.get("status") in
                              settle_mod.ABANDONED_STATUSES]
            label = f"{g['away_team']} @ {g['home_team']} ({g['commence_time'][:10]})"
            if errs:
                print(f"  {red('✗')} {label}: board fetch failed — {'; '.join(errs)}")
                continue
            hit = settle_mod._best_match(g, finals)
            if hit:
                print(f"  {green('✓')} {label}: would settle "
                      f"{hit['away_score']}-{hit['home_score']} on next run")
            elif settle_mod._best_match(g, abandoned):
                print(f"  {yellow('◌')} {label}: postponed/canceled — "
                      f"voids on next run")
            else:
                print(f"  {red('✗')} {label}: no matching final among "
                      f"{len(finals)} fetched — name/time mismatch; "
                      f"send this line to debug")
        print(dim("\n  if every line is ✓, just run `bets run` — "
                  "settlement will catch up.\n"))

def cmd_weights():
    with db.session() as conn:
        for sport in config.SPORTS:
            rows = conn.execute(
                "SELECT name, value FROM weights WHERE sport=? ORDER BY name",
                (sport,)).fetchall()
            if not rows:
                continue
            print(bold(sport))
            for r in rows:
                print(f"  {r['name']:20} {r['value']:.4f}")


COMMANDS = {
    "run": pipeline.run_daily,
    "daily": cmd_daily,
    "history": cmd_history,
    "analysis": cmd_analysis,
    "doctor": cmd_doctor,
    "bootstrap": cmd_bootstrap,
    "status": cmd_status,
    "weights": cmd_weights,
}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "run"
    if cmd not in COMMANDS:
        sys.exit(__doc__)
    try:
        COMMANDS[cmd]()
    except OddsAPIError as e:
        sys.exit(f"error: {e}")
    except BrokenPipeError:
        pass  # e.g. `bet.py weights | head`
