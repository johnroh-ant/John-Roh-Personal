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


# labels for the situational features, phrased for a reader
_FEATURE_LABELS = {
    "home_adv": "home field",
    "pitcher_gap": "starter edge",
    "rest_diff": "rest edge",
    "home_b2b": "back-to-back",
    "away_b2b": "opponent on a back-to-back",
}


def bet_reasoning(conn, b):
    """Plain-language 'why' lines for a bet row (which must carry run_date,
    game_id, sport, market, selection, line, price, win_prob, edge, and the
    game's home/away teams). Reconstructed from the stored prediction: the
    model-vs-market line gap, the price math, and the drivers behind the
    number. Returns [] when the pre-game analysis isn't stored."""
    import json as _json

    from . import mathutils
    from .models import MODELS

    p = conn.execute(
        "SELECT * FROM predictions WHERE game_id=? AND run_date=?",
        (b["game_id"], b["run_date"])).fetchone()
    if p is None:
        return []
    feats = _json.loads(p["features"])
    x, ctx, raw = (feats.get("x", {}), feats.get("ctx", {}),
                   feats.get("raw", {}))
    model = MODELS[b["sport"]](conn)
    unit = "runs" if b["sport"] == "MLB" else "pts"
    breakeven = mathutils.american_to_prob(b["price"])
    team = b["selection"]
    sel_home = team == b["home_team"]

    if b["market"] == "total":
        raw_t, fair_t = raw.get("total"), p["pred_total"]
        head = (f"model total {fair_t:.1f}"
                + (f" (raw {raw_t:.1f})" if raw_t is not None else "")
                + f" vs line {b['line']:g} → {team} hits "
                f"{b['win_prob']:.0%} vs {breakeven:.0%} needed at "
                f"{b['price']:+d} → {b['edge']:+.1%}/$ edge")
        drivers = []
        park = (model.w.get(f"park:{b['home_team']}", 0.0)
                if b["sport"] == "MLB" else 0.0)
        if raw_t is not None:
            base = raw_t - park - model.w.get("total_bias", 0.0)
            drivers.append(f"teams' scoring rates project {base:.1f}")
        if abs(park) >= 0.2:
            drivers.append(f"home-park effect {park:+.1f} {unit}")
        drivers.append(f"model carries {model.alpha_total:.0%} weight "
                       f"vs the market's total")
        return [head, "why: " + " · ".join(drivers)]

    # sides: spread or moneyline, phrased from the selection's perspective
    fair_m = p["pred_home_margin"] if sel_home else -p["pred_home_margin"]
    raw_m = raw.get("margin")
    if raw_m is not None and not sel_home:
        raw_m = -raw_m
    fair_txt = (f"fair line {team} {-fair_m:+.1f}"
                + (f" (model alone {-raw_m:+.1f})"
                   if raw_m is not None else ""))
    if b["market"] == "moneyline":
        head = (f"model gives {team} {b['win_prob']:.0%} to win vs "
                f"{breakeven:.0%} implied at {b['price']:+d} → "
                f"{b['edge']:+.1%}/$ edge; {fair_txt}")
    else:
        head = (f"{team} {b['line']:+g} covers {b['win_prob']:.0%} vs "
                f"{breakeven:.0%} needed at {b['price']:+d} → "
                f"{b['edge']:+.1%}/$ edge; {fair_txt}")

    drivers = []
    situational = 0.0
    for k, v in x.items():
        wv = model.w.get(k, 0.0) * v
        situational += wv
        shown = wv if sel_home else -wv
        if abs(shown) < 0.05:
            continue
        label = _FEATURE_LABELS.get(k, k)
        if k == "pitcher_gap" and (ctx.get("home_pitcher")
                                   or ctx.get("away_pitcher")):
            label += (f" ({ctx.get('home_pitcher') or '?'} vs "
                      f"{ctx.get('away_pitcher') or '?'})")
        drivers.append(f"{label} {shown:+.1f} {unit}")
    if raw_m is not None:
        quality = raw_m - (situational if sel_home else -situational)
        drivers.insert(0, f"team quality {quality:+.1f} {unit}")
    drivers.append(f"model carries {model.alpha_margin:.0%} weight "
                   f"vs the market's line")
    return [head, "why: " + " · ".join(drivers)]
