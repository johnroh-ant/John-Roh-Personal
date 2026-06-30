"""Daily report: a markdown file per run date under reports/.

Shows, per the spec: every matchup analyzed with FanDuel's line next to
the model's fair line, the day's 10-bet card with confidence-sized stakes,
yesterday's graded bets, and the running bankroll / record by sport.
"""

from . import config


def fmt_spread(x):
    if x is None:
        return "—"
    return f"{x:+g}"


def fmt_price(p):
    return f"{p:+d}" if p is not None else "—"


def bankroll_summary(conn):
    settled = conn.execute(
        """SELECT sport,
                  COUNT(*) AS bets,
                  SUM(status='won') AS wins,
                  SUM(status='lost') AS losses,
                  SUM(status='push') + SUM(status='void') AS pushes,
                  COALESCE(SUM(profit), 0) AS profit,
                  COALESCE(SUM(stake), 0) AS staked
           FROM bets WHERE status != 'pending'
           GROUP BY sport ORDER BY sport""").fetchall()
    pending = conn.execute(
        "SELECT COALESCE(SUM(stake),0) AS s FROM bets WHERE status='pending'"
    ).fetchone()["s"]
    by_sport = []
    for r in settled:
        d = dict(r)
        d["roi"] = d["profit"] / d["staked"] * 100 if d["staked"] else 0.0
        d["record"] = (f"{d['wins'] or 0}-{d['losses'] or 0}-"
                       f"{d['pushes'] or 0}")
        by_sport.append(d)
    total_profit = sum(r["profit"] for r in by_sport)
    return {
        "by_sport": by_sport,
        "pending_stake": pending,
        "profit": total_profit,
        "bankroll": config.STARTING_BANKROLL + total_profit,
    }


def write_report(conn, run_date, analyses, card, settled_bets):
    summary = bankroll_summary(conn)
    lines = [f"# Betting report — {run_date}", ""]

    # --- bankroll ---------------------------------------------------------
    lines += [
        f"**Bankroll: ${summary['bankroll']:,.2f}**  "
        f"(started ${config.STARTING_BANKROLL:,.0f}, "
        f"net {summary['profit']:+,.2f}, "
        f"${summary['pending_stake']:,.0f} riding on pending bets)", "",
    ]
    if summary["by_sport"]:
        lines += ["| Sport | Record (W-L-P) | Staked | Profit | ROI |",
                  "|---|---|---|---|---|"]
        for r in summary["by_sport"]:
            lines.append(
                f"| {r['sport']} | {r['record']} | ${r['staked']:,.0f} "
                f"| {r['profit']:+,.2f} | {r['roi']:+.1f}% |")
        lines.append("")

    # --- yesterday's results -----------------------------------------------
    lines += ["## Settled since last run", ""]
    if settled_bets:
        lines += ["| Sport | Bet | Stake | Result | Profit |",
                  "|---|---|---|---|---|"]
        for b in settled_bets:
            desc = bet_desc(b)
            lines.append(
                f"| {b['sport']} | {desc} | ${b['stake']:.0f} "
                f"| **{b['status'].upper()}** | {b['profit']:+,.2f} |")
    else:
        lines.append("_No bets settled._")
    lines.append("")

    # --- today's card -----------------------------------------------------
    lines += [f"## Today's card ({len(card)} bets)", ""]
    if card:
        lines += ["| # | Sport | Bet | FanDuel | Our line | Win prob | EV | "
                  "Conf | Stake |",
                  "|---|---|---|---|---|---|---|---|---|"]
        for i, b in enumerate(card, 1):
            desc = bet_desc(b)
            if b["market"] == "moneyline":
                fd = fmt_price(b["price"])
            elif b["market"] == "total":
                fd = f"{b['line']:g} {fmt_price(b['price'])}"
            else:
                fd = f"{fmt_spread(b['line'])} {fmt_price(b['price'])}"
            ours = (f"{b['model_line']:+g}" if b["market"] != "total"
                    else f"{b['model_line']:g}")
            lines.append(
                f"| {i} | {b['sport']} | {desc} | {fd} | {ours} "
                f"| {b['win_prob']:.1%} | {b['edge']:+.1%} "
                f"| {b['confidence']} | ${b['stake']:.0f} |")
    else:
        lines.append("_No games on today's slate (or card already placed "
                     "by an earlier run today)._")
    lines.append("")

    # --- full slate analysis ----------------------------------------------
    lines += ["## Every matchup analyzed", "",
              "FanDuel's number vs where the model makes the game. "
              "'Fair' columns blend the model with the market by earned "
              "trust; 'raw' is the model alone. Every row feeds the "
              "learning loop tonight, bet or not.", ""]
    by_sport = {}
    for a in analyses:
        by_sport.setdefault(a["sport"], []).append(a)
    for sport, rows in by_sport.items():
        lines += [f"### {sport}", "",
                  "| Matchup | FD spread | Fair spread | Raw spread "
                  "| FD total | Fair total | FD ML (H/A) | Home win % |",
                  "|---|---|---|---|---|---|---|---|"]
        for a in rows:
            g, ln = a["game"], a["line"]
            matchup = f"{g['away_team']} @ {g['home_team']}"
            if g.get("neutral_site"):
                matchup += " (N)"
            lines.append(
                f"| {matchup} | {fmt_spread(ln['home_spread'])} "
                f"| {fmt_spread(round(-a['blended_margin'], 1))} "
                f"| {fmt_spread(round(-a['model_margin'], 1))} "
                f"| {ln['total'] if ln['total'] is not None else '—'} "
                f"| {a['blended_total']:.1f} "
                f"| {fmt_price(ln['home_ml'])} / {fmt_price(ln['away_ml'])} "
                f"| {a['home_wp']:.1%} |")
        lines.append("")

    config.REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    path = config.REPORTS_DIR / f"{run_date}.md"
    path.write_text("\n".join(lines))
    return path


def bet_desc(b):
    if b["market"] == "total":
        return f"{b['selection']} {b['line']:g}"
    if b["market"] == "moneyline":
        return f"{b['selection']} ML"
    return f"{b['selection']} {fmt_spread(b['line'])}"
