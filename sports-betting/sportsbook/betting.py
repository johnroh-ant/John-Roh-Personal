"""Turning model output + FanDuel lines into candidate bets and picking
the day's card.

Markets we play, per the spec: sides and over/unders only. A "side" can be
taken either against the spread or on the moneyline — for every game we
compute the EV of both and keep whichever pays better for the side our
model likes (if the moneyline is the better price, we bet the moneyline
instead of taking/laying the points).

Each game can contribute at most one side candidate and one total
candidate; the day's card is the top BETS_PER_DAY candidates by
confidence (ties broken by raw EV), and the stake is the confidence in
fake dollars.
"""

from .mathutils import confidence_from_edge, expected_value


def side_candidates(model, game, line):
    """Best side bet (spread or moneyline) for one game.

    Returns a candidate dict or None if FanDuel has no side market up.
    `line` is the current FanDuel snapshot dict for the game.
    """
    market_margin = model.market_implied_margin(line)
    model_margin = game["pred"]["margin"]
    margin = model.blended_margin(model_margin, market_margin)

    options = []
    if line["home_spread"] is not None:
        spread = line["home_spread"]
        hp = line["home_spread_price"] or -110
        ap = line["away_spread_price"] or -110
        p_push = model.push_prob(margin, spread)
        p_home = model.cover_prob(margin, spread) * (1 - p_push)
        p_away = max(0.0, 1.0 - p_home - p_push)
        options.append(dict(
            market="spread", selection=game["home_team"], line=spread,
            price=hp, win_prob=p_home,
            edge=expected_value(p_home, hp, p_push)))
        options.append(dict(
            market="spread", selection=game["away_team"], line=-spread,
            price=ap, win_prob=p_away,
            edge=expected_value(p_away, ap, p_push)))
    if line["home_ml"] is not None and line["away_ml"] is not None:
        p_home_win, p_away_win, p_tie = model.ml_probs(margin)
        options.append(dict(
            market="moneyline", selection=game["home_team"], line=None,
            price=line["home_ml"], win_prob=p_home_win,
            edge=expected_value(p_home_win, line["home_ml"], p_tie)))
        options.append(dict(
            market="moneyline", selection=game["away_team"], line=None,
            price=line["away_ml"], win_prob=p_away_win,
            edge=expected_value(p_away_win, line["away_ml"], p_tie)))
    if not options:
        return None

    # some sports (MLB) prefer the moneyline unless the spread clearly
    # beats it; the penalty affects only the choice, not the recorded EV
    penalty = model.SPREAD_SELECTION_PENALTY
    best = max(options, key=lambda o: o["edge"] -
               (penalty if o["market"] == "spread" else 0.0))
    best.update(
        game_id=game["game_id"], sport=model.SPORT,
        model_line=round(-margin, 1),     # our fair home spread
        confidence=confidence_from_edge(best["edge"]),
        blended_margin=margin, model_margin=model_margin,
        market_margin=market_margin,
    )
    return best


def total_candidates(model, game, line):
    """Best over/under bet for one game, or None without a totals market."""
    if line["total"] is None:
        return None
    market_total = line["total"]
    model_total = game["pred"]["total"]
    total = model.blended_total(model_total, market_total)

    p_push = model.total_push_prob(total, market_total)
    p_over = model.over_prob(total, market_total) * (1 - p_push)
    p_under = max(0.0, 1.0 - p_over - p_push)
    op = line["over_price"] or -110
    up = line["under_price"] or -110
    options = [
        dict(market="total", selection="Over", line=market_total, price=op,
             win_prob=p_over, edge=expected_value(p_over, op, p_push)),
        dict(market="total", selection="Under", line=market_total, price=up,
             win_prob=p_under, edge=expected_value(p_under, up, p_push)),
    ]
    best = max(options, key=lambda o: o["edge"])
    best.update(
        game_id=game["game_id"], sport=model.SPORT,
        model_line=round(total, 1),
        confidence=confidence_from_edge(best["edge"]),
        blended_total=total, model_total=model_total,
        market_total=market_total,
    )
    return best


def pick_card(candidates, n):
    """Top n candidates by confidence (EV breaks ties), one stake each."""
    ranked = sorted(candidates,
                    key=lambda c: (c["confidence"], c["edge"]), reverse=True)
    card = ranked[:n]
    for bet in card:
        bet["stake"] = float(bet["confidence"])
    return card
