# The Model: What It Uses, Why, and How It Learns

This document explains every stat, weight, and formula in the betting
model — which public models were reviewed to build it, which parts of them
were adopted, what the constants are, and how the machine-learning loop
adjusts everything from results.

## 1. Models reviewed

The design distills the published methodology of the most successful
public betting/rating systems per sport:

| Sport | Systems studied | What was taken from each |
|---|---|---|
| NFL | FiveThirtyEight NFL Elo (open-sourced), nfelo, Nate Silver's ELWAY, Ben Baldwin's EPA models (nflfastR/rbsdm), Massey-Peabody (Rufus Peabody, Unabated) | Elo update structure with margin-of-victory damping; ~25 Elo = 1 point so ratings are spreads; preseason regression of 1/3 to the mean; rest/bye adjustments; key-number margin mass (nfelo's mixture-of-normals idea); Peabody's market-blend lesson (his optimum was 45% model / 55% market) |
| NBA | FiveThirtyEight NBA Elo + RAPTOR/CARMELO, Dean Oliver's Four Factors, net-rating/efficiency models, Unabated-school market-anchored practice | K=20 Elo with home court ~100 Elo declining to ~60-70 today (≈2-2.5 pts); 28 Elo = 1 point; season carryover 0.75; back-to-back fatigue ≈ -2 to -2.5 pts; the lesson that the big residual edge is player availability, which we deliberately leave to the market blend |
| MLB | FiveThirtyEight MLB Elo (pitcher-adjusted), Pythagorean expectation (exponent 1.83) / Pythagenpat, log5, BaseRuns/wOBA team offense, park factor literature | Starting-pitcher adjustment as a first-class input; tiny K (538 used K=4 — baseball strength moves slowly); home advantage worth only ~53% (+24 Elo); 1 run of expected margin ≈ +9-10% win probability; run-margin discreteness (no ties, walk-off truncation: home wins by exactly 1 in ~32% of home wins vs ~25% for road) |
| NCAAB | KenPom (adjusted efficiency), Bart Torvik's T-Rank (open methodology), Sagarin, Massey, SBCB/COOPER Elo variants | Efficiency-margin → spread conversion (margin ≈ AdjEM diff × possessions/100 ≈ ×0.68); home court ~3.0-3.3 and falling, zeroed on neutral courts; hard season-over-season regression in the transfer-portal era; faster early-season learning; fat-tailed margins from 3-point variance |
| Cross-sport math | Pinnacle/Unabated betting-math canon, Stern (1991), Boyd's Bets key-number tables, Kelly criterion literature, nfelo's dynamic market weighting | No-vig probability (multiplicative devig); margin ~ Normal(spread, σ) with σ = 13.45 NFL / 11.7 NBA / 10.4 NCAAB / 4.3 MLB; EV and Kelly staking; ML-vs-spread equivalence tables; Platt calibration; inverse-MSE model/market blending |

## 2. Architecture

Every sport runs the same three-layer architecture with sport-specific
constants and features. Ratings are denominated **directly in points**
(runs for MLB), so a rating difference *is* a predicted margin — no
Elo-to-points conversion layer to maintain.

### Layer 1 — Power ratings (sides)

Each team carries a rating = points better (+) or worse (−) than a league-
average team on a neutral floor.

```
predicted_margin = R_home − R_away + Σ w_f · feature_f
```

After every final score:

```
error      = clamp(actual_margin, ±MOV_CAP) − clamp(predicted, ±MOV_CAP)
R_home    += K · error          R_away −= K · error
```

The MOV cap plays the role of 538's margin-of-victory damping: a 30-point
blowout teaches the model nothing a 24-point one didn't. K sets the
memory horizon (≈1/K games):

| | K | MOV cap | implied memory | why |
|---|---|---|---|---|
| NFL | 0.20 | 24 | ~5 games | 17-game season; QB changes move truth fast |
| NBA | 0.07 | 28 | ~14 games | 82 games; single-game noise is huge |
| NCAAB | 0.10 | 28 | ~10 games | ~31 games; rosters gel mid-season |
| MLB | 0.025 | 6 | ~40 games | 162 games; true talent gaps are tiny vs noise |

At the start of a new season every rating regresses toward 0 (the
average team): NFL keeps 2/3 (538's fraction), NBA 3/4, MLB 0.70, NCAAB
only 0.55 — the transfer portal/NIL era has collapsed roster continuity
(D-I returning minutes fell from ~60% pre-2021 to ~29% in 2025-26), so
last season's college rating says much less than it used to.

### Layer 2 — Scoring rates (totals)

Each team carries EWMA estimates of points scored and allowed per game.
Expected score of the home team = its offense, pushed by how far the
opponent's defense sits from league average:

```
exp_home = off_home + (def_away − league_avg/2)
exp_away = off_away + (def_home − league_avg/2)
predicted_total = exp_home + exp_away + total_bias        (learned)
```

`league_avg` itself is an EWMA over all observed games, which is how the
model tracks scoring-environment regime shifts (see §5) without manual
re-tuning. MLB adds a **learned park offset** per home venue on top
(capped ±2 runs) — team EWMAs absorb roughly half of a park's effect
(half of every sample is home games); the park term learns the home-game
residual, so Coors-style venues price correctly.

### Layer 3 — Situational features (learned weights)

Each sport defines features multiplied by weights that are **initialized
from the research and then learned** (see §6):

| Sport | Feature | Prior | Source |
|---|---|---|---|
| NFL | home_adv | **1.4 pts** | home win% only 52-53% since 2019; modern HFA estimates 1.2-1.8 (down from the historical ~2.6) |
| NFL | rest_diff (per week) | **0.4 pts** | post-2011-CBA bye edge measured ~+0.3 while the market prices ~1.0 — one of the few persistent NFL situational edges |
| NBA | home_adv | **2.4 pts** | structural decline from ~3.5 to ~2-2.5 (books price 2-3); driver is the 3-point revolution (r = −0.88 between league 3PA and home win%) |
| NBA | home_b2b / away_b2b | **∓2.2 pts** | consensus back-to-back penalty -1.5 to -2.5; the biggest schedule edge in basketball |
| NCAAB | home_adv | **3.2 pts** | market-derived HCA fell from 3.68 (2014) to ~3.0; zeroed on neutral courts (March Madness) |
| MLB | home_adv | **0.25 runs** | home win% ~.530 in 2022-25 (and falling); ≈ +24 Elo in 538 terms |
| MLB | pitcher_gap | **1.0 ×** | 538 weighted starter quality at 4.7 Elo per Game Score point; ours is denominated directly in runs so the natural multiplier is 1 |
| all | total_bias | 0.0 | absorbs league-wide drift the EWMAs haven't caught |

**MLB starting pitchers.** Each starter carries a learned
runs-prevented-per-start rating (capped ±2.5). Probable starters come
from ESPN's scoreboard — and since ESPN keeps the starters attached to
completed games, the historical bootstrap seeds hundreds of pitcher
ratings before the first bet. After each game the starter's rating moves
toward `0.6 × (league_runs_per_team − runs_allowed_by_his_team)` — 60%
of the team's run prevention is credited to the starter (roughly his
innings share), with the league rate tracked by the drifting scoring
EWMA. It's deliberately crude (box-score-free) but converges on the
right ordering: aces accumulate positive ratings, replacement arms
negative, and the `pitcher_gap` feature feeds the margin directly in
runs.

### Margin distributions: from a line to a probability

A model spread only becomes a bet when converted to probabilities.
Following Stern (1991) and universal practice, final margins are treated
as `Normal(predicted_margin, σ)` with σ from the research: **13.45 NFL,
11.7 NBA, 10.4 NCAAB** (empirical sd of margin vs closing spread), and
totals σ **13.4 / 18.0 / 16.5** respectively.

Two sports get a *discrete* correction because the normal lies where it
matters most:

- **NFL key numbers.** Margins land on 3 in ~14.5% of games and 7 in
  ~8.7% — several times what a smooth curve allows — while 1, 2, and 0
  (ties) are rarer than the curve says. The model discretizes the normal
  onto integers and reweights with post-2015 empirical multipliers
  (`3: ×2.6, 7: ×1.6, 6: ×1.4, …, 0: ×0.15`) before renormalizing. This
  changes spread EV exactly where NFL betting decisions live (laying or
  taking 2.5/3/3.5 and 6.5/7/7.5) and prices pushes properly.
- **MLB run margins.** No game ends tied (margin 0 has zero mass), and
  the walk-off truncation rule — the home team stops batting the moment
  it leads in the 9th or later — makes "home by exactly 1" ~1.85× and
  "road by 1" ~1.3× the normal mass. Consequence the model now prices
  correctly: home −1.5 run lines cover less often than a continuous
  model believes.

MLB win probability sums the discrete positive-margin mass; the others
use the normal CDF. ~1 run of MLB margin ≈ +9.5% win probability, which
matches the Tango/538 rule of thumb.

## 3. The market blend: pricing against FanDuel

The single most consistent finding from professional modelers (Peabody:
45% model / 55% market optimal; nfelo: ~65/35 with *dynamic* weighting by
trailing accuracy) is that **the closing market is the best single
predictor**, and a model earns weight only by demonstrated accuracy.

The app does exactly that, with the nfelo-style dynamic version:

```
fair_margin = α · model_margin + (1−α) · market_margin
α = (1/MSE_model) / (1/MSE_model + 1/MSE_market)
```

where the MSEs are running sums of squared prediction errors vs actual
margins (and separately for totals), seeded with 60 pseudo-games at
α = 0.30 so the model starts humble and earns trust with evidence, and
clipped to [0.15, 0.70] so neither side is ever silenced by an early
lucky streak. The market margin comes from FanDuel's spread — except in
MLB, where the run line is a fixed ±1.5 carrying no margin information,
so the market margin is read from the **devigged moneyline** inverted
through the margin distribution. The **raw model line and the blended
fair line are both shown** in the daily report; betting decisions use
the blended one.

This layer is also the deliberate answer to lineup news, injuries, and
load management: rather than parse news feeds, the model lets the market
carry that information and only disagrees where its own signals
(ratings, rest, pitchers, parks, key numbers) say the *price* is off.

## 4. From probability to bet: EV, confidence, and the card

For each game the model prices every playable contract and keeps the
best **side** and best **total**:

- **Sides — spread vs moneyline.** Cover probability comes from the
  margin distribution vs FanDuel's spread (with push mass at integer
  lines); win probability likewise vs the moneyline, with NFL ties priced
  as moneyline pushes (a two-way ML refunds on a tie) rather than
  half-wins. EV per $1:
  `EV = p_win·(decimal−1) − p_lose` (pushes return the stake). The model
  bets **whichever of the spread or moneyline has higher EV for the side
  it likes** — per the math research, +EV moneylines cluster on small
  underdogs, while big-favorite MLs are usually worse than laying points
  (favorite-longshot bias). Both EVs are computed from the same blended
  margin, so the comparison is apples-to-apples. In MLB the moneyline is
  preferred unless the run line beats it by ≥1% EV, because the ±1.5
  tails are where the discrete margin model carries the most risk.
