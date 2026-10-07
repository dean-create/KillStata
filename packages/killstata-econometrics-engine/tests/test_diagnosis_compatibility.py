import unittest
from unittest.mock import patch

import pandas as pd

from killstata_econometrics_engine.diagnosis import diagnose_dataframe


class DataDiagnosisCompatibilityTests(unittest.TestCase):
    def test_unrelated_quality_blocker_does_not_replace_method_role_requirements(self):
        frame = pd.DataFrame({
            "outcome": [1, 2, 3, 4],
            "treatment": [0, 1, 0, 1],
            "year": [2020, 2020, 2021, 2021],
        })

        with patch(
            "killstata_econometrics_engine.diagnosis.build_quality_report",
            return_value=(frame, {
                "blocking_errors": ["当前诊断发现一个与所有方法无关的阻断项"],
                "warnings": [],
            }),
        ):
            report = diagnose_dataframe(frame, dataset_id="ds_partial", stage_id="stage_000")

        by_method = {item.method_id: item for item in report.method_compatibility}
        self.assertEqual(by_method["ols_regression"].status, "compatible")
        self.assertEqual(by_method["negbin_regression"].status, "requires_semantic_input")
        self.assertEqual(by_method["did_static"].status, "requires_semantic_input")

    def test_empty_dataset_does_not_report_every_method_as_repairable(self):
        frame = pd.DataFrame({
            "outcome": pd.Series(dtype="float64"),
            "treatment": pd.Series(dtype="int64"),
            "year": pd.Series(dtype="int64"),
        })

        report = diagnose_dataframe(frame, dataset_id="ds_empty", stage_id="stage_000")

        self.assertTrue(any(issue.severity == "blocking" for issue in report.issues))
        self.assertTrue(report.method_compatibility)
        self.assertEqual({item.status for item in report.method_compatibility}, {"incompatible"})
        self.assertEqual(report.recommended_method_ids, [])
        self.assertTrue(all(item.required_repairs == [] for item in report.method_compatibility))


if __name__ == "__main__":
    unittest.main()
