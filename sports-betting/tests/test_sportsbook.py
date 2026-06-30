"""Tests: betting math units, model behavior, and an offline two-day
end-to-end run (analyze + bet on day 1, settle + learn on day 2) with the
odds and ESPN feeds stubbed out.

Run from sports-betting/:  python3 -m unittest discover -s tests -v
"""

import datetime as dt
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sportsbook import betting, config, db, mathutils  # noqa: E402

NOW = dt.datetime(2026, 6, 30, 16, 0, tzinfo=dt.timezone.utc)


class TestMath(unittest.TestCase):
    def test_american_conversions(self):
        self.assertAlmostEqual(mathutils.american_to_decimal(-110), 1.909, 3)
        self.assertAlmostEqual(mathutils.american_to_decimal(+150), 2.5)
        self.assertAlmostEqual(mathutils.american_to_prob(-110), 0.5238, 3)
        self.assertAlmostEqual(mathutils.american_to_prob(+100), 0.5)

    def test_no_vig(self):
        pa, pb = mathutils.no_vig_probs(-110, -110)
        self.assertAlmostEqual(pa, 0.5)
        pa, pb = mathutils.no_vig_probs(-200, +170)
        self.assertAlmostEqual(pa + pb, 1.0)
        self.assertGreater(pa, 0.6)

    def test_expected_value(self):
        # coin flip at even odds is fair
        self.assertAlmostEqual(mathutils.expected_value(0.5, +100), 0.0)
        # 52.38% at -110 is breakeven
        self.assertAlmostEqual(mathutils.expected_value(0.5238, -110), 0.0, 3)
        # pushes shrink the loss side
        self.assertGreater(mathutils.expected_value(0.5, -110, p_push=0.05),
                           mathutils.expected_value(0.5, -110))

    def test_cover_and_win_prob(self):
        # a 3-point favorite covers -3 half the time
        self.assertAlmostEqual(mathutils.cover_prob(3.0, -3.0, 13.45), 0.5)
        self.assertGreater(mathutils.cover_prob(7.0, -3.0, 13.45), 0.5)
        self.assertAlmostEqual(
            mathutils.win_prob_from_margin(3.0, 13.45),
            1 - mathutils.normal_cdf(0, 3.0, 13.45))

    def test_margin_win_prob_roundtrip(self):
        for margin in (-7.5, -1.0, 0.0, 2.5, 10.0):
            p = mathutils.win_prob_from_margin(margin, 11.7)
            back = mathutils.margin_from_win_prob(p, 11.7)
            self.assertAlmostEqual(back, margin, places=4)

    def test_push_prob_only_on_integers(self):
        self.assertEqual(mathutils.push_prob(2.0, -2.5, 13.45), 0.0)
        self.assertGreater(mathutils.push_prob(3.0, -3.0, 13.45), 0.02)

    def test_confidence_scale(self):
        self.assertEqual(mathutils.confidence_from_edge(0.095), 95)
        self.assertEqual(mathutils.confidence_from_edge(0.05), 50)
        self.assertEqual(mathutils.confidence_from_edge(-0.2), 1)
        self.assertEqual(mathutils.confidence_from_edge(0.5), 100)

    def test_calibration_identity(self):
        self.assertAlmostEqual(mathutils.calibrated_prob(0.62, 1.0, 0.0), 0.62)
        # a < 1 shrinks toward 0.5
        self.assertLess(mathutils.calibrated_prob(0.62, 0.5, 0.0), 0.62)

    def test_nfl_key_numbers(self):
        pmf = mathutils.discrete_margin_pmf(2.5, 13.45,
                                            {3: 2.6, 7: 1.6, 0: 0.15})
        self.assertAlmostEqual(sum(pmf.values()), 1.0, 6)
        # 3 carries far more mass than the smooth neighbors 4-ish away
        self.assertGreater(pmf[3], pmf[5] * 2)
        win, push = mathutils.discrete_cover_prob(pmf, -3.0)
        self.assertGreater(push, 0.05)
        self.assertLess(win, 0.5)