- **Totals.** Over/under probabilities from the totals distribution vs
  FanDuel's number, same EV machinery.

**Confidence (1-100) = round(1000 × EV)**, clamped. So +5.0% EV → 50,
+9.5% → 95. Real edges over a major book rarely exceed ~10%, so the scale
uses the full range without pretending to certainty. Stake = confidence
in fake dollars, which makes risk proportional to edge — on the $10,000
starting bankroll this is ≈ **1/10th Kelly** flat-fractional staking
(Kelly fraction at −110 is ≈ 1.1×EV of bankroll; conf dollars = 0.1×EV
×bankroll), comfortably inside the 1/4-to-1/2-Kelly band pros use, which
is appropriate given model-probability error compounds in Kelly sizing.

**The card** = top 10 candidates by confidence (EV breaks ties) across
all sports, max one side + one total per game. The 10-bets-per-day
mandate is unconditional, so on thin days low-confidence bets get placed
— at correspondingly tiny stakes, which is the staking rule doing its
job.

**Settlement follows FanDuel's house rules:** pushes refund the stake;
games with no result within 3 days (postponements) void; and in a
rain-shortened MLB final (under 9 innings) the moneyline stands, the run
line voids, and totals stand only when already unequivocally over the
line. NFL ties push two-way moneylines.

