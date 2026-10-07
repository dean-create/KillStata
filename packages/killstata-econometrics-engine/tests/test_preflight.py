import tempfile
import unittest
from pathlib import Path

import pandas as pd

from killstata_econometrics_engine.preflight import preflight_method
from killstata_econometrics_engine.diagnosis import diagnose_dataframe


class PreflightTests(unittest.TestCase):
    def test_preflight_fingerprint_matches_the_current_table_content(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "current.csv"
            frame = pd.DataFrame({"outcome": [1.0, 2.0, 3.0], "predictor": [2.0, 1.0, 4.0]})
            frame.to_csv(path, index=False)

            result = preflight_method(
                "ols_regression",
                str(path),
                {"dependentVar": "outcome", "treatmentVar": "predictor", "covariates": []},
            )
            diagnosis = diagnose_dataframe(frame, dataset_id="ds", stage_id="stage_000")

            self.assertEqual(result.data_fingerprint, diagnosis.data_fingerprint)

    def test_wls_weight_column_is_not_treated_as_a_model_regressor(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "wls_weight_correlated_with_predictor.csv"
            pd.DataFrame({
                "outcome": [0.0, 1.0, 4.0, 9.0, 16.0],
                "predictor": [0.0, 1.0, 2.0, 3.0, 4.0],
                "precision_weight": [1.0, 2.0, 3.0, 4.0, 5.0],
            }).to_csv(path, index=False)

            result = preflight_method(
                "wls_regression",
                str(path),
                {
                    "dependentVar": "outcome",
                    "treatmentVar": "predictor",
                    "weightsVar": "precision_weight",
                    "covariates": [],
                },
            )

            self.assertTrue(result.executable, result)
            self.assertFalse(any(issue.code == "DESIGN_MATRIX_RANK_DEFICIENT" for issue in result.issues))

    def test_perfectly_predicted_outcome_does_not_make_ols_design_matrix_rank_deficient(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "perfect_fit.csv"
            pd.DataFrame({
                "outcome": [1.0, 3.0, 5.0, 7.0],
                "predictor": [0.0, 1.0, 2.0, 3.0],
            }).to_csv(path, index=False)

            result = preflight_method(
                "ols_regression",
                str(path),
                {"dependentVar": "outcome", "treatmentVar": "predictor", "covariates": []},
            )

            self.assertTrue(result.executable, result)
            self.assertFalse(any(issue.code == "DESIGN_MATRIX_RANK_DEFICIENT" for issue in result.issues))

    def test_wls_zero_weight_requires_user_decision_before_estimation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "zero_wls_weight.csv"
            pd.DataFrame({
                "outcome": [1.0, 2.0, 3.0, 4.0],
                "predictor": [0.0, 1.0, 2.0, 3.0],
                "precision_weight": [1.0, 0.0, 2.0, 3.0],
            }).to_csv(path, index=False)

            result = preflight_method(
                "wls_regression",
                str(path),
                {
                    "dependentVar": "outcome",
                    "treatmentVar": "predictor",
                    "weightsVar": "precision_weight",
                    "covariates": [],
                },
            )

            self.assertFalse(result.executable)
            self.assertEqual(result.status, "requires_user_decision")
            self.assertTrue(any(issue.code == "WLS_WEIGHT_NOT_POSITIVE" for issue in result.issues))
            self.assertTrue(result.repair_plan)
            self.assertTrue(all(repair.requires_confirmation for repair in result.repair_plan))

    def test_preflight_returns_a_user_decision_for_an_empty_dataset(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "empty.csv"
            pd.DataFrame({"outcome": [None, None], "predictor": [None, None]}).to_csv(path, index=False)

            result = preflight_method(
                "ols_regression",
                str(path),
                {"dependentVar": "outcome", "treatmentVar": "predictor", "covariates": []},
            )

            self.assertFalse(result.executable, result)
            self.assertEqual(result.status, "requires_user_decision")
            self.assertTrue(any(issue.code == "DATA_NO_USABLE_ROWS" for issue in result.issues))
            self.assertTrue(all(repair.requires_confirmation for repair in result.repair_plan))

    def test_preflight_requires_a_user_decision_when_model_variables_have_no_complete_cases(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "no_complete_cases.csv"
            pd.DataFrame({
                "outcome": [1.0, None, 3.0],
                "predictor": [None, 2.0, None],
            }).to_csv(path, index=False)

            result = preflight_method(
                "ols_regression",
                str(path),
                {"dependentVar": "outcome", "treatmentVar": "predictor", "covariates": []},
            )

            self.assertFalse(result.executable, result)
            self.assertEqual(result.status, "requires_user_decision")
            self.assertTrue(any(issue.code == "DATA_NO_USABLE_CASES" for issue in result.issues))
            self.assertTrue(any(repair.semantic_impact == "sample" for repair in result.repair_plan))

    def test_logit_and_probit_require_a_binary_zero_one_outcome(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "continuous_binary_model_outcome.csv"
            pd.DataFrame({
                "outcome": [1.2, 2.4, 3.6, 4.8],
                "predictor": [0.0, 1.0, 2.0, 3.0],
            }).to_csv(path, index=False)

            for method_id in ("logit_regression", "probit_regression"):
                with self.subTest(method_id=method_id):
                    result = preflight_method(
                        method_id,
                        str(path),
                        {"dependentVar": "outcome", "treatmentVar": "predictor", "covariates": []},
                    )

                    self.assertFalse(result.executable, result)
                    self.assertEqual(result.status, "requires_user_decision")
                    issue = next((item for item in result.issues if item.code == "BINARY_OUTCOME_NOT_01"), None)
                    self.assertIsNotNone(issue, result.issues)
                    self.assertEqual(issue.evidence["column"], "outcome")
                    self.assertEqual(issue.evidence["observedValueCount"], 4)
                    self.assertTrue(result.repair_plan)
                    self.assertTrue(all(repair.requires_confirmation for repair in result.repair_plan))

    def test_negative_binomial_rejects_non_integer_nonnegative_outcomes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "continuous_nonnegative_outcome.csv"
            pd.DataFrame({
                "outcome": [0.5, 1.5, 2.0, 3.5],
                "predictor": [0.0, 1.0, 2.0, 3.0],
            }).to_csv(path, index=False)

            result = preflight_method(
                "negbin_regression",
                str(path),
                {"dependentVar": "outcome", "treatmentVar": "predictor", "covariates": []},
            )

            self.assertFalse(result.executable, result)
            self.assertEqual(result.status, "requires_user_decision")
            self.assertTrue(any(issue.code == "COUNT_OUTCOME_NOT_INTEGER" for issue in result.issues))
            self.assertTrue(all(repair.requires_confirmation for repair in result.repair_plan))

    def test_panel_estimators_require_explicit_entity_and_time_roles(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "panel_keys.csv"
            pd.DataFrame({
                "outcome": [1.0, 2.0, 2.5, 4.0],
                "predictor": [0.0, 1.0, 0.0, 1.0],
                "unit": ["a", "a", "b", "b"],
                "period": [1, 2, 1, 2],
            }).to_csv(path, index=False)

            for method_id in ("panel_fe_regression", "panel_random_effects"):
                with self.subTest(method_id=method_id):
                    base = {
                        "dependentVar": "outcome",
                        "treatmentVar": "predictor",
                        "covariates": [],
                    }
                    missing_both = preflight_method(method_id, str(path), base)
                    self.assertFalse(missing_both.executable, missing_both)
                    self.assertEqual(missing_both.status, "requires_user_decision")
                    issue = next((item for item in missing_both.issues if item.code == "PANEL_KEYS_REQUIRED"), None)
                    self.assertIsNotNone(issue, missing_both.issues)
                    self.assertEqual(issue.evidence["missingKeys"], ["entityVar", "timeVar"])
                    self.assertTrue(missing_both.repair_plan)

                    missing_time = preflight_method(method_id, str(path), {**base, "entityVar": "unit"})
                    self.assertFalse(missing_time.executable, missing_time)
                    missing_issue = next((item for item in missing_time.issues if item.code == "PANEL_KEYS_REQUIRED"), None)
                    self.assertIsNotNone(missing_issue, missing_time.issues)
                    self.assertEqual(missing_issue.evidence["missingKeys"], ["timeVar"])

                    valid = preflight_method(method_id, str(path), {**base, "entityVar": "unit", "timeVar": "period"})
                    self.assertTrue(valid.executable, valid)

    def test_panel_estimators_require_complete_entity_and_time_values(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "panel_missing_key.csv"
            pd.DataFrame({
                "outcome": [1.0, 2.0, 3.0, 4.0],
                "predictor": [0.0, 1.0, 0.0, 1.0],
                "unit": ["a", None, "b", "b"],
                "period": [1, 1, 1, 2],
            }).to_csv(path, index=False)

            for method_id in ("panel_fe_regression", "panel_random_effects"):
                with self.subTest(method_id=method_id):
                    result = preflight_method(
                        method_id,
                        str(path),
                        {
                            "dependentVar": "outcome",
                            "treatmentVar": "predictor",
                            "entityVar": "unit",
                            "timeVar": "period",
                            "covariates": [],
                        },
                    )

                    self.assertFalse(result.executable, result)
                    self.assertEqual(result.status, "requires_user_decision")
                    issue = next((item for item in result.issues if item.code == "DATA_PANEL_KEY_MISSING"), None)
                    self.assertIsNotNone(issue, result.issues)
                    self.assertEqual(issue.evidence["entityVar"], "unit")
                    self.assertEqual(issue.evidence["missingEntityRows"], 1)
                    self.assertTrue(result.repair_plan)

    def test_panel_estimators_reject_duplicate_entity_time_keys(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "panel_duplicate_key.csv"
            pd.DataFrame({
                "outcome": [1.0, 2.0, 3.0, 4.0],
                "predictor": [0.0, 1.0, 0.0, 1.0],
                "unit": ["a", "a", "b", "b"],
                "period": [1, 1, 1, 2],
            }).to_csv(path, index=False)

            result = preflight_method(
                "panel_fe_regression",
                str(path),
                {
                    "dependentVar": "outcome",
                    "treatmentVar": "predictor",
                    "entityVar": "unit",
                    "timeVar": "period",
                    "covariates": [],
                },
            )

            self.assertFalse(result.executable, result)
            self.assertEqual(result.status, "requires_user_decision")
            issue = next((item for item in result.issues if item.code == "DATA_PANEL_KEY_NOT_UNIQUE"), None)
            self.assertIsNotNone(issue, result.issues)
            self.assertEqual(issue.evidence["duplicateRows"], 1)
            self.assertTrue(result.repair_plan)

    def test_binary_logit_outcome_and_continuous_nonnegative_poisson_outcome_remain_ready(self):
        with tempfile.TemporaryDirectory() as directory:
            logit_path = Path(directory) / "binary_logit.csv"
            pd.DataFrame({
                "outcome": [0, 1, 0, 1],
                "predictor": [0.0, 1.0, 2.0, 3.0],
            }).to_csv(logit_path, index=False)
            logit = preflight_method(
                "logit_regression",
                str(logit_path),
                {"dependentVar": "outcome", "treatmentVar": "predictor", "covariates": []},
            )
            self.assertTrue(logit.executable, logit)

            poisson_path = Path(directory) / "continuous_nonnegative_poisson.csv"
            pd.DataFrame({
                "outcome": [0.2, 1.4, 3.1, 6.0],
                "predictor": [0.0, 1.0, 2.0, 3.0],
            }).to_csv(poisson_path, index=False)
            poisson = preflight_method(
                "poisson_regression",
                str(poisson_path),
                {"dependentVar": "outcome", "treatmentVar": "predictor", "covariates": []},
            )
            self.assertTrue(poisson.executable, poisson)

    def test_poisson_negative_outcome_requires_a_user_decision_before_estimation(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "negative_poisson_outcome.csv"
            pd.DataFrame({
                "outcome": [-1.0, 0.0, 1.0, 2.0],
                "predictor": [0.0, 1.0, 2.0, 3.0],
            }).to_csv(path, index=False)

            result = preflight_method(
                "poisson_regression",
                str(path),
                {"dependentVar": "outcome", "treatmentVar": "predictor", "covariates": []},
            )

            self.assertFalse(result.executable, result)
            self.assertEqual(result.status, "requires_user_decision")
            issue = next((item for item in result.issues if item.code == "POISSON_OUTCOME_NEGATIVE"), None)
            self.assertIsNotNone(issue, result.issues)
            self.assertEqual(issue.evidence["column"], "outcome")
            self.assertEqual(issue.evidence["negativeRows"], 1)
            self.assertTrue(result.repair_plan)
            self.assertTrue(all(repair.requires_confirmation for repair in result.repair_plan))

    def test_rdd_requires_a_user_decision_when_cluster_ids_are_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fuzzy_rdd_missing_cluster.csv"
            pd.DataFrame({
                "outcome": [1.0, 2.0, 1.5, 2.5, 2.0, 3.0],
                "score": [-3.0, -1.0, -0.5, 0.5, 1.0, 3.0],
                "takeup": [0.0, 0.0, 0.2, 0.8, 1.0, 1.0],
                "school": [1, 1, None, 2, 3, 3],
            }).to_csv(path, index=False)

            result = preflight_method(
                "rdd_fuzzy",
                str(path),
                {
                    "dependentVar": "outcome",
                    "runningVar": "score",
                    "fuzzyVar": "takeup",
                    "clusterVar": "school",
                    "cutoff": 0,
                },
            )

            self.assertFalse(result.executable)
            self.assertEqual(result.status, "requires_user_decision")
            self.assertTrue(any(issue.code == "RDD_CLUSTER_ID_MISSING" for issue in result.issues))
            self.assertTrue(result.repair_plan)

    def test_rdd_requires_numeric_outcome_and_running_variables(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rdd_text_outcome.csv"
            pd.DataFrame({
                "outcome": ["low", "medium", "high", "very high"],
                "score": [-2.0, -1.0, 1.0, 2.0],
            }).to_csv(path, index=False)

            result = preflight_method(
                "rdd_sharp",
                str(path),
                {"dependentVar": "outcome", "runningVar": "score", "cutoff": 0.0},
            )

            self.assertFalse(result.executable, result)
            self.assertEqual(result.status, "requires_user_decision")
            issue = next((item for item in result.issues if item.code == "DATA_NUMERIC_REQUIRED"), None)
            self.assertIsNotNone(issue, result.issues)
            self.assertEqual(issue.evidence["columns"], ["outcome"])
            self.assertTrue(result.repair_plan)

    def test_rdd_requires_observations_on_both_sides_of_the_declared_cutoff(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "rdd_one_sided_support.csv"
            pd.DataFrame({
                "outcome": [1.0, 2.0, 3.0, 4.0],
                "score": [1.0, 2.0, 3.0, 4.0],
            }).to_csv(path, index=False)

            result = preflight_method(
                "rdd_sharp",
                str(path),
                {"dependentVar": "outcome", "runningVar": "score", "cutoff": 0.0},
            )

            self.assertFalse(result.executable, result)
            self.assertEqual(result.status, "requires_user_decision")
            issue = next((item for item in result.issues if item.code == "RDD_CUTOFF_SUPPORT_INCOMPLETE"), None)
            self.assertIsNotNone(issue, result.issues)
            self.assertEqual(issue.evidence["leftRows"], 0)
            self.assertEqual(issue.evidence["rightRows"], 4)
            self.assertTrue(result.repair_plan)

    def test_static_did_requires_complete_binary_group_column(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "staggered_panel.csv"
            pd.DataFrame({
                "outcome": [1.0, 2.0, 1.5, 2.5, 1.2, 2.2],
                "time": [2012, 2012, 2013, 2013, None, None],
                "did": [0, 1, 0, 1, 0, 1],
            }).to_csv(path, index=False)

            result = preflight_method(
                "did_static",
                str(path),
                {"dependentVar": "outcome", "groupVar": "time", "postVar": "did"},
            )

            self.assertFalse(result.executable)
            self.assertEqual(result.status, "requires_user_decision")
            self.assertTrue(any(issue.code == "DID_GROUP_NOT_BINARY" for issue in result.issues))
            self.assertTrue(result.repair_plan)
            self.assertTrue(any("did" in repair.description_zh for repair in result.repair_plan))

    def test_static_did_requires_all_four_group_by_post_cells(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "missing_cell.csv"
            pd.DataFrame({
                "outcome": [1.0, 2.0, 1.5, 2.5],
                "treated": [0, 0, 1, 1],
                "post": [0, 1, 0, 0],
            }).to_csv(path, index=False)

            result = preflight_method(
                "did_static",
                str(path),
                {"dependentVar": "outcome", "groupVar": "treated", "postVar": "post"},
            )

            self.assertFalse(result.executable)
            self.assertEqual(result.status, "requires_user_decision")
            self.assertTrue(any(issue.code == "DID_TWO_BY_TWO_CELLS_INCOMPLETE" for issue in result.issues))
            self.assertTrue(result.repair_plan)

    def test_static_did_rejects_non_binary_post_column(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "invalid_post.csv"
            pd.DataFrame({
                "outcome": [1.0, 2.0, 1.5, 2.5],
                "treated": [0, 0, 1, 1],
                "post": [0, 1, 2, 1],
            }).to_csv(path, index=False)

            result = preflight_method(
                "did_static",
                str(path),
                {"dependentVar": "outcome", "groupVar": "treated", "postVar": "post"},
            )

            self.assertFalse(result.executable)
            self.assertEqual(result.status, "requires_user_decision")
            self.assertTrue(any(issue.code == "DID_POST_NOT_BINARY" for issue in result.issues))
            self.assertTrue(result.repair_plan)

    def test_static_did_allows_complete_binary_two_by_two_design(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "complete_2x2.csv"
            pd.DataFrame({
                "outcome": [1.0, 2.0, 1.5, 2.5],
                "treated": [0, 0, 1, 1],
                "post": [0, 1, 0, 1],
            }).to_csv(path, index=False)

            result = preflight_method(
                "did_static",
                str(path),
                {"dependentVar": "outcome", "groupVar": "treated", "postVar": "post"},
            )

            self.assertTrue(result.executable, result)
            self.assertEqual(result.status, "ready")

    def test_event_study_preflight_requires_a_user_decision_for_missing_never_treated_cohort(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "staggered_panel.csv"
            rows = []
            for unit, cohort in (("a", 2012), ("b", 2013), ("c", None)):
                for year in (2011, 2012, 2013):
                    treated = int(cohort is not None and year >= cohort)
                    rows.append({
                        "unit": unit,
                        "year": year,
                        "cohort": cohort,
                        "treated": treated,
                        "outcome": float(year + treated),
                    })
            pd.DataFrame(rows).to_csv(path, index=False)

            result = preflight_method(
                "did_event_study_saturated",
                str(path),
                {
                    "dependentVar": "outcome",
                    "treatmentVar": "treated",
                    "entityVar": "unit",
                    "timeVar": "year",
                    "cohortVar": "cohort",
                    "clusterVar": "unit",
                    "covariates": [],
                },
            )

            self.assertFalse(result.executable)
            self.assertEqual(result.status, "requires_user_decision")
            self.assertTrue(any(issue.code == "DATA_COHORT_MISSING" for issue in result.issues))
            self.assertTrue(result.repair_plan)

    def test_event_study_preflight_accepts_confirmed_zero_sentinel_only_when_treatment_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "staggered_panel.csv"
            rows = []
            for unit, cohort in (("a", 2012), ("b", 2013), ("c", None)):
                for year in (2011, 2012, 2013):
                    treated = int(cohort is not None and year >= cohort)
                    rows.append({
                        "unit": unit,
                        "year": year,
                        "cohort": cohort,
                        "treated": treated,
                        "outcome": float(year + treated),
                    })
            frame = pd.DataFrame(rows)
            frame.to_csv(path, index=False)
            arguments = {
                "dependentVar": "outcome",
                "treatmentVar": "treated",
                "entityVar": "unit",
                "timeVar": "year",
                "cohortVar": "cohort",
                "clusterVar": "unit",
                "neverTreatedCohortValue": 0,
                "covariates": [],
            }

            ready = preflight_method("did_event_study_saturated", str(path), arguments)
            self.assertTrue(ready.executable, ready)
            self.assertEqual(ready.normalized_arguments["neverTreatedCohortValue"], 0)

            frame.loc[(frame["unit"] == "a") & (frame["year"] == 2012), "treated"] = 0
            frame.to_csv(path, index=False)
            inconsistent = preflight_method("did_event_study_saturated", str(path), arguments)
            self.assertFalse(inconsistent.executable)
            self.assertEqual(inconsistent.status, "requires_user_decision")
            self.assertTrue(any(issue.code == "DATA_TREATMENT_COHORT_MISMATCH" for issue in inconsistent.issues))

    def test_psm_preflight_requests_design_choice_for_repeated_analysis_units(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "panel.csv"
            pd.DataFrame({
                "region": ["a", "a", "b", "b"],
                "year": [2020, 2021, 2020, 2021],
                "outcome": [1.0, 2.0, 1.5, 2.5],
                "treated": [0, 1, 0, 1],
                "x": [3.0, 4.0, 5.0, 6.0],
            }).to_csv(path, index=False)

            result = preflight_method(
                "psm_matching",
                str(path),
                {
                    "dependentVar": "outcome",
                    "treatmentVar": "treated",
                    "analysisUnitVar": "region",
                    "preTreatmentAggregation": "not_applicable",
                    "covariates": ["x"],
                },
            )

            self.assertFalse(result.executable)
            self.assertEqual(result.status, "requires_user_decision")
            self.assertTrue(any(item.code == "DATA_ANALYSIS_UNIT_NOT_UNIQUE" for item in result.issues))
            self.assertTrue(result.repair_plan)
            self.assertEqual(list(Path(directory).glob("*")), [path])

    def test_psm_preflight_rejects_missing_analysis_unit_identifiers(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "cross_section.csv"
            pd.DataFrame({
                "region": [None, "b", "c"],
                "outcome": [1.0, 2.0, 1.5],
                "treated": [0, 1, 0],
                "x": [3.0, 4.0, 5.0],
            }).to_csv(path, index=False)

            result = preflight_method(
                "psm_matching",
                str(path),
                {
                    "dependentVar": "outcome",
                    "treatmentVar": "treated",
                    "analysisUnitVar": "region",
                    "preTreatmentAggregation": "not_applicable",
                    "covariates": ["x"],
                },
            )

            self.assertFalse(result.executable)
            self.assertEqual(result.status, "requires_user_decision")
            self.assertTrue(any(item.code == "DATA_ANALYSIS_UNIT_MISSING" for item in result.issues))
            self.assertTrue(result.repair_plan)

    def test_rank_failure_is_reported_without_writing_an_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.csv"
            pd.DataFrame({"y": [1.0, 2.0, 3.0], "x": [1.0, 2.0, 3.0], "z": [2.0, 4.0, 6.0]}).to_csv(path, index=False)

            result = preflight_method(
                "ols_regression",
                str(path),
                {"dependentVar": "y", "treatmentVar": "x", "covariates": ["z"]},
            )

            self.assertFalse(result.executable)
            self.assertEqual(result.status, "requires_user_decision")
            self.assertTrue(any(item.code == "DESIGN_MATRIX_RANK_DEFICIENT" for item in result.issues))
            self.assertTrue(result.repair_plan)
            self.assertEqual(list(Path(directory).glob("*")), [path])

    def test_preflight_rejects_a_constant_model_regressor_even_when_it_is_the_only_regressor(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "constant_regressor.csv"
            pd.DataFrame({"outcome": [1.0, 3.0, 2.0, 5.0], "predictor": [1.0, 1.0, 1.0, 1.0]}).to_csv(path, index=False)

            result = preflight_method(
                "ols_regression",
                str(path),
                {"dependentVar": "outcome", "treatmentVar": "predictor", "covariates": []},
            )

            self.assertFalse(result.executable, result)
            self.assertEqual(result.status, "requires_user_decision")
            issue = next((item for item in result.issues if item.code == "DATA_MODEL_VARIABLE_CONSTANT"), None)
            self.assertIsNotNone(issue, result.issues)
            self.assertEqual(issue.evidence["columns"], ["predictor"])
            self.assertTrue(result.repair_plan)

    def test_hdfe_preflight_rejects_constant_fixed_effect_dimension(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "constant_fixed_effect.csv"
            pd.DataFrame({
                "outcome": [1.0, 2.0, 3.0, 5.0],
                "predictor": [0.0, 1.0, 2.0, 3.0],
                "unit": ["all", "all", "all", "all"],
            }).to_csv(path, index=False)

            result = preflight_method(
                "hdfe_regression",
                str(path),
                {
                    "dependentVar": "outcome",
                    "treatmentVar": "predictor",
                    "fixedEffects": ["unit"],
                    "covariates": [],
                },
            )

            self.assertFalse(result.executable, result)
            self.assertEqual(result.status, "requires_user_decision")
            issue = next((item for item in result.issues if item.code == "DATA_FIXED_EFFECT_NO_VARIATION"), None)
            self.assertIsNotNone(issue, result.issues)
            self.assertEqual(issue.evidence["columns"], ["unit"])
            self.assertTrue(result.repair_plan)

    def test_rank_failure_reports_auditable_exact_linear_relationship(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "composite_index_components.csv"
            frame = pd.DataFrame({
                "investment": [1.0, 2.0, 1.0, 3.0, 2.0, 4.0],
                "insurance": [1.0, 0.0, 2.0, 1.0, 3.0, 0.0],
                "bond": [0.0, 1.0, 0.0, 2.0, 1.0, 3.0],
                "support": [2.0, 1.0, 3.0, 0.0, 2.0, 1.0],
                "outcome": [4.0, 3.0, 5.0, 8.0, 4.0, 7.0],
            })
            frame["credit"] = frame[["investment", "insurance", "bond", "support"]].sum(axis=1)
            frame.to_csv(path, index=False)

            result = preflight_method(
                "ols_regression",
                str(path),
                {
                    "dependentVar": "outcome",
                    "treatmentVar": "credit",
                    "covariates": ["investment", "insurance", "bond", "support"],
                },
            )

            issue = next((item for item in result.issues if item.code == "DESIGN_MATRIX_RANK_DEFICIENT"), None)
            self.assertIsNotNone(issue, result.issues)
            self.assertIn("credit = investment + insurance + bond + support", issue.summary_zh)
            relation = issue.evidence["linearDependency"]
            self.assertEqual(relation["dependentColumn"], "credit")
            self.assertEqual(
                [term["column"] for term in relation["terms"]],
                ["investment", "insurance", "bond", "support"],
            )
            self.assertLessEqual(relation["maxAbsResidual"], 1e-10)

    def test_ready_preflight_preserves_normalized_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data.csv"
            pd.DataFrame({"y": [1.0, 2.0, 3.0], "x": [0.0, 1.0, 0.0]}).to_csv(path, index=False)

            result = preflight_method(
                "ols_regression",
                str(path),
                {"dependentVar": "y", "treatmentVar": "x", "covariates": [], "covariance": "HC1"},
            )

            self.assertTrue(result.executable)
            self.assertEqual(result.status, "ready")
            self.assertEqual(result.normalized_arguments["covariance"], "HC1")


if __name__ == "__main__":
    unittest.main()
