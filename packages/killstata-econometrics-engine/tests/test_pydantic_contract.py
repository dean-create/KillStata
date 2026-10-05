import unittest
from copy import deepcopy

from pydantic import BaseModel

from killstata_econometrics_engine.protocol import handle_request
from killstata_econometrics_engine.registry import METHODS


def undocumented_properties(schema, prefix=""):
    missing = []
    if not isinstance(schema, dict):
        return missing
    for name, prop in schema.get("properties", {}).items():
        current = f"{prefix}.{name}" if prefix else name
        if not prop.get("description"):
            missing.append(current)
        missing.extend(undocumented_properties(prop, current))
    for name, definition in schema.get("$defs", {}).items():
        missing.extend(undocumented_properties(definition, f"$defs.{name}"))
    if isinstance(schema.get("items"), dict):
        missing.extend(undocumented_properties(schema["items"], f"{prefix}[]"))
    for keyword in ("anyOf", "oneOf", "allOf"):
        for index, branch in enumerate(schema.get(keyword, [])):
            missing.extend(undocumented_properties(branch, f"{prefix}.{keyword}[{index}]"))
    return missing


class PydanticContractTests(unittest.TestCase):
    def test_event_study_never_treated_cohort_encoding_is_registry_owned_zero_only(self):
        arguments = {
            "dependentVar": "outcome",
            "treatmentVar": "treated",
            "entityVar": "unit",
            "timeVar": "year",
            "cohortVar": "first_treat",
            "clusterVar": "unit",
            "neverTreatedCohortValue": 0,
            "covariates": [],
        }

        accepted = handle_request({
            "protocol_version": 2, "request_id": "event-study-zero-sentinel", "operation": "validate",
            "payload": {"method_id": "did_event_study_saturated", "arguments": arguments},
        })
        self.assertTrue(accepted["ok"], accepted)
        self.assertEqual(accepted["result"]["arguments"]["neverTreatedCohortValue"], 0)

        for invalid in (1, True, "0"):
            with self.subTest(invalid=invalid):
                rejected = handle_request({
                    "protocol_version": 2, "request_id": "event-study-invalid-sentinel", "operation": "validate",
                    "payload": {
                        "method_id": "did_event_study_saturated",
                        "arguments": {**arguments, "neverTreatedCohortValue": invalid},
                    },
                })
                self.assertFalse(rejected["ok"], rejected)
                self.assertEqual(rejected["error"]["code"], "INVALID_ARGUMENT")

    def test_create_relative_time_schema_requires_named_columns_not_an_expression(self):
        runtime = {"datasetId": "dataset_a", "stageId": "stage_000", "outputPath": "/tmp/relative.parquet"}
        arguments = {
            "method": "create_relative_time",
            "columns": [],
            "options": {
                "entity_var": "unit",
                "time_var": "year",
                "cohort_var": "first_treat",
                "treatment_var": "treated",
                "output_column": "relative_time",
            },
        }

        accepted = handle_request({
            "protocol_version": 2, "request_id": "relative-time-valid", "operation": "validate",
            "payload": {"method_id": "data_preprocess", "arguments": arguments, "runtime": runtime},
        })
        self.assertTrue(accepted["ok"], accepted)

        for invalid_options in (
            {key: value for key, value in arguments["options"].items() if key != "treatment_var"},
            {**arguments["options"], "expression": "year - first_treat"},
        ):
            with self.subTest(invalid_options=invalid_options):
                response = handle_request({
                    "protocol_version": 2, "request_id": "relative-time-invalid", "operation": "validate",
                    "payload": {
                        "method_id": "data_preprocess",
                        "arguments": {**arguments, "options": invalid_options},
                        "runtime": runtime,
                    },
                })
                self.assertFalse(response["ok"], response)
                self.assertEqual(response["error"]["code"], "INVALID_ARGUMENT")

    def test_rdd_requires_an_explicit_cutoff_for_both_designs(self):
        cases = [
            ("rdd_sharp", {"dependentVar": "vote", "runningVar": "margin"}),
            ("rdd_fuzzy", {"dependentVar": "vote", "runningVar": "margin", "fuzzyVar": "takeup"}),
        ]
        for method_id, arguments in cases:
            with self.subTest(method=method_id):
                rejected = handle_request({
                    "protocol_version": 2, "request_id": f"{method_id}-missing-cutoff", "operation": "validate",
                    "payload": {"method_id": method_id, "arguments": arguments},
                })
                self.assertFalse(rejected["ok"], rejected)
                self.assertEqual(rejected["error"]["code"], "INVALID_ARGUMENT")
                self.assertIn("cutoff", rejected["error"]["message_zh"])

    def test_rdd_designs_accept_a_declared_cluster_identifier(self):
        cases = [
            ("rdd_sharp", {"dependentVar": "vote", "runningVar": "margin", "cutoff": 0}),
            ("rdd_fuzzy", {"dependentVar": "vote", "runningVar": "margin", "fuzzyVar": "takeup", "cutoff": 0}),
        ]
        for method_id, arguments in cases:
            with self.subTest(method=method_id):
                response = handle_request({
                    "protocol_version": 2,
                    "request_id": f"{method_id}-cluster-id",
                    "operation": "validate",
                    "payload": {
                        "method_id": method_id,
                        "arguments": {**arguments, "clusterVar": "school_id"},
                    },
                })
                self.assertTrue(response["ok"], response)
                self.assertEqual(response["result"]["arguments"]["clusterVar"], "school_id")

    def test_minmax_range_accepts_json_array_and_rejects_invalid_values_at_validate(self):
        arguments = {"method": "minmax_scale", "columns": ["x"], "options": {"feature_range": [0, 1]}}
        runtime = {"datasetId": "dataset_a", "stageId": "stage_000", "outputPath": "/tmp/unused.parquet"}

        def validate(value):
            return handle_request({
                "protocol_version": 2, "request_id": "minmax-range", "operation": "validate",
                "payload": {"method_id": "data_preprocess", "arguments": value, "runtime": runtime},
            })

        accepted = validate(arguments)
        self.assertTrue(accepted["ok"], accepted)
        self.assertEqual(accepted["result"]["arguments"]["options"]["feature_range"], [0.0, 1.0])
        for invalid in ([1, 1], [2, 1], [0], [0, 1, 2], [False, 1], [0, "1"], [0, float("inf")]):
            with self.subTest(invalid=invalid):
                response = validate({**arguments, "options": {"feature_range": invalid}})
                self.assertFalse(response["ok"], response)
                self.assertEqual(response["error"]["code"], "INVALID_ARGUMENT")
                self.assertIn("feature_range", response["error"]["message_zh"])

    def test_coerce_numeric_requires_explicit_missing_tokens_and_rejects_unrelated_options(self):
        runtime = {"datasetId": "dataset_a", "stageId": "stage_000", "outputPath": "/tmp/numeric.parquet"}
        arguments = {
            "method": "coerce_numeric",
            "columns": ["vote"],
            "options": {"missing_tokens": ["NA"]},
        }
        accepted = handle_request({
            "protocol_version": 2, "request_id": "coerce-numeric-valid", "operation": "validate",
            "payload": {"method_id": "data_preprocess", "arguments": arguments, "runtime": runtime},
        })
        self.assertTrue(accepted["ok"], accepted)
        self.assertEqual(accepted["result"]["arguments"]["options"]["missing_tokens"], ["NA"])
        description = METHODS["data_preprocess"].input_schema["$defs"]["DataPreprocessOptions"]["properties"]["missing_tokens"]["description"]
        self.assertIn("精确", description)
        self.assertIn("确认", description)

        for options in ({"missing_tokens": [""]}, {"missing_tokens": ["NA"], "lower": 0.01}):
            with self.subTest(options=options):
                rejected = handle_request({
                    "protocol_version": 2, "request_id": "coerce-numeric-invalid", "operation": "validate",
                    "payload": {
                        "method_id": "data_preprocess",
                        "arguments": {**arguments, "options": options},
                        "runtime": runtime,
                    },
                })
                self.assertFalse(rejected["ok"], rejected)
                self.assertEqual(rejected["error"]["code"], "INVALID_ARGUMENT")

    def test_topsis_requires_an_explicit_weight_source(self):
        arguments = {
            "method": "topsis", "idColumns": ["id"],
            "indicators": [{"column": "x", "direction": "benefit"}, {"column": "y", "direction": "cost"}],
            "scope": "global",
        }
        runtime = {"datasetId": "dataset_a", "stageId": "stage_000"}
        missing = handle_request({
            "protocol_version": 2, "request_id": "topsis-no-weights", "operation": "validate",
            "payload": {"method_id": "composite_evaluation", "arguments": arguments, "runtime": runtime},
        })
        self.assertFalse(missing["ok"], missing)
        self.assertEqual(missing["error"]["code"], "INVALID_ARGUMENT")
        self.assertIn("weightSource", missing["error"]["message_zh"])
        explicit = handle_request({
            "protocol_version": 2, "request_id": "topsis-equal-weights", "operation": "validate",
            "payload": {"method_id": "composite_evaluation", "arguments": {**arguments, "weightSource": "equal"}, "runtime": runtime},
        })
        self.assertTrue(explicit["ok"], explicit)

    def test_manual_weights_reject_invalid_values_during_validate(self):
        arguments = {
            "method": "topsis", "idColumns": ["id"],
            "indicators": [{"column": "x", "direction": "benefit"}, {"column": "y", "direction": "cost"}],
            "scope": "global", "weightSource": "manual",
        }
        runtime = {"datasetId": "dataset_a", "stageId": "stage_000"}
        for weights in (
            {"x": True, "y": 0.0}, {"x": "0.5", "y": 0.5},
            {"x": float("nan"), "y": 0.5}, {"x": -0.1, "y": 1.1},
            {"x": 0.5, "y": 0.4},
        ):
            with self.subTest(weights=weights):
                response = handle_request({
                    "protocol_version": 2, "request_id": "topsis-bad-manual", "operation": "validate",
                    "payload": {"method_id": "composite_evaluation", "arguments": {**arguments, "manualWeights": weights}, "runtime": runtime},
                })
                self.assertFalse(response["ok"], response)
                self.assertEqual(response["error"]["code"], "INVALID_ARGUMENT")
                self.assertIn("manualWeights", response["error"]["message_zh"])

    def test_filter_ordered_comparison_rejects_boolean_threshold(self):
        response = handle_request({
            "protocol_version": 2, "request_id": "filter-boolean-threshold", "operation": "validate",
            "payload": {
                "method_id": "data_preprocess",
                "arguments": {"method": "filter", "options": {"rules": [{"column": "income", "operator": "gt", "value": True}]}},
                "runtime": {"datasetId": "dataset_a", "stageId": "stage_000", "outputPath": "/tmp/filtered.parquet"},
            },
        })
        self.assertFalse(response["ok"], response)
        self.assertEqual(response["error"]["code"], "INVALID_ARGUMENT")
        self.assertIn("value", response["error"]["message_zh"])

    def test_filter_rules_require_the_value_shape_used_by_the_operator(self):
        runtime = {"datasetId": "dataset_a", "stageId": "stage_000", "outputPath": "/tmp/filter-shape.parquet"}
        for rule in (
            {"column": "income", "operator": "not_in"},
            {"column": "income", "operator": "not_in", "values": []},
            {"column": "income", "operator": "eq"},
            {"column": "income", "operator": "eq", "values": [1]},
        ):
            with self.subTest(rule=rule):
                response = handle_request({
                    "protocol_version": 2, "request_id": "filter-missing-value-shape", "operation": "validate",
                    "payload": {
                        "method_id": "data_preprocess",
                        "arguments": {"method": "filter", "options": {"rules": [rule]}},
                        "runtime": runtime,
                    },
                })
                self.assertFalse(response["ok"], response)
                self.assertEqual(response["error"]["code"], "INVALID_ARGUMENT")
                self.assertIn("value", response["error"]["message_zh"])

    def test_cross_language_capability_schemas_are_python_owned_and_hide_runtime_lineage(self):
        expected_fields = {
            "data_import": ("action", {"import", "profile", "frequency", "correlation", "validate", "healthcheck", "export", "rollback"}),
            "data_preprocess": ("method", {"listwise_deletion", "mean_impute", "median_impute", "knn_impute", "zscore_detect", "iqr_detect", "winsorize", "trim", "zscore_standardize", "minmax_scale", "robust_scale", "log_transform", "boxcox_transform", "yeojohnson_transform", "fill_constant", "forward_fill", "backward_fill", "linear_interpolate", "group_linear_interpolate", "regression_impute", "create_dummies", "combine_columns", "filter", "create_column", "create_relative_time", "coerce_numeric"}),
            "composite_evaluation": ("method", {"entropy_weight", "topsis"}),
        }
        runtime_fields = {
            "data_import": {"datasetId", "stageId", "inputPath", "outputPath", "runId", "branch"},
            "data_preprocess": {"datasetId", "stageId", "outputPath"},
            "composite_evaluation": {"datasetId", "stageId", "expectedDataFingerprint"},
            "econometrics_recommend": {"datasetId", "stageId"},
            "heterogeneity_runner": {"datasetId", "stageId", "expectedDataFingerprint", "runId", "branch", "outputDir", "baselineResultDir", "directResultPath"},
        }
        for method_id, hidden in runtime_fields.items():
            with self.subTest(method_id=method_id):
                spec = METHODS[method_id]
                descriptor = spec.to_descriptor()
                self.assertTrue(hidden.issubset(set(spec.runtime_injected_fields)), spec.runtime_injected_fields)
                properties = descriptor["input_schema"].get("properties", {})
                self.assertTrue(hidden.isdisjoint(properties), (method_id, hidden & set(properties)))
                self.assertIn("适用：", descriptor["description"])
                self.assertIn("不适用：", descriptor["description"])
        for method_id, (field, values) in expected_fields.items():
            with self.subTest(method_id=method_id):
                schema = METHODS[method_id].to_descriptor()["input_schema"]
                self.assertEqual(set(schema["properties"][field]["enum"]), values)

    def test_preprocess_runtime_output_path_is_required_by_execution_but_hidden_from_model(self):
        spec = METHODS["data_preprocess"]
        arguments = spec.input_model.model_validate({
            "datasetId": "dataset_current",
            "stageId": "stage_000",
            "outputPath": "/controlled/stage.parquet",
            "method": "winsorize",
            "columns": ["income"],
            "options": {"lower": 0.01, "upper": 0.01},
        })
        self.assertEqual(arguments.outputPath, "/controlled/stage.parquet")
        properties = spec.input_schema.get("properties", {})
        self.assertNotIn("outputPath", properties)

    def test_pydantic_schema_explains_parameter_semantics_that_models_must_not_guess(self):
        preprocess_schema = METHODS["data_preprocess"].input_schema
        upper_description = preprocess_schema["$defs"]["DataPreprocessOptions"]["properties"]["upper"]["description"]
        self.assertIn("不是填上分位点 0.99", upper_description)

        composite_schema = METHODS["composite_evaluation"].input_schema
        method_description = composite_schema["properties"]["method"]["description"]
        weight_description = composite_schema["properties"]["weightSource"]["description"]
        self.assertIn("熵权 TOPSIS", method_description)
        self.assertIn("必须明确", weight_description)
        self.assertIn("必须为 entropy", weight_description)

    def test_wls_schema_explains_precision_weights_and_exposes_supported_covariance(self):
        spec = METHODS["wls_regression"]
        schema = spec.input_schema
        weights_description = schema["properties"]["weightsVar"]["description"]

        self.assertIn("逆误差方差", weights_description)
        self.assertIn("抽样权重", weights_description)
        self.assertIn("频数权重", weights_description)
        self.assertIn("自行构造", spec.do_not_use_when_zh)
        self.assertIn("covariance", schema["properties"])
        self.assertIn("HC1", schema["properties"]["covariance"]["description"])

        arguments = spec.input_model.model_validate({
            "dependentVar": "yi",
            "treatmentVar": "ablat",
            "weightsVar": "precision_weight",
            "covariates": [],
            "covariance": "robust",
        })
        self.assertEqual(arguments.covariance, "robust")

    def test_every_python_model_visible_parameter_has_a_description(self):
        for method_id, spec in METHODS.items():
            with self.subTest(method_id=method_id):
                self.assertEqual(undocumented_properties(spec.input_schema), [])

    def test_complex_python_capabilities_have_valid_registry_owned_examples(self):
        runtime_values = {
            "datasetId": "dataset_example",
            "stageId": "stage_000",
            "expectedDataFingerprint": f"sha256:{'a' * 64}",
            "inputPath": "/controlled/input.csv",
            "outputPath": "/controlled/output.parquet",
            "runId": "run_example",
            "branch": "main",
            "outputDir": "/controlled/output",
            "baselineResultDir": "/controlled/baseline",
            "directResultPath": "/controlled/baseline/results.json",
        }
        for method_id in (
            "data_import", "data_preprocess", "composite_evaluation", "econometrics_recommend",
            "psm_matching", "did_static", "did2s", "iv_2sls", "iv_test", "rdd_sharp",
            "rdd_fuzzy", "wls_regression", "heterogeneity_runner",
        ):
            with self.subTest(method_id=method_id):
                spec = METHODS[method_id]
                examples = spec.input_schema.get("examples", [])
                self.assertGreaterEqual(len(examples), 1)
                self.assertLessEqual(len(examples), 2)
                runtime = {field: runtime_values[field] for field in spec.runtime_injected_fields}
                for index, example in enumerate(examples):
                    response = handle_request({
                        "protocol_version": 2,
                        "request_id": f"example-{method_id}-{index}",
                        "operation": "validate",
                        "payload": {"method_id": method_id, "arguments": example, "runtime": runtime},
                    })
                    self.assertTrue(response["ok"], response)

    def test_cross_language_capability_arguments_enforce_nested_research_contracts(self):
        preprocess = METHODS["data_preprocess"].input_model
        self.assertEqual(preprocess.model_validate({
            "datasetId": "dataset_a", "stageId": "stage_000", "outputPath": "/tmp/result.parquet", "method": "winsorize",
            "columns": ["income"], "options": {"lower": 0.01, "upper": 0.01},
        }).method, "winsorize")
        for invalid in (
            {"datasetId": "dataset_a", "stageId": "stage_000", "outputPath": "/tmp/result.parquet", "method": "not_admitted", "columns": ["income"], "options": {}},
            {"datasetId": "dataset_a", "stageId": "stage_000", "outputPath": "/tmp/result.parquet", "method": "winsorize", "columns": ["income"], "options": {"lower": 0.8, "upper": 0.3}},
        ):
            with self.subTest(invalid=invalid):
                with self.assertRaises(Exception):
                    preprocess.model_validate(invalid)

        mcda = METHODS["composite_evaluation"].input_model
        with self.assertRaises(Exception):
            mcda.model_validate({
                "datasetId": "dataset_a", "stageId": "stage_000", "method": "topsis",
                "idColumns": ["id"], "indicators": [{"column": "x", "direction": "benefit"}, {"column": "y", "direction": "cost"}],
                "scope": "global", "groupColumns": ["region"],
            })

        data_import = METHODS["data_import"].input_model
        with self.assertRaises(Exception):
            data_import.model_validate({"action": "import"})
        with self.assertRaises(Exception):
            data_import.model_validate({"action": "profile", "datasetId": "d", "stageId": "s", "sheetPolicy": {"mode": "named_sheet"}})

    def test_method_legacy_aliases_are_normalized_by_registry_models(self):
        ols = METHODS["ols_regression"].input_model.model_validate({
            "dependent_var": "y",
            "independent_vars": ["x"],
            "covariates": "",
            "robust_se": True,
            "confidence_level": 0.95,
        })
        self.assertEqual(ols.dependentVar, "y")
        self.assertEqual(ols.treatmentVar, "x")
        self.assertEqual(ols.covariates, [])
        self.assertEqual(ols.covariance, "HC1")

        hdfe = METHODS["hdfe_regression"].input_model.model_validate({
            "dependentVar": "y",
            "treatmentVar": "x",
            "entityVar": "province",
            "timeVar": "year",
            "clusterVar": "province",
            "covariance": "clustered",
        })
        self.assertEqual(hdfe.fixedEffects, ["province", "year"])
        self.assertEqual(hdfe.clusterVars, ["province"])
        self.assertEqual(hdfe.covariance, "CRV1")

        panel = METHODS["panel_fe_regression"].input_model.model_validate({
            "dependent_var": "y",
            "treatment_var": "x",
            "entity_var": "province",
            "time_var": "year",
            "cluster_var": "province",
            "covariance": "cluster",
        })
        self.assertEqual(panel.entityVar, "province")
        self.assertEqual(panel.timeVar, "year")
        self.assertEqual(panel.covariance, "clustered")

        ols_aliases = set(METHODS["ols_regression"].to_descriptor()["accepted_input_aliases"])
        self.assertTrue({"dependent_var", "independent_vars", "robust_se", "confidence_level"}.issubset(ols_aliases))
        hdfe_aliases = set(METHODS["hdfe_regression"].to_descriptor()["accepted_input_aliases"])
        self.assertTrue({"entityVar", "timeVar", "clusterVar"}.issubset(hdfe_aliases))

    def test_method_specific_defaults_match_runner_contracts(self):
        self.assertEqual(METHODS["quantile_regression"].input_model.model_validate({"dependentVar": "y", "treatmentVar": "x"}).quantiles, [0.25, 0.5, 0.75])
        self.assertEqual(METHODS["quantile_regression"].input_model.model_validate({"dependentVar": "y", "treatmentVar": "x"}).covariance, "robust")
        self.assertEqual(METHODS["logit_regression"].input_model.model_validate({"dependentVar": "y", "treatmentVar": "x"}).covariance, "nonrobust")
        self.assertEqual(METHODS["robust_regression"].input_model.model_validate({"dependentVar": "y", "treatmentVar": "x"}).covariance, "robust")
        self.assertEqual(METHODS["robust_regression"].input_model.model_validate({"dependentVar": "y", "treatmentVar": "x", "psi": "hampel"}).psi, "hampel")

    def test_count_models_reject_covariance_values_the_runner_does_not_support(self):
        response = handle_request({
            "protocol_version": 1,
            "request_id": "count-covariance-contract-1",
            "operation": "execute",
            "payload": {
                "method_id": "poisson_regression",
                "data_path": "/tmp/unused.csv",
                "output_dir": "/tmp/unused-output",
                "arguments": {"dependentVar": "y", "treatmentVar": "x", "covariance": "HC1"},
            },
        })
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "INVALID_ARGUMENT")
        self.assertEqual(response["error"]["field"], "covariance")

    def test_every_method_uses_pydantic_model_as_schema_source(self):
        for method_id, spec in METHODS.items():
            with self.subTest(method_id=method_id):
                self.assertTrue(issubclass(spec.input_model, BaseModel))
                expected = deepcopy(spec.input_model.model_json_schema())
                for field in spec.runtime_injected_fields:
                    expected.get("properties", {}).pop(field, None)
                if isinstance(expected.get("required"), list):
                    expected["required"] = [
                        field for field in expected["required"]
                        if field not in spec.runtime_injected_fields
                    ]
                if spec.input_examples:
                    expected["examples"] = deepcopy(list(spec.input_examples))
                self.assertEqual(spec.input_schema, expected)

    def test_nested_argument_type_error_is_rejected_before_file_or_algorithm(self):
        response = handle_request({
            "protocol_version": 1,
            "request_id": "pydantic-nested-error-1",
            "operation": "execute",
            "payload": {
                "method_id": "quantile_regression",
                "data_path": "/tmp/this-file-does-not-exist.csv",
                "output_dir": "/tmp/killstata-pydantic-test",
                "arguments": {
                    "dependentVar": "y",
                    "treatmentVar": "x",
                    "quantiles": ["0.5"],
                },
            },
        })
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "INVALID_ARGUMENT")
        self.assertEqual(response["error"]["field"], "quantiles")
        self.assertIn("quantiles", response["error"]["message_zh"])

    def test_enum_error_is_chinese_and_keeps_allowed_values(self):
        response = handle_request({
            "protocol_version": 1,
            "request_id": "pydantic-enum-error-1",
            "operation": "execute",
            "payload": {
                "method_id": "ols_regression",
                "data_path": "/tmp/this-file-does-not-exist.csv",
                "output_dir": "/tmp/killstata-pydantic-test",
                "arguments": {
                    "dependentVar": "y",
                    "treatmentVar": "x",
                    "covariance": "invalid",
                },
            },
        })
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["field"], "covariance")
        self.assertIn("允许值为", response["error"]["message_zh"])
        self.assertIn("nonrobust、robust、HC1、HC2、HC3", response["error"]["message_zh"])
        self.assertNotIn(" or ", response["error"]["message_zh"])


if __name__ == "__main__":
    unittest.main()