class DBTestCase(unittest.TestCase):
    """Base: fresh temp database per test."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self._patches = [
            mock.patch.object(config, "DATA_DIR", Path(self.tmp.name)),
            mock.patch.object(config, "DB_PATH",
                              Path(self.tmp.name) / "test.db"),
            mock.patch.object(config, "REPORTS_DIR",
                              Path(self.tmp.name) / "reports"),
        ]
        for p in self._patches:
            p.start()
        self.addCleanup(self.tmp.cleanup)
        for p in self._patches:
            self.addCleanup(p.stop)


class TestModels(DBTestCase):
    def test_ratings_learn_from_results(self):
        from sportsbook.models import NBAModel
        with db.session() as conn:
            model = NBAModel(conn)
            game = {"sport": "NBA", "home_team": "Denver Nuggets",
                    "away_team": "Utah Jazz",
                    "commence_time": "2026-01-15T02:00:00Z",
                    "home_score": 130, "away_score": 100, "neutral_site": 0}
            model.learn(game, None)
            r_home = db.get_rating(conn, "NBA", "Denver Nuggets", 0.0)[0]
            r_away = db.get_rating(conn, "NBA", "Utah Jazz", 0.0)[0]
            self.assertGreater(r_home, 0)
            self.assertLess(r_away, 0)
            self.assertAlmostEqual(r_home, -r_away)  # zero-sum update

    def test_season_regression(self):
        from sportsbook.models import NFLModel
        with db.session() as conn:
            db.set_rating(conn, "NFL", "Buffalo Bills", 6.0, 17, "2025")
            model = NFLModel(conn)
            when = dt.datetime(2026, 9, 10, tzinfo=dt.timezone.utc)  # new season
            r, _games, season = model.rating_of("Buffalo Bills", when)
            self.assertAlmostEqual(r, 6.0 * model.SEASON_REGRESS)
            self.assertEqual(season, "2026")
            # a stale game from the PREVIOUS season must not regress again
            old = dt.datetime(2026, 2, 1, tzinfo=dt.timezone.utc)
            r2, _g, season2 = model.rating_of("Buffalo Bills", old)
            self.assertAlmostEqual(r2, r)
            self.assertEqual(season2, "2026")  # stamp never rolls back

    def test_prediction_uses_home_advantage(self):
        from sportsbook.models import NCAABModel
        with db.session() as conn:
            model = NCAABModel(conn)
            game = {"home_team": "Duke Blue Devils",
                    "away_team": "Kansas Jayhawks",
                    "commence_time": "2026-01-15T00:00:00Z",
                    "neutral_site": False}
            pred = model.predict(game)
            self.assertAlmostEqual(pred["margin"], model.w["home_adv"])
            game["neutral_site"] = True
            self.assertAlmostEqual(model.predict(game)["margin"], 0.0)

    def test_mlb_pitcher_gap_moves_line(self):
        from sportsbook.models import MLBModel
        with db.session() as conn:
            model = MLBModel(conn)
            db.set_pitcher(conn, "Ace Starter", 1.5, 20)
            db.set_pitcher(conn, "Replacement Arm", -1.0, 20)
            game = {"home_team": "Los Angeles Dodgers",
                    "away_team": "Colorado Rockies",
                    "commence_time": "2026-06-30T20:00:00Z",
                    "neutral_site": False}
            ctx = {"home_pitcher": "Ace Starter",
                   "away_pitcher": "Replacement Arm"}
            with_ace = model.predict(game, ctx)["margin"]
            without = model.predict(game, {})["margin"]
            self.assertAlmostEqual(with_ace - without, 2.5 * model.w["pitcher_gap"])

    def test_mlb_run_line_prices_walkoff_truncation(self):
        from sportsbook.models import MLBModel
        with db.session() as conn:
            model = MLBModel(conn)
            # neutral game: home -1.5 needs a 2+ run win; the +1 walk-off
            # spike steals mass from exactly the margins -1.5 needs
            p_cover = model.cover_prob(0.0, -1.5)
            naive = mathutils.cover_prob(0.0, -1.5, model.SIGMA_MARGIN)
            self.assertLess(p_cover, naive)
            # no ties: win prob of an even game still > 50% for home? No -
            # margin 0 means true even; truncation skews the +1 cell but
            # the pmf is renormalized, so home picks up a touch over 50%
            self.assertGreater(model.win_prob(0.0), 0.5)
            self.assertLess(model.win_prob(0.0), 0.55)

    def test_mlb_park_learning(self):
        from sportsbook.models import MLBModel
        with db.session() as conn:
            model = MLBModel(conn)
            # half home games in a launching pad (8-6), half road games in
            # normal parks (4-4): the team EWMAs settle near the blend and
            # the home-game residual accrues to the park offset
            for i in range(80):
                if i % 2 == 0:
                    game = {"sport": "MLB", "home_team": "Colorado Rockies",
                            "away_team": f"Visitor {i}",
                            "commence_time": "2026-06-01T20:00:00Z",
                            "home_score": 8, "away_score": 6,
                            "neutral_site": 0}
                else:
                    game = {"sport": "MLB", "home_team": f"Host {i}",
                            "away_team": "Colorado Rockies",
                            "commence_time": "2026-06-01T20:00:00Z",
                            "home_score": 4, "away_score": 4,
                            "neutral_site": 0}
                model.learn(game, None)
            self.assertGreater(model.park_adj("Colorado Rockies"), 0.5)
            model.save()
            # park offsets survive a reload
            reloaded = MLBModel(conn)
            self.assertAlmostEqual(reloaded.park_adj("Colorado Rockies"),
                                   model.park_adj("Colorado Rockies"))

    def test_nfl_key_number_pricing(self):
        from sportsbook.models import NFLModel
        with db.session() as conn:
            model = NFLModel(conn)
            # a 3-point favorite at -3 pushes far more often than the
            # smooth curve says
            self.assertGreater(model.push_prob(3.0, -3.0),
                               mathutils.push_prob(3.0, -3.0,
                                                   model.SIGMA_MARGIN) * 2)

    def test_learning_grades_raw_model_not_blend(self):
        from sportsbook.models import NBAModel
        with db.session() as conn:
            model = NBAModel(conn)
            sse_before = model.margin_sse_model
            pred = {"pred_home_margin": 1.0,   # blended (market-leaning)
                    "pred_total": 230.0, "pred_home_wp": 0.53,
                    "market_home_spread": -1.0, "market_total": 230.0,
                    "market_home_ml": None, "market_away_ml": None,
                    "features": {"x": {"home_adv": 1.0, "home_b2b": 0.0,
                                       "away_b2b": 0.0},
                                 "raw": {"margin": 9.0, "total": 240.0}}}
            game = {"sport": "NBA", "home_team": "H", "away_team": "A",
                    "commence_time": "2026-01-15T02:00:00Z",
                    "home_score": 110, "away_score": 109, "neutral_site": 0}
            model.learn(game, pred)
            # model error must be vs raw margin 9 (err 8), not blend 1 (err 0)
            self.assertAlmostEqual(model.margin_sse_model - sse_before,
                                   64.0, places=6)

    def test_market_blend_starts_humble(self):
        from sportsbook.models import NFLModel
        with db.session() as conn:
            model = NFLModel(conn)
            self.assertAlmostEqual(model.alpha_margin,
                                   model.BLEND_PRIOR_ALPHA, places=2)
            blended = model.blended_margin(10.0, 0.0)
            self.assertLess(blended, 5.0)  # leans market early

    def test_sgd_moves_weights_toward_truth(self):
        from sportsbook.models import NBAModel
        with db.session() as conn:
            model = NBAModel(conn)
            start = model.w["home_adv"]
            # homes keep beating the prediction -> home_adv should grow
            for i in range(30):
                pred = {"pred_home_margin": start, "pred_total": 233.0,
                        "pred_home_wp": 0.55,
                        "market_home_spread": None, "market_total": None,
                        "features": {"x": {"home_adv": 1.0, "home_b2b": 0.0,
                                           "away_b2b": 0.0}}}
                game = {"sport": "NBA", "home_team": f"H{i}",
                        "away_team": f"A{i}",
                        "commence_time": "2026-01-15T02:00:00Z",
                        "home_score": 120, "away_score": 110,
                        "neutral_site": 0}
                model.learn(game, pred)
            self.assertGreater(model.w["home_adv"], start)


class FakeModel:
    """Minimal stand-in for candidate-generation tests."""
    SPORT = "NBA"
    SIGMA_MARGIN = 11.7
    SPREAD_SELECTION_PENALTY = 0.0

    def __init__(self, margin, total):
        self._margin, self._total = margin, total

    def market_implied_margin(self, line):
        if line.get("home_spread") is not None:
            return -line["home_spread"]
        return None

    def ml_probs(self, margin):
        p = self.win_prob(margin)
        return p, 1.0 - p, 0.0

    def blended_margin(self, m, mm):
        return self._margin

    def blended_total(self, t, mt):
        return self._total

    def cover_prob(self, margin, spread):
        return mathutils.cover_prob(margin, spread, self.SIGMA_MARGIN)

    def push_prob(self, margin, spread):
        return mathutils.push_prob(margin, spread, self.SIGMA_MARGIN)

    def win_prob(self, margin):
        return mathutils.win_prob_from_margin(margin, self.SIGMA_MARGIN)

    def over_prob(self, total, line):
        return 1 - mathutils.normal_cdf(line, total, 18.0)

    def total_push_prob(self, total, line):
        return 0.0


class TestBetting(unittest.TestCase):
    def line_row(self, **kw):
        base = dict(home_spread=-3.0, home_spread_price=-110,
                    away_spread_price=-110, total=230.0, over_price=-110,
                    under_price=-110, home_ml=-150, away_ml=+130)
        base.update(kw)
        return base

    def game(self):
        return {"game_id": 1, "home_team": "Boston Celtics",
                "away_team": "Miami Heat",
                "commence_time": "2026-06-30T23:00:00Z",
                "pred": {"margin": 7.0, "total": 238.0, "features": {}}}

    def test_side_likes_home_when_model_likes_home(self):
        cand = betting.side_candidates(FakeModel(7.0, 238.0), self.game(),
                                       self.line_row())
        self.assertEqual(cand["selection"], "Boston Celtics")
        self.assertGreater(cand["edge"], 0)
        self.assertEqual(cand["model_line"], -7.0)

    def test_moneyline_chosen_when_better_priced(self):
        # model says home wins 73%; ML +120 on home pays way over fair,
        # while the spread asks home to cover -3 at -110
        line = self.line_row(home_ml=+120, away_ml=-140)
        cand = betting.side_candidates(FakeModel(7.0, 238.0), self.game(), line)
        self.assertEqual(cand["market"], "moneyline")
        self.assertEqual(cand["selection"], "Boston Celtics")

    def test_total_over_when_model_higher(self):
        cand = betting.total_candidates(FakeModel(7.0, 238.0), self.game(),
                                        self.line_row())
        self.assertEqual(cand["selection"], "Over")
        self.assertGreater(cand["edge"], 0)

    def test_mlb_market_margin_comes_from_moneyline_not_run_line(self):
        from sportsbook.models import MLBModel, NBAModel
        with db.session() as conn:
            mlb = MLBModel(conn)
            line = {"home_spread": -1.5, "home_ml": -110, "away_ml": -110}
            # even moneyline -> market thinks the game is a coin flip,
            # despite the fixed -1.5 run line
            self.assertAlmostEqual(mlb.market_implied_margin(line), 0.0,
                                   places=4)
            nba = NBAModel(conn)
            self.assertAlmostEqual(nba.market_implied_margin(line), 1.5)

    def test_pick_card_ranks_by_confidence(self):
        cands = [dict(game_id=i, market="spread", confidence=c, edge=c / 1000)
                 for i, c in enumerate([5, 80, 40, 60, 10, 90])]
        card = betting.pick_card(cands, 3)
        self.assertEqual([c["confidence"] for c in card], [90, 80, 60])
        self.assertEqual(card[0]["stake"], 90.0)


def fake_lines(sport):
    """12 MLB games starting tonight; model edges vary by matchup."""
    if sport != "MLB":
        return []
    rows = []
    for i in range(12):
        rows.append({
            "odds_id": f"odds{i}", "commence_time": "2026-06-30T23:10:00Z",
            "home_team": f"Home Club {i}", "away_team": f"Away Club {i}",
            "home_spread": -1.5, "home_spread_price": 130,
            "away_spread_price": -156,
            "total": 8.5, "over_price": -110, "under_price": -110,
            "home_ml": -120 - i * 5, "away_ml": 100 + i * 5,
        })
    return rows


def fake_scoreboard_pregame(sport, ymd):
    if sport != "MLB":
        return []
    return [{
        "espn_id": f"espn{i}", "season_type": 2,
        "commence_time": "2026-06-30T23:10:00Z",
        "home_team": f"Home Club {i}", "away_team": f"Away Club {i}",
        "neutral_site": False, "completed": False,
        "home_score": None, "away_score": None,
        "home_pitcher": f"Home Pitcher {i}", "away_pitcher": f"Away Pitcher {i}",
    } for i in range(12)]


def fake_scoreboard_final(sport, ymd):
    rows = fake_scoreboard_pregame(sport, ymd)
    for i, r in enumerate(rows):
        r["completed"] = True
        r["home_score"] = 6 if i % 2 == 0 else 2   # evens: home wins 6-2
        r["away_score"] = 2 if i % 2 == 0 else 6
    return rows


class TestEndToEnd(DBTestCase):
    def test_two_day_cycle(self):
        from sportsbook import pipeline

        day1 = NOW
        day2 = NOW + dt.timedelta(days=1)

        with mock.patch("sportsbook.odds.fetch_fanduel_lines",
                        side_effect=fake_lines), \
             mock.patch("sportsbook.espn.fetch_scoreboard",
                        side_effect=fake_scoreboard_pregame), \
             mock.patch("sportsbook.odds.fetch_scores", return_value={}):
            result = pipeline.run_daily(now=day1, verbose=lambda *a: None)

        self.assertEqual(len(result["analyses"]), 12)   # every game analyzed
        self.assertEqual(len(result["card"]), 10)        # exactly 10 bets
        for bet in result["card"]:
            self.assertEqual(bet["stake"], float(bet["confidence"]))
            self.assertGreaterEqual(bet["confidence"], 1)
            self.assertLessEqual(bet["confidence"], 100)
        self.assertTrue(Path(result["report"]).exists())

        with db.session() as conn:
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) c FROM predictions").fetchone()["c"], 12)
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) c FROM bets WHERE status='pending'"
            ).fetchone()["c"], 10)

        # re-running the same day must not duplicate bets
        with mock.patch("sportsbook.odds.fetch_fanduel_lines",
                        side_effect=fake_lines), \
             mock.patch("sportsbook.espn.fetch_scoreboard",
                        side_effect=fake_scoreboard_pregame), \
             mock.patch("sportsbook.odds.fetch_scores", return_value={}):
            pipeline.run_daily(now=day1 + dt.timedelta(hours=2),
                               verbose=lambda *a: None)
        with db.session() as conn:
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) c FROM bets").fetchone()["c"], 10)

        # day 2: scores are final -> bets settle, learning runs
        with mock.patch("sportsbook.odds.fetch_fanduel_lines",
                        return_value=[]), \
             mock.patch("sportsbook.espn.fetch_scoreboard",
                        side_effect=fake_scoreboard_final), \
             mock.patch("sportsbook.odds.fetch_scores", return_value={}):
            result2 = pipeline.run_daily(now=day2, verbose=lambda *a: None)

        with db.session() as conn:
            pending = conn.execute(
                "SELECT COUNT(*) c FROM bets WHERE status='pending'"
            ).fetchone()["c"]
            self.assertEqual(pending, 0)
            graded = conn.execute(
                "SELECT status, COUNT(*) c FROM bets GROUP BY status"
            ).fetchall()
            statuses = {r["status"]: r["c"] for r in graded}
            self.assertEqual(sum(statuses.values()), 10)
            self.assertNotIn("pending", statuses)
            # learning ran over all 12 analyzed games
            self.assertEqual(conn.execute(
                "SELECT COUNT(*) c FROM predictions WHERE learned=1"
            ).fetchone()["c"], 12)
            # ratings moved
            self.assertNotEqual(db.get_rating(conn, "MLB", "Home Club 0",
                                              0.0)[0], 0.0)
            # pitcher ratings learned from probables
            self.assertNotEqual(db.get_pitcher(conn, "Home Pitcher 0")[0], 0.0)
            # bankroll arithmetic holds: profit = sum of graded profits
            total_profit = conn.execute(
                "SELECT COALESCE(SUM(profit),0) p FROM bets").fetchone()["p"]
            from sportsbook import report
            s = report.bankroll_summary(conn)
            self.assertAlmostEqual(
                s["bankroll"], config.STARTING_BANKROLL + total_profit, 2)

        self.assertEqual(len(result2["settled"]["settled_bets"]), 10)


class TestSettlementGrading(DBTestCase):
    def make_game_and_bet(self, market, selection, line, price,
                          home_score, away_score):
        from sportsbook import settle
        with db.session() as conn:
            gid = db.upsert_game(conn, "NBA", odds_id="g1",
                                 commence_time="2026-06-29T23:00:00Z",
                                 home_team="Boston Celtics",
                                 away_team="Miami Heat")
            conn.execute(
                """INSERT INTO bets (run_date, sport, game_id, market,
                       selection, line, price, win_prob, edge, confidence,
                       stake) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                ("2026-06-29", "NBA", gid, market, selection, line, price,
                 0.55, 0.05, 50, 50.0))
            db.record_result(conn, gid, home_score, away_score)
            results = {"settled_bets": [], "voided": 0}
            settle._grade_bets(conn, NOW, results)
            return conn.execute("SELECT * FROM bets").fetchone()

    def test_spread_win(self):
        b = self.make_game_and_bet("spread", "Boston Celtics", -3.0, -110,
                                   110, 100)
        self.assertEqual(b["status"], "won")
        self.assertAlmostEqual(b["profit"], 50 * (100 / 110), 2)

    def test_spread_push(self):
        b = self.make_game_and_bet("spread", "Boston Celtics", -10.0, -110,
                                   110, 100)
        self.assertEqual(b["status"], "push")
        self.assertEqual(b["profit"], 0.0)

    def test_underdog_spread_win_on_loss(self):
        b = self.make_game_and_bet("spread", "Miami Heat", +7.5, -110,
                                   105, 100)
        self.assertEqual(b["status"], "won")

    def test_total_under_loss(self):
        b = self.make_game_and_bet("total", "Under", 200.5, -105, 110, 100)
        self.assertEqual(b["status"], "lost")
        self.assertEqual(b["profit"], -50.0)

    def test_moneyline_underdog_win(self):
        b = self.make_game_and_bet("moneyline", "Miami Heat", None, +180,
                                   100, 104)
        self.assertEqual(b["status"], "won")
        self.assertAlmostEqual(b["profit"], 50 * 1.8, 2)


