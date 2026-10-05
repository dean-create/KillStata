import tempfile
import unittest
from pathlib import Path

import statsmodels.api as sm
from statsmodels.datasets import fair, modechoice

from killstata_econometrics_engine.protocol import handle_request


class MultinomialRealDataTests(unittest.TestCase):
    def _write_fractional_fair_sample(self, path: Path):
        frame = fair.load_pandas().data
        frame = frame.loc[frame["affairs"].le(3)].copy()
        self.assertTrue((frame["affairs"] - frame["affairs"].round()).abs().gt(1e-9).any())
        frame.to_csv(path, index=False)
        return frame

    def test_multinomial_preflight_rejects_real_continuous_fair_outcome(self):
        with tempfile.TemporaryDirectory() as directory:
            data_path = Path(directory) / "fair-continuous-outcome.csv"
            frame = self._write_fractional_fair_sample(data_path)
            response = handle_request({
                "protocol_version": 2,
                "request_id": "fair-mnl-continuous-preflight",
                "operation": "preflight",
                "payload": {
                    "method_id": "multinomial_logit",
                    "data_path": str(data_path),
                    "arguments": {
                        "dependentVar": "affairs",
                        "treatmentVar": "age",
                        "covariates": ["yrs_married"],
                        "covariance": "robust",
                    },
                },
            })

        self.assertEqual(len(frame), 5915)
        self.assertTrue(response["ok"], response)
        result = response["result"]
        self.assertFalse(result["executable"], result)
        self.assertEqual(result["status"], "requires_user_decision")
        self.assertTrue(any(issue["code"] == "MULTINOMIAL_OUTCOME_NOT_CATEGORICAL" for issue in result["issues"]))
        self.assertTrue(result["repair_plan"])

    def test_multinomial_execute_rejects_real_continuous_fair_outcome_without_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "fair-continuous-outcome.csv"
            output_dir = root / "results"
            self._write_fractional_fair_sample(data_path)
            response = handle_request({
                "protocol_version": 2,
                "request_id": "fair-mnl-continuous-execute",
                "operation": "execute",
                "payload": {
                    "method_id": "multinomial_logit",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "dependentVar": "affairs",
                        "treatmentVar": "age",
                        "covariates": ["yrs_married"],
                        "covariance": "robust",
                    },
                },
            })

            self.assertFalse(response["ok"], response)
            self.assertIn("离散整数类别", response["error"]["message_zh"])
            self.assertFalse((output_dir / "results.json").exists())

    def test_modechoice_real_mnl_maps_each_category_to_its_own_confidence_interval(self):
        source = modechoice.load_pandas().data
        self.assertEqual(source.shape, (840, 9))
        self.assertTrue(source.groupby("individual")["choice"].sum().eq(1).all())

        chosen = source.loc[source["choice"].eq(1)].copy()
        self.assertEqual(chosen.shape[0], 210)
        self.assertEqual(chosen["individual"].nunique(), 210)
        self.assertEqual(set(chosen["mode"].astype(int).unique()), {1, 2, 3, 4})
        oracle = sm.MNLogit(
            chosen["mode"].astype(int),
            sm.add_constant(chosen[["hinc", "psize"]], has_constant="add"),
        ).fit(disp=False, maxiter=200, cov_type="HC1")
        oracle_intervals = oracle.conf_int()

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "modechoice-chosen.csv"
            chosen.to_csv(data_path, index=False)
            response = handle_request({
                "protocol_version": 2,
                "request_id": "modechoice-real-mnl-ci-contract",
                "operation": "execute",
                "payload": {
                    "method_id": "multinomial_logit",
                    "data_path": str(data_path),
                    "output_dir": str(root / "results"),
                    "arguments": {
                        "dependentVar": "mode",
                        "treatmentVar": "hinc",
                        "covariates": ["psize"],
                        "covariance": "robust",
                    },
                },
            })

        self.assertTrue(response["ok"], response)
        payload = response["result"]["payload"]
        self.assertEqual(payload["rowsUsed"], 210)
        self.assertEqual(payload["categories"], [1, 2, 3, 4])
        self.assertEqual(payload["baselineCategory"], 1)
        self.assertEqual([row["category"] for row in payload["treatmentPath"]], [2, 3, 4])
        for row in payload["treatmentPath"]:
            with self.subTest(category=row["category"]):
                expected_ci = oracle_intervals.loc[(str(row["category"]), "hinc")]
                self.assertIsNotNone(row["confLow"], row)
                self.assertIsNotNone(row["confHigh"], row)
                self.assertLessEqual(row["confLow"], row["estimate"], row)
                self.assertLessEqual(row["estimate"], row["confHigh"], row)
                self.assertAlmostEqual(row["confLow"], expected_ci["lower"], places=10)
                self.assertAlmostEqual(row["confHigh"], expected_ci["upper"], places=10)

        treatment_coefficients = [row for row in payload["coefficients"] if row["term"] == "hinc"]
        self.assertEqual([row["category"] for row in treatment_coefficients], [2, 3, 4])
        for row in treatment_coefficients:
            expected_ci = oracle_intervals.loc[(str(row["category"]), "hinc")]
            self.assertAlmostEqual(row["confLow"], expected_ci["lower"], places=10)
            self.assertAlmostEqual(row["confHigh"], expected_ci["upper"], places=10)


if __name__ == "__main__":
    unittest.main()
