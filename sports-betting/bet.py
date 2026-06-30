#!/usr/bin/env python3
"""Command-line entry point.

  python bet.py bootstrap        one-time: backfill last season + this season
                                 of results to seed ratings (per sport)
  python bet.py run              the daily run: settle yesterday, analyze
                                 today's slates, place the 10-bet card,
                                 write the report
  python bet.py status           bankroll, record by sport, pending bets
  python bet.py weights          current learned model parameters

Daily usage is a single cron line (9:30 AM Pacific):
  CRON_TZ=America/Los_Angeles
  30 9 * * *  cd ~/John-Roh-Personal/sports-betting && python3 bet.py run
"""

import sys

from sportsbook import bootstrap as bootstrap_mod
from sportsbook import config, db, pipeline, report
from sportsbook.odds import OddsAPIError


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
        print(f"bankroll  ${s['bankroll']:,.2f}  "
              f"(net {s['profit']:+,.2f}, ${s['pending_stake']:,.0f} pending)")
        for r in s["by_sport"]:
            print(f"  {r['sport']:6} {r['record']}  "
                  f"staked ${r['staked']:,.0f}  "
                  f"profit {r['profit']:+,.2f}  roi {r['roi']:+.1f}%")
        pending = conn.execute(
            """SELECT b.*, g.home_team, g.away_team, g.commence_time
               FROM bets b JOIN games g ON g.id=b.game_id
               WHERE b.status='pending' ORDER BY g.commence_time""").fetchall()
        if pending:
            print("\npending bets:")
            for b in pending:
                print(f"  {b['run_date']} {b['sport']:6} "
                      f"{report.bet_desc(b)} ({b['price']:+d}) "
                      f"conf {b['confidence']} ${b['stake']:.0f} "
                      f"[{b['away_team']} @ {b['home_team']}]")


def cmd_weights():
    with db.session() as conn:
        for sport in config.SPORTS:
            rows = conn.execute(
                "SELECT name, value FROM weights WHERE sport=? ORDER BY name",
                (sport,)).fetchall()
            if not rows:
                continue
            print(sport)
            for r in rows:
                print(f"  {r['name']:20} {r['value']:.4f}")


COMMANDS = {
    "run": pipeline.run_daily,
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