class TestShortenedMLBGames(DBTestCase):
    """FanDuel house rules: in a rain-shortened final, moneylines stand,
    run lines void, totals stand only if already over the line."""

    def grade(self, market, selection, line, home_score, away_score,
              periods):
        from sportsbook import settle
        with db.session() as conn:
            gid = db.upsert_game(conn, "MLB", odds_id="g1",
                                 commence_time="2026-06-29T23:00:00Z",
                                 home_team="Chicago Cubs",
                                 away_team="St. Louis Cardinals")
            conn.execute(
                """INSERT INTO bets (run_date, sport, game_id, market,
                       selection, line, price, win_prob, edge, confidence,
                       stake) VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                ("2026-06-29", "MLB", gid, market, selection, line, -110,
                 0.55, 0.05, 50, 50.0))
            db.record_result(conn, gid, home_score, away_score, periods)
            results = {"settled_bets": [], "voided": 0}
            settle._grade_bets(conn, NOW, results)
            return conn.execute("SELECT * FROM bets").fetchone()

    def test_run_line_voids_when_shortened(self):
        b = self.grade("spread", "Chicago Cubs", -1.5, 6, 2, periods=7)
        self.assertEqual(b["status"], "void")
        self.assertEqual(b["profit"], 0.0)

    def test_run_line_stands_at_nine(self):
        b = self.grade("spread", "Chicago Cubs", -1.5, 6, 2, periods=9)
        self.assertEqual(b["status"], "won")

    def test_under_voids_when_shortened(self):
        b = self.grade("total", "Under", 8.5, 4, 2, periods=7)
        self.assertEqual(b["status"], "void")

    def test_over_stands_when_already_determined(self):
        b = self.grade("total", "Over", 8.5, 7, 5, periods=7)
        self.assertEqual(b["status"], "won")

    def test_moneyline_stands_when_shortened(self):
        b = self.grade("moneyline", "Chicago Cubs", None, 4, 2, periods=6)
        self.assertEqual(b["status"], "won")

    def test_doubleheader_games_stay_separate(self):
        with db.session() as conn:
            g1 = db.upsert_game(conn, "MLB", espn_id="e1",
                                commence_time="2026-07-04T17:05:00Z",
                                home_team="Minnesota Twins",
                                away_team="Detroit Tigers")
            g2 = db.upsert_game(conn, "MLB", espn_id="e2",
                                commence_time="2026-07-04T21:10:00Z",
                                home_team="Minnesota Twins",
                                away_team="Detroit Tigers")
            self.assertNotEqual(g1, g2)  # 4h apart: two real games

    def test_cross_feed_same_game_merges(self):
        with db.session() as conn:
            g1 = db.upsert_game(conn, "NBA", odds_id="o1",
                                commence_time="2026-01-15T02:10:00Z",
                                home_team="Los Angeles Clippers",
                                away_team="Boston Celtics")
            g2 = db.upsert_game(conn, "NBA", espn_id="e1",
                                commence_time="2026-01-15T02:00:00Z",
                                home_team="LA Clippers",
                                away_team="Boston Celtics")
            self.assertEqual(g1, g2)  # same game, differently-named feeds
            row = conn.execute("SELECT * FROM games WHERE id=?",
                               (g1,)).fetchone()
            self.assertEqual(row["odds_id"], "o1")
            self.assertEqual(row["espn_id"], "e1")

    def test_mlb_seasons_are_calendar_years(self):
        from sportsbook.models import MLBModel, NBAModel
        june = dt.datetime(2026, 6, 30, tzinfo=dt.timezone.utc)
        july = dt.datetime(2026, 7, 15, tzinfo=dt.timezone.utc)
        self.assertEqual(MLBModel.season_of(june), MLBModel.season_of(july))
        # NBA June games belong to the season that started the prior fall
        self.assertEqual(NBAModel.season_of(june), "2025")


if __name__ == "__main__":
    unittest.main()