## 5. Historical data, trends, and rule changes

`bet.py bootstrap` backfills the **previous full season plus the current
season to date** from ESPN scoreboards (all of D-I for college) and
replays every game chronologically through layers 1-2. So before the
first bet, ratings/scoring rates/league environments/park offsets/pitcher
ratings reflect a year-plus of real results.

The backfill window is also a deliberate **rule-era filter** — the
research catalogued where older data actively misleads:

- **MLB:** the 2023 package (pitch clock, shift ban, bigger bases) was
  the largest structural break in decades — league BABIP +7 pts, LHB
  BABIP +10, SB success 75→80%, run environment 8.6→9.2→8.8→8.9 R/G
  (2022→2025). Pre-2023 data is intentionally excluded. The ghost-runner
  era makes extra innings near coin-flips, compressing 1-run margins —
  folded into the discrete margin multipliers. From 2026, the ABS
  challenge system shrinks umpire/framing effects — a reason the model
  carries *no* umpire factor at all. The annually drifting run
  environment is tracked by the league_total EWMA.
- **NFL:** scoring swung 24.8 → 21.8 → ~23.0 ppg/team across 2020-2025
  (two-high shells down, dynamic kickoff up: points/drive 1.77→2.01 in
  2024, touchback to the 35 in 2025 pushed return rate to 74.5%) — the
  totals intercept follows via the EWMA rather than a stale constant.
  Key-number frequencies shifted after the 2015 XP move (6 became 8.1%,
  10 fell to 4.7%) — the multiplier table uses post-2015 values. The
  17-game season (2021) and the 2025 OT rule are noted but don't change
  per-game pricing materially.
