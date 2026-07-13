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

Nothing to install — standard-library Python 3.9+ only, so the app runs
under any `python3` (including the bare system one cron uses).

```bash
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

Schedule it for 9:30 AM Pacific every day. On a laptop that sleeps, use
the sleep-proof form — cron silently skips jobs that fire while the
machine is asleep, so instead cron pings `bet.py daily` every 20 minutes
and the app itself runs exactly once per day, at the first moment at or
after 9:30 that the laptop is awake:

```cron
CRON_TZ=America/Los_Angeles
*/20 * * * *  cd ~/John-Roh-Personal/sports-betting && python3 bet.py daily >> run.log 2>&1
```

The guarded pings cost nothing (no API calls, ~50ms) and exit silently.
A machine that is always on at 9:30 can use `30 9 * * *` with `bet.py
run` instead; both forms are safe to mix with manual `run`s — a manual
morning run counts as that day's run. The schedule time is configurable
via `SPORTSBOOK_RUN_AFTER` (default `09:30`) in `.env`.

macOS note: if cron can't read the repo folder, either grant `cron`
Full Disk Access (System Settings → Privacy & Security) or keep the
clone outside `~/Documents`/`~/Desktop`/`~/Downloads` (a plain `~/`
clone works without any changes).

The slate is **today only**: games starting after the run on the same
local calendar day. Games already underway are never bet, and tomorrow's
games wait for tomorrow's run (when their lines are sharper anyway). A
9:30 AM run is ahead of NFL Sunday's 10:00 AM PT window and standard MLB
day games, so the full day is bettable; the rare earlier start (e.g. a
9:00 AM PT tournament tip) is analyzed for learning only, never bet.

## All commands

| Command | What it does |
|---|---|
| `python3 bet.py run` | The full daily cycle, right now: settle pending bets, learn from every analyzed game, fetch FanDuel lines, analyze today's slates, place the 10-bet card, write `reports/YYYY-MM-DD.md`. |
| `python3 bet.py daily` | Same as `run`, but gated: executes only once per day and only at/after 9:30 AM local (`SPORTSBOOK_RUN_AFTER`). This is what cron calls every 20 minutes — a guarded ping costs no API calls and exits silently. |
| `python3 bet.py bootstrap [sport ...]` | One-time: backfill the previous full season plus the current season from ESPN and replay it through the models to seed ratings. All four sports by default, or e.g. `bootstrap mlb nba`. Already-bootstrapped sports are skipped. |
| `python3 bet.py status` | Bankroll, W-L-P record / staked / profit / ROI per sport, and every pending bet. |
| `python3 bet.py history [N]` | The last N settled bets (default 25), oldest first, with result, profit, and running P/L. |
| `python3 bet.py analysis [DATE]` | How the model saw every game on a day's slate (default: the most recent run): FanDuel's spread/total/moneyline, the model's fair line and raw unblended line, home win probability, the situational features behind the number (rest, back-to-backs, starting pitchers and their learned gap), the best side/total edge found, the bet placed if any, and the final score once known. DATE is `YYYY-MM-DD`. |
| `python3 bet.py weights` | The learned parameters as they evolve: home advantage, rest/back-to-back/pitcher weights, totals bias, park offsets, calibration (a, b), and the model-vs-market trust trackers. |

## Behavior notes

- **10 bets daily, by mandate.** The card is the top 10 candidates by
  confidence. On thin days (one sport in season) confidence — and
  therefore stakes — will be small; that's the system working, not a bug.
  If fewer than 10 games exist, it bets what's there.
- **Out-of-season sports** simply contribute no games; today (June 30)
  only MLB has a slate, and the other three wake up automatically when
  their seasons start.
- **Pushes and voids** return the stake — a void counts like a push. A
  game ESPN marks postponed or canceled (rainout) voids its bets on the
  next run; a game with no result after 3 days voids as a backstop
  (mere rain *delays* aren't voided — those games usually finish, so
  the bets ride until a final arrives).
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
