import unittest

import pandas as pd

from killstata_econometrics_engine.diagnosis import diagnose_dataframe


class DataDiagnosisTests(unittest.TestCase):
    def test_readiness_offers_poisson_ppml_for_continuous_nonnegative_outcome_not_negative_binomial(self):
        frame = pd.DataFrame({
            "region": ["a", "b", "c", "d"],
            "outcome": [0.2, 0.7, 1.1, 1.8],
            "treatment": [0, 1, 0, 1],
        })

        diagnosis = diagnose_dataframe(frame, dataset_id="ds_ppml", stage_id="stage_000")
        methods = {item.method_id for item in diagnosis.method_compatibility}

        self.assertIn("poisson_regression", methods)
        self.assertNotIn("negbin_regression", methods)

    def test_diagnosis_returns_issues_compatibility_and_bounded_recommendations(self):
        frame = pd.DataFrame({
            "entity": ["a", "a", "b", "b"],
            "year": [2020, 2021, 2020, 2021],
            "y": [1.0, 2.0, 1.5, 2.5],
            "x": [0.0, 1.0, 0.0, 1.0],
        })

        report = diagnose_dataframe(frame, dataset_id="ds_1", stage_id="stage_000")

        self.assertEqual(report.dataset_id, "ds_1")
        self.assertEqual(report.stage_id, "stage_000")
        self.assertTrue(report.method_compatibility)
        self.assertLessEqual(len(report.recommended_method_ids), 3)
        self.assertIn("ols_regression", report.recommended_method_ids)
        self.assertTrue(any(item.method_id == "did_static" for item in report.method_compatibility))

    def test_diagnosis_does_not_modify_the_input_frame(self):
        frame = pd.DataFrame({"y": [1.0, None], "x": [0.0, 1.0]})
        original = frame.copy(deep=True)

        diagnose_dataframe(frame, dataset_id="ds_1", stage_id="stage_000")

        pd.testing.assert_frame_equal(frame, original)

    def test_diagnosis_is_versioned_and_bound_to_canonical_content(self):
        frame = pd.DataFrame({"entity": ["A", "B"], "year": [2020, 2021], "y": [1.0, 2.0]})

        first = diagnose_dataframe(frame, dataset_id="ds_1", stage_id="stage_000")
        same_content = diagnose_dataframe(frame.copy(deep=True), dataset_id="ds_2", stage_id="stage_009")
        changed_content = diagnose_dataframe(frame.assign(y=[1.0, 2.1]), dataset_id="ds_1", stage_id="stage_000")

        self.assertEqual(first.version, 1)
        self.assertEqual(first.data_fingerprint, same_content.data_fingerprint)
        self.assertNotEqual(first.data_fingerprint, changed_content.data_fingerprint)
        self.assertRegex(first.data_fingerprint, r"^sha256:[0-9a-f]{64}$")


if __name__ == "__main__":
    unittest.main()