- **NBA:** scoring regimes whipsawed — 110.6 (2021-22, foul-hunting
  crackdown) → 114.7 (2022-23, transition-take-foul rule) → a *mid-season
  enforcement break* in Jan 2024 (unders cashed 64.7% that January) →
  2024-25 dip → 2025-26 boom (~117.7 ppg, fastest pace in 30 years). The
  fast-adapting league EWMA + learned total_bias is the designed defense
  against exactly these regime shifts. The 2023 Player Participation
  Policy reduced surprise star rests, shrinking what news-parsing would
  buy and supporting the market-blend approach to availability.
- **NCAAB:** the 30-second clock (2015-16, ~+5 ppg, market totals +7.6)
  and FIBA 3-point line (2019-20) mean the bootstrap stays inside the
  current era; the portal/NIL continuity collapse (returning minutes
  ~60% → ~29%) justifies the aggressive 0.55 season regression and is
  why November college ratings carry the widest uncertainty — which the
  humble market blend absorbs.

## 6. The machine-learning loop

Every run, **every analyzed matchup** — bet or not — is stored with its
feature vector, model numbers, and FanDuel's numbers. When its result
arrives, four kinds of parameters update (per sport):

1. **Ratings / scoring rates / pitchers / parks** (layers 1-2) — the Elo
   analog. The 538 insight that Elo *is* SGD on a Bradley-Terry model is
   the unifying view: everything below is the same gradient-step idea.
2. **Feature weights** — one SGD step per game on the margin error:
   `w_f += 0.01 · (actual − predicted) · x_f`, with L2 anchoring
   (`−0.002·(w_f − prior)`) pulling weights back toward their researched
   priors so a cold streak can't drag, say, home advantage to an absurd
   value on 30 games. With ~1,200 games a season feeding each basketball
   model, the data — not the prior — dominates within a season.
3. **Market-blend α** — the running model-vs-market MSE trackers (§3)
   update each game; the model's say in the final number grows exactly as
   fast as its demonstrated accuracy does.
4. **Probability calibration** — Platt scaling learned online:
   `p_cal = σ(a·logit(p_raw) + b)`, one logistic-regression SGD step per
   settled game on the home-win outcome (lr 0.02, a∈[0.2,3], b∈[−1,1]).
   If the model is systematically overconfident, `a` falls below 1 and
   every stated probability — and therefore every confidence score and
   stake — shrinks toward 50% until honesty is restored. Brier/log-loss
   thinking, applied continuously.

Every prediction stores the **raw** model numbers (unblended margin and
total, uncalibrated win probability) alongside the published blended,
calibrated ones, and the learner trains exclusively on the raw values.
This separation is load-bearing: grading the blend would let the market's
accuracy inflate the model's earned trust, and training the calibrator on
its own calibrated output would make it chase a moving target instead of
converging.

Because predictions are stored for *all* matchups, the learner trains on
~10× more games than it bets — the spec's "record and learn from all the
matchups, not just the ones you recommend" is structural, not optional.

## 7. Known limitations (deliberate scope cuts)

- **No injury/lineup feeds.** The market blend carries availability
  information instead. This costs the model the single biggest sharp
  edge in basketball (star-out repricing) but avoids a news-parsing
  pipeline that breaks silently.
- **No weather for NFL/MLB totals** (wind is worth real points at
  Wrigley/outdoor stadiums) and **no umpire factors** (correctly worth
  less from 2026 under ABS anyway).
- **Totals are additive**, not tempo-multiplicative: without
  play-by-play possession counts, extreme-pace matchups (mostly NCAAB)
  are slightly mispriced; the market blend bounds the damage.
- **Team-level HCA** (one number per sport), not venue-level — Denver
  altitude, Hawaii travel, etc. are partially absorbed by ratings.
- **No closing-line-value tracking** — lines are fetched once daily, so
  bets are graded on results rather than CLV (the cleaner skill signal).
- MLB pitcher ratings are inferred from team runs allowed (no box-score
  parsing), so a starter wears some of his bullpen's performance. And
  FanDuel MLB bets are "action" — they stand even if the probable
  starter is scratched after the bet, exactly like the real book.

Each of these is a place where the model knowingly trades sharpness for
robustness in a zero-dependency daily pipeline; all are upgradable
without changing the architecture.
