"""Betting math: odds conversion, no-vig probabilities, cover probabilities,
expected value, and the edge -> confidence mapping.

All probabilities are 0..1. American odds are ints (-110, +145, ...).
"""

import datetime as dt
import math
from statistics import NormalDist

_STD_NORMAL = NormalDist()


def parse_ts(s):
    """ISO-8601 timestamp with a Z suffix (both data feeds) -> aware dt."""
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


# --- odds conversion --------------------------------------------------------

def american_to_decimal(odds):
    """Decimal odds (total return per $1 staked, stake included)."""
    if odds > 0:
        return 1.0 + odds / 100.0
    return 1.0 + 100.0 / abs(odds)


def american_to_prob(odds):
    """Implied probability including the book's margin."""
    if odds > 0:
        return 100.0 / (odds + 100.0)
    return abs(odds) / (abs(odds) + 100.0)


def no_vig_probs(odds_a, odds_b):
    """Strip the vig from a two-way market (multiplicative method).

    Returns fair (p_a, p_b) summing to 1. This is what FanDuel 'really
    thinks' the probabilities are, and is the market prior our models
    blend against.
    """
    pa, pb = american_to_prob(odds_a), american_to_prob(odds_b)
    overround = pa + pb
    return pa / overround, pb / overround


def expected_value(p_win, odds, p_push=0.0):
    """EV per $1 staked for a bet that wins with prob p_win at given odds.

    Pushes return the stake (EV contribution 0); the loss probability is
    whatever remains.
    """
    win_return = american_to_decimal(odds) - 1.0
    p_lose = max(0.0, 1.0 - p_win - p_push)
    return p_win * win_return - p_lose


# --- margin distribution ----------------------------------------------------
# Game margins are well approximated as normal around the true (model) margin
# with a sport-specific standard deviation. Cover probability for a spread
# bet falls straight out of the normal CDF.

def normal_cdf(x, mu=0.0, sigma=1.0):
    return _STD_NORMAL.cdf((x - mu) / sigma)


def cover_prob(pred_margin, spread, sigma):
    """P(home covers) when home margin ~ N(pred_margin, sigma).

    `spread` is the home spread (home -3.5 means spread=-3.5; home must win
    by more than 3.5). Home covers when margin + spread > 0.
    """
    return 1.0 - normal_cdf(-spread, mu=pred_margin, sigma=sigma)


def push_prob(pred_margin, spread, sigma):
    """Approximate P(margin lands exactly on an integer spread).

    Integer margins get the probability mass of the +/-0.5 window around
    them under the normal approximation. Half-point spreads can't push.
    """
    if spread != int(spread):
        return 0.0
    lo = normal_cdf(-spread - 0.5, mu=pred_margin, sigma=sigma)
    hi = normal_cdf(-spread + 0.5, mu=pred_margin, sigma=sigma)
    return hi - lo


def win_prob_from_margin(pred_margin, sigma):
    """P(home wins) from the predicted margin (ties broken in OT -> ~50/50,
    captured adequately by the continuous approximation)."""
    return cover_prob(pred_margin, 0.0, sigma)


def margin_from_win_prob(p_home, sigma):
    """Invert win_prob_from_margin: the margin implied by a win probability.

    Used to turn the market's no-vig moneyline into the market's implied
    margin, which the model blends against.
    """
    p = min(max(p_home, 1e-6), 1 - 1e-6)
    return _STD_NORMAL.inv_cdf(p) * sigma


# --- discrete margin distributions (NFL key numbers) -------------------------
# NFL margins pile up on the field-goal/touchdown structure of scoring:
# ~14.5% of games land exactly on 3 and ~8.7% on 7, where a normal curve
# puts ~3% on each. A spread bet's value near 3 or 7 is mostly ABOUT that
# mass, so the NFL model prices spreads off a discretized normal with the
# empirical key-number multipliers (nfelo-style) instead of the raw curve.

def discrete_margin_pmf(mu, sigma, multipliers, span=70):
    """P(margin = m) for integer m in [-span, span]: normal mass per
    integer, reweighted at key numbers, renormalized.

    Multiplier keys may be signed (exact margin, checked first) or
    absolute. Signed keys express asymmetries like baseball's walk-off
    truncation, where the HOME team winning by exactly 1 is far more
    common than the road team doing so.
    """
    pmf = {}
    for m in range(-span, span + 1):
        p = normal_cdf(m + 0.5, mu, sigma) - normal_cdf(m - 0.5, mu, sigma)
        pmf[m] = p * multipliers.get(m, multipliers.get(abs(m), 1.0))
    z = sum(pmf.values())
    return {m: p / z for m, p in pmf.items()}


def discrete_cover_prob(pmf, spread):
    """(P(cover), P(push)) for a home spread bet under a discrete margin
    pmf. Home covers when margin + spread > 0."""
    win = sum(p for m, p in pmf.items() if m + spread > 0)
    push = sum(p for m, p in pmf.items() if m + spread == 0)
    return win, push


# --- confidence ---------------------------------------------------------------

def confidence_from_edge(ev_per_dollar):
    """Map a bet's EV per dollar to a 1-100 confidence score.

    Scale: 1 point of confidence per 0.1% of EV, so a +5% EV bet scores 50
    and a +9.5% EV bet scores 95. Real edges over the market rarely exceed
    ~10%, so the scale uses the full 1-100 range without pretending to
    certainty. Stake equals confidence in fake dollars, which makes total
    risk roughly proportional to total edge (a flat-fraction Kelly analog).
    """
    return max(1, min(100, round(ev_per_dollar * 1000)))


def calibrated_prob(p_raw, cal_a, cal_b):
    """Platt-style recalibration of a raw model probability.

    p_cal = sigmoid(a * logit(p_raw) + b). With a=1, b=0 this is the
    identity. The learning loop fits (a, b) per sport from settled
    predictions: a < 1 shrinks overconfident models toward 50%, b absorbs
    directional bias.
    """
    p = min(max(p_raw, 1e-6), 1 - 1e-6)
    z = math.log(p / (1.0 - p))
    return 1.0 / (1.0 + math.exp(-(cal_a * z + cal_b)))
