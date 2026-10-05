import tempfile
import unittest
from pathlib import Path

import pandas as pd
from statsmodels.datasets import fair

from killstata_econometrics_engine.protocol import handle_request


class CountMethodPreflightTests(unittest.TestCase):
    def test_negative_binomial_preflight_does_not_round_near_integer_counts(self):
        frame = pd.DataFrame({
            "numvisit": [0.0, 1.000001, 2.0, 3.0],
            "badh": [0, 1, 0, 1],
            "age": [30, 40, 50, 60],
        })
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "near-integer-count.csv"
            frame.to_csv(path, index=False)
            response = handle_request({
                "protocol_version": 2,
                "request_id": "negbin-near-integer-preflight",
                "operation": "preflight",
                "payload": {
                    "method_id": "negbin_regression",
                    "data_path": str(path),
                    "arguments": {
                        "dependentVar": "numvisit",
                        "treatmentVar": "badh",
                        "covariates": ["age"],
                    },
                },
            })

        self.assertTrue(response["ok"], response)
        result = response["result"]
        self.assertFalse(result["executable"], result)
        self.assertEqual(result["status"], "requires_user_decision")
        self.assertTrue(any(issue["code"] == "COUNT_OUTCOME_NOT_INTEGER" for issue in result["issues"]))

    def test_negative_binomial_preflight_rejects_real_continuous_fair_outcome(self):
        frame = fair.load_pandas().data
        self.assertEqual(len(frame), 6366)
        self.assertFalse(((frame["affairs"] - frame["affairs"].round()).abs() < 1e-9).all())

        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fair-redbook.csv"
            frame.to_csv(path, index=False)
            response = handle_request({
                "protocol_version": 2,
                "request_id": "real-fair-negbin-preflight",
                "operation": "preflight",
                "payload": {
                    "method_id": "negbin_regression",
                    "data_path": str(path),
                    "arguments": {
                        "dependentVar": "affairs",
                        "treatmentVar": "age",
                        "covariates": ["yrs_married"],
                        "covariance": "robust",
                    },
                },
            })

        self.assertTrue(response["ok"], response)
        result = response["result"]
        self.assertFalse(result["executable"], result)
        self.assertEqual(result["status"], "requires_user_decision")
        issue = next(item for item in result["issues"] if item["code"] == "COUNT_OUTCOME_NOT_INTEGER")
        self.assertEqual(issue["evidence"]["column"], "affairs")
        self.assertTrue(result["repair_plan"])
        self.assertTrue(result["repair_plan"][0]["requires_confirmation"])

    def test_negative_binomial_execute_rejects_real_continuous_fair_outcome_without_artifacts(self):
        frame = fair.load_pandas().data
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "fair-redbook.csv"
            output_dir = root / "results"
            frame.to_csv(data_path, index=False)
            response = handle_request({
                "protocol_version": 2,
                "request_id": "real-fair-negbin-must-not-estimate",
                "operation": "execute",
                "payload": {
                    "method_id": "negbin_regression",
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
            self.assertIn("负二项", response["error"]["message_zh"])
            self.assertFalse((output_dir / "results.json").exists())

    def test_ppml_overdispersion_diagnostic_does_not_recommend_negbin_for_continuous_fair_outcome(self):
        frame = fair.load_pandas().data
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "fair-redbook.csv"
            output_dir = root / "results"
            frame.to_csv(data_path, index=False)
            response = handle_request({
                "protocol_version": 2,
                "request_id": "real-fair-ppml-overdispersion",
                "operation": "execute",
                "payload": {
                    "method_id": "poisson_regression",
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

        self.assertTrue(response["ok"], response)
        payload = response["result"]["payload"]
        self.assertFalse(payload["isPureCount"])
        self.assertGreater(payload["dispersion"], 1.5)
        warnings = "\n".join(payload["warnings"])
        self.assertNotIn("negbin_regression", warnings)
        self.assertNotIn("建议改用负二项", warnings)
        self.assertIn("不构成改用负二项计数模型的依据", warnings)
        self.assertIn("HC1", warnings)


if __name__ == "__main__":
    unittest.main()
