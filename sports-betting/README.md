# Personal Sports Betting Model

A private, fake-money betting model for **NFL, MLB, NBA, and NCAA men's
basketball**. Once a day it:

1. **Settles** — pulls final scores for every pending game, grades
   yesterday's bets (win/loss/push/void), updates the bankroll, and runs
   the learning loop over *every* matchup it analyzed (not just the ones
   it bet).
2. **Analyzes** — fetches FanDuel's current spread, total, and moneyline
   for every game on today's slate across all four sports, and prices
   each game with its own model: a fair spread, fair total, and home win
   probability.
3. **Bets** — converts each edge into a 1–100 confidence score, takes the
   **10 highest-confidence bets**, and stakes **confidence = dollars**
   (confidence 95 → $95). Sides and over/unders only; when the moneyline
   pays better than taking the points for the same side, it bets the
   moneyline instead.
4. **Reports** — writes `reports/YYYY-MM-DD.md` showing every game
   analyzed (FanDuel's line next to the model's line), the day's card,
   yesterday's results, and the running record/ROI by sport.

Everything the model believes — power ratings, scoring rates, pitcher
ratings, learned weights, calibration — lives in a local SQLite database
and updates from results every day. **See [MODEL.md](MODEL.md) for the full
explanation of the models: which stats and weights each sport uses, where
the constants come from, and how the machine-learning loop adjusts them.**

## Privacy

This is a personal project. Nothing is deployed and nothing leaves your
machine: lines come in from The Odds API and scores from ESPN's public
scoreboard JSON; bets, results, and the learned model state are stored in
`data/betting.db` (gitignored). Keep the repo private and it's visible
only to you.

## Setup

```bash
pip install requests                          # the only dependency
echo 'ODDS_API_KEY=yourkey' > .env            # free key from https://the-odds-api.com
```

The `.env` file is gitignored and loaded automatically, so the key never
goes in your shell profile, crontab, or git history. (A real
`ODDS_API_KEY` environment variable takes precedence if you set one.)

The free Odds API tier (500 credits/month) is enough: one daily run costs
~12 credits for lines (3 markets × 4 sports) plus a few for score
fallbacks.

### One-time: seed the models with historical data

```bash
python3 bet.py bootstrap          # all four sports; NCAAB takes a while
python3 bet.py bootstrap mlb      # or one sport at a time
```

This backfills the previous full season plus the current season to date
from ESPN's scoreboards and replays every game chronologically through
the rating systems, so opening ratings, scoring rates, league
environments, park effects, and pitcher ratings reflect a year-plus of
real results before the first bet.

### Daily

```bash
python3 bet.py run
```

Schedule it for noon Pacific every day:

```cron
CRON_TZ=America/Los_Angeles
0 12 * * *  cd ~/John-Roh-Personal/sports-betting && python3 bet.py run >> run.log 2>&1
```

(If your machine's clock is already on Pacific time, the `CRON_TZ` line
is optional.) The app never bets a game that has already started: the
slate is strictly games starting after the run, so at a noon run
anything that threw its first pitch or kicked off in the morning is
analyzed-for-learning only the next day, never bet. Note this means
early starts — NFL Sunday's 10:00 AM PT window, weekday MLB day games —
fall outside a noon card; run earlier (e.g. `0 8 * * *`) if you want
those slates included.

### Anytime

```bash
python3 bet.py status    # bankroll, record by sport, pending bets
python3 bet.py weights   # current learned model parameters
```

## Behavior notes

- **10 bets daily, by mandate.** The card is the top 10 candidates by
  confidence. On thin days (one sport in season) confidence — and
  therefore stakes — will be small; that's the system working, not a bug.
  If fewer than 10 games exist, it bets what's there.
- **Out-of-season sports** simply contribute no games; today (June 30)
  only MLB has a slate, and the other three wake up automatically when
  their seasons start.
- **Pushes and voids** return the stake. A game with no final score after
  3 days (postponement) voids the bet.
- **Re-runs are idempotent** — running twice in a day won't double-bet.
- The starting bankroll is $10,000 fake dollars (`SPORTSBOOK_BANKROLL`
  to change).

## Tests

```bash
python3 -m unittest discover -s tests
```

Covers the betting math, model behavior (ratings, learning, calibration,
park/pitcher effects, key-number distributions), settlement grading, and
an offline two-day end-to-end cycle with the data feeds stubbed.
