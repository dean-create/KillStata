"""冻结数据与独立算法参照只用于引擎测试，不进入产品运行时。"""

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from killstata_econometrics_engine.protocol import handle_request


ROOT = Path(__file__).parent
FIXTURES = ROOT / "fixtures"
ORACLES = ROOT / "oracles"
MANIFEST = json.loads((FIXTURES / "benchmark-manifest.json").read_text(encoding="utf-8"))


def oracle(script: str, fixture: str, *arguments: str) -> dict:
    output = subprocess.check_output([sys.executable, str(ORACLES / script), str(FIXTURES / fixture), *arguments], text=True)
    return json.loads(output)


def execute(method_id: str, fixture: str, arguments: dict, output_dir: Path) -> dict:
    response = handle_request({
        "protocol_version": 1,
        "request_id": f"benchmark-{method_id}",
        "operation": "execute",
        "payload": {
            "method_id": method_id,
            "data_path": str(FIXTURES / fixture),
            "output_dir": str(output_dir),
            "arguments": arguments,
        },
    })
    if not response["ok"]:
        raise AssertionError(response["error"])
    return response["result"]["payload"]


class BenchmarkOracleTests(unittest.TestCase):
    def test_locked_fixtures_have_not_drifted(self):
        for benchmark in MANIFEST["benchmarks"]:
            with self.subTest(fixture=benchmark["fixture"]):
                self.assertEqual(hashlib.sha256((FIXTURES / benchmark["fixture"]).read_bytes()).hexdigest(), benchmark["sha256"])
                self.assertTrue((ORACLES / benchmark["oracle"]).is_file())

    def test_iv_diagnostics_match_independent_statsmodels_oracle(self):
        expected = oracle("iv_test_oracle.py", "card1995.csv")
        with tempfile.TemporaryDirectory() as directory:
            for instruments, key in [(["nearc4"], "justIdentified"), (["nearc4", "nearc2"], "overIdentified")]:
                with self.subTest(instruments=instruments):
                    actual = execute("iv_test", "card1995.csv", {
                        "dependentVar": "lwage", "treatmentVar": "educ",
                        "covariates": ["exper", "expersq", "black", "south", "smsa"],
                        "instrumentVars": instruments, "covariance": "robust",
                    }, Path(directory) / key)
                    reference = expected[key]
                    self.assertEqual(actual["rowsUsed"], reference["rowsUsed"])
                    self.assertAlmostEqual(actual["weakInstrument"]["firstStageStatistic"], reference["firstStageFChi2"], places=5)
                    self.assertTrue(actual["weakInstrument"]["firstStageStatisticDistribution"].startswith("chi2("))
                    self.assertAlmostEqual(actual["endogeneity"]["wooldridgeRegression"]["stat"], reference["dwhRobustStat"], places=5)
                    self.assertEqual(actual["overIdentification"]["applicable"], key == "overIdentified")
                    if key == "overIdentified":
                        self.assertAlmostEqual(actual["overIdentification"]["sargan"]["stat"], reference["sarganStat"], places=5)
                    else:
                        self.assertIsNone(actual["overIdentification"]["sargan"]["stat"])

    def test_rdd_matches_published_and_independent_local_linear_estimate(self):
        expected = oracle("rdd_sharp_oracle.py", "rdrobust_senate.csv")
        with tempfile.TemporaryDirectory() as directory:
            actual = execute("rdd_sharp", "rdrobust_senate.csv", {
                "dependentVar": "vote", "runningVar": "margin", "cutoff": 0.0,
            }, Path(directory))
        self.assertAlmostEqual(actual["conventional"]["estimate"], expected["published"]["conventional"], places=3)
        self.assertAlmostEqual(actual["conventional"]["estimate"], expected["independentWls"]["conventional"], places=4)
        self.assertAlmostEqual(actual["bandwidth"]["h"], expected["published"]["bandwidthH"], places=2)
        self.assertEqual(actual["nEffective"], {"left": expected["published"]["nLeft"], "right": expected["published"]["nRight"]})
        self.assertEqual(actual["primary"], actual["robust"])
        self.assertEqual(actual["primary"], actual["robust"])

    def test_did2s_matches_independent_gardner_gmm_oracle(self):
        expected = oracle("did2s_oracle.py", "mpdta_did.csv")
        with tempfile.TemporaryDirectory() as directory:
            actual = execute("did2s", "mpdta_did.csv", {
                "dependentVar": "lemp", "treatmentVar": "did2s_treated",
                "entityVar": "countyreal", "timeVar": "year",
                "relativeTimeVar": "event_time", "clusterVar": "countyreal",
                "covariates": [], "referencePeriod": -1.0,
            }, Path(directory))
        self.assertEqual(actual["rowsUsed"], expected["rowsUsed"])
        self.assertAlmostEqual(actual["primary"]["estimate"], expected["coefficient"], places=5)
        self.assertAlmostEqual(actual["primary"]["stdError"], expected["stdError"], places=5)

    def test_psm_matching_matches_independent_scipy_oracle(self):
        expected = oracle("psm_matching_oracle.py", "nsw_dw_analysis.csv", "dw_demographics")
        self.assertEqual(expected["status"], "PASS", expected)
        with tempfile.TemporaryDirectory() as directory:
            actual = execute("psm_matching", "nsw_dw_analysis.csv", {
                "dependentVar": "re78", "treatmentVar": "treat", "analysisUnitVar": "unit_id",
                "preTreatmentAggregation": "not_applicable",
                "covariates": ["age", "age_squared", "education", "black", "hispanic", "nodegree"],
            }, Path(directory))
        for actual_key, oracle_key in [
            ("att", "att"),
            ("matchedTreatedCount", "matched_treated_count"),
            ("postMatchMaxAbsSmd", "post_match_max_abs_smd"),
        ]:
            with self.subTest(metric=actual_key):
                self.assertAlmostEqual(actual[actual_key], expected["diagnostic"][oracle_key], places=5)

    def test_psm_ipw_matches_independent_scipy_oracle(self):
        expected = oracle("psm_ipw_oracle.py", "nsw_dw_analysis.csv")
        self.assertEqual(expected["status"], "PASS", expected)
        with tempfile.TemporaryDirectory() as directory:
            actual = execute("psm_ipw", "nsw_dw_analysis.csv", {
                "dependentVar": "re78", "treatmentVar": "treat", "analysisUnitVar": "unit_id",
                "preTreatmentAggregation": "not_applicable",
                "covariates": ["age", "age_squared", "education", "black", "hispanic", "nodegree"],
            }, Path(directory))
        reference = expected["diagnostic"]
        self.assertEqual(actual["rowsUsed"], 445)
        self.assertAlmostEqual(actual["ate"], reference["ate"], places=4)
        self.assertEqual(actual["treatedCount"], reference["treated_count"])
        self.assertEqual(actual["controlCount"], reference["control_count"])
        self.assertAlmostEqual(actual["treatmentEss"], reference["treatment_ess"], places=4)
        self.assertAlmostEqual(actual["controlEss"], reference["control_ess"], places=4)
        self.assertAlmostEqual(actual["weightedMaxAbsSmd"], reference["weighted_max_abs_smd"], places=6)
        self.assertAlmostEqual(actual["minPropensityScore"], reference["min_propensity_score"], places=5)
        self.assertAlmostEqual(actual["maxPropensityScore"], reference["max_propensity_score"], places=5)
        self.assertNotIn("standardError", actual)
        self.assertNotIn("pValue", actual)

    def test_psm_outcome_adjustments_match_independent_scipy_oracle(self):
        expected = oracle("psm_adjustment_oracle.py", "nsw_dw_analysis.csv")
        self.assertEqual(expected["status"], "PASS", expected)
        covariates = ["age", "age_squared", "education", "black", "hispanic", "nodegree"]
        with tempfile.TemporaryDirectory() as directory:
            for method_id, expected_key in [
                ("psm_regression", "regression_adjustment_ate"),
                ("psm_double_robust", "aipw_ate"),
            ]:
                with self.subTest(method=method_id):
                    actual = execute(method_id, "nsw_dw_analysis.csv", {
                        "dependentVar": "re78", "treatmentVar": "treat", "analysisUnitVar": "unit_id",
                        "preTreatmentAggregation": "not_applicable", "covariates": covariates,
                    }, Path(directory) / method_id)
                    self.assertEqual(actual["rowsUsed"], 445)
                    self.assertAlmostEqual(actual["ate"], expected["diagnostic"][expected_key], places=4)
                    self.assertEqual(actual["treatedCount"], 185)
                    self.assertEqual(actual["controlCount"], 260)
                    self.assertAlmostEqual(actual["treatmentEss"], expected["diagnostic"]["treatment_ess"], places=4)
                    self.assertAlmostEqual(actual["controlEss"], expected["diagnostic"]["control_ess"], places=4)
                    self.assertAlmostEqual(actual["weightedMaxAbsSmd"], expected["diagnostic"]["weighted_max_abs_smd"], places=6)
                    self.assertTrue(Path(actual["resultPath"]).is_file())
                    self.assertTrue(Path(actual["diagnostics_path"]).is_file())
                    self.assertTrue(Path(actual["output_path"]).is_file())
                    self.assertNotIn("standardError", actual)
                    self.assertNotIn("pValue", actual)


if __name__ == "__main__":
    unittest.main()
