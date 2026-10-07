import tempfile
import unittest
from pathlib import Path

import pandas as pd

from killstata_econometrics_engine.preflight import preflight_method
from killstata_econometrics_engine.protocol import handle_request


class PSMDiagnosticUnitTests(unittest.TestCase):
    def test_psm_diagnostic_schema_requires_treatment_and_analysis_unit(self):
        for method_id in ("psm_construction", "psm_visualize"):
            with self.subTest(method_id=method_id):
                accepted = handle_request({
                    "protocol_version": 2,
                    "request_id": f"{method_id}-valid-unit",
                    "operation": "validate",
                    "payload": {
                        "method_id": method_id,
                        "arguments": {
                            "treatmentVar": "treated",
                            "analysisUnitVar": "region",
                            "covariates": ["baseline_x"],
                        },
                    },
                })
                self.assertTrue(accepted["ok"], accepted)
                self.assertEqual(accepted["result"]["arguments"]["analysisUnitVar"], "region")

                for missing_field in ("treatmentVar", "analysisUnitVar"):
                    with self.subTest(missing_field=missing_field):
                        arguments = {
                            "treatmentVar": "treated",
                            "analysisUnitVar": "region",
                            "covariates": ["baseline_x"],
                        }
                        arguments.pop(missing_field)
                        rejected = handle_request({
                            "protocol_version": 2,
                            "request_id": f"{method_id}-missing-{missing_field}",
                            "operation": "validate",
                            "payload": {"method_id": method_id, "arguments": arguments},
                        })
                        self.assertFalse(rejected["ok"], rejected)
                        self.assertEqual(rejected["error"]["code"], "INVALID_ARGUMENT")

    def test_construction_and_visualization_run_on_real_one_row_per_unit_nsw_sample(self):
        source = Path(__file__).parent / "fixtures" / "nsw_dw_analysis.csv"
        arguments = {
            "treatmentVar": "treat",
            "analysisUnitVar": "unit_id",
            "covariates": ["age", "age_squared", "education", "black", "hispanic", "nodegree"],
        }

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            payloads = {}
            artifacts = {}
            for method_id in ("psm_construction", "psm_visualize"):
                response = handle_request({
                    "protocol_version": 2,
                    "request_id": f"nsw-{method_id}",
                    "operation": "execute",
                    "payload": {
                        "method_id": method_id,
                        "data_path": str(source),
                        "output_dir": str(root / method_id),
                        "arguments": arguments,
                    },
                })
                self.assertTrue(response["ok"], response)
                payloads[method_id] = response["result"]["payload"]
                artifacts[method_id] = response["result"]["artifacts"]

            construction = payloads["psm_construction"]
            visualization = payloads["psm_visualize"]
            self.assertEqual(construction["rowsInput"], 445)
            self.assertEqual(construction["rowsUsed"], 445)
            self.assertEqual(visualization["rowsUsed"], 445)
            self.assertAlmostEqual(construction["scoreMin"], 0.2353724908, places=8)
            self.assertAlmostEqual(construction["scoreMax"], 0.6379746561, places=8)
            self.assertAlmostEqual(construction["shareInSupport"], 0.9932584270, places=8)
            self.assertEqual(construction["scoreMin"], visualization["scoreMin"])
            self.assertEqual(construction["scoreMax"], visualization["scoreMax"])
            self.assertEqual(construction["shareInSupport"], visualization["shareInSupport"])

            score_path = Path(construction["propensityScoresPath"])
            self.assertTrue(score_path.is_file())
            self.assertEqual(len(pd.read_csv(score_path)), 445)
            self.assertTrue(Path(construction["resultPath"]).is_file())
            self.assertTrue(any(
                item.get("kind") == "propensity_scores" and item.get("path") == construction["propensityScoresPath"]
                for item in artifacts["psm_construction"]
            ))
            plot_path = Path(visualization["plotPath"])
            self.assertTrue(plot_path.is_file())
            self.assertTrue(plot_path.read_bytes().startswith(b"\x89PNG\r\n\x1a\n"))
            self.assertTrue(Path(visualization["resultPath"]).is_file())
            self.assertTrue(any(
                item.get("kind") == "plot" and item.get("path") == visualization["plotPath"]
                for item in artifacts["psm_visualize"]
            ))

    def test_psm_diagnostics_require_one_observation_per_analysis_unit(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "panel_psm.csv"
            pd.DataFrame({
                "region": ["A", "A", "B", "B"],
                "year": [2019, 2020, 2019, 2020],
                "treated": [0, 1, 0, 1],
                "baseline_x": [1.0, 1.2, 2.0, 2.2],
            }).to_csv(path, index=False)

            for method_id in ("psm_construction", "psm_visualize"):
                with self.subTest(method_id=method_id):
                    result = preflight_method(
                        method_id,
                        str(path),
                        {
                            "treatmentVar": "treated",
                            "analysisUnitVar": "region",
                            "covariates": ["baseline_x"],
                        },
                    )

                    self.assertFalse(result.executable)
                    self.assertEqual(result.status, "requires_user_decision")
                    issue = next(issue for issue in result.issues if issue.code == "DATA_ANALYSIS_UNIT_NOT_UNIQUE")
                    self.assertEqual(issue.evidence["analysisUnitVar"], "region")
                    self.assertEqual(issue.evidence["duplicateRows"], 2)
                    self.assertIn("region", issue.summary_zh)
                    self.assertNotIn("地区—年份", issue.summary_zh)
                    self.assertTrue(result.repair_plan)


if __name__ == "__main__":
    unittest.main()
