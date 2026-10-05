import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from killstata_econometrics_engine.protocol import handle_request
from killstata_econometrics_engine.registry import METHODS


class EngineProtocolTests(unittest.TestCase):
    def test_every_registered_method_has_one_callable_handler(self):
        self.assertEqual(len(METHODS), 30)
        self.assertTrue(all(callable(spec.handler) for spec in METHODS.values()))

    def test_ols_schema_does_not_expose_or_require_harness_lineage(self):
        described = handle_request({
            "protocol_version": 1,
            "request_id": "describe-lineage-1",
            "operation": "describe",
            "payload": {"method_id": "ols_regression"},
        })
        self.assertTrue(described["ok"], described)
        result = described["result"]
        self.assertEqual(result["runtime_injected_fields"], [])
        properties = result["input_schema"]["properties"]
        self.assertNotIn("datasetId", properties)
        self.assertNotIn("stageId", properties)
        self.assertIn("dependentVar", properties)
        self.assertIn("treatmentVar", properties)

    def test_recommend_schema_hides_harness_owned_dataset_lineage(self):
        described = handle_request({
            "protocol_version": 1,
            "request_id": "describe-recommend-lineage-1",
            "operation": "describe",
            "payload": {"method_id": "econometrics_recommend"},
        })
        self.assertTrue(described["ok"], described)
        result = described["result"]
        self.assertEqual(result["runtime_injected_fields"], ["datasetId", "stageId"])
        properties = result["input_schema"]["properties"]
        self.assertNotIn("datasetId", properties)
        self.assertNotIn("stageId", properties)
        self.assertIn("dependentVar", properties)
        self.assertIn("treatmentVar", properties)

    def test_validate_operation_uses_registry_pydantic_without_executing_method(self):
        response = handle_request({
            "protocol_version": 2,
            "request_id": "validate-recommend-1",
            "operation": "validate",
            "payload": {
                "method_id": "econometrics_recommend",
                "arguments": {
                    "dependentVar": "创新指数",
                    "treatmentVar": "高质量发展指数",
                },
                "runtime": {"datasetId": "dataset_current", "stageId": "stage_000"},
            },
        })
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["result"]["arguments"]["dependentVar"], "创新指数")

        invalid = handle_request({
            "protocol_version": 2,
            "request_id": "validate-recommend-bad-1",
            "operation": "validate",
            "payload": {
                "method_id": "econometrics_recommend",
                "arguments": {"dependentVar": 123, "unknown": True},
                "runtime": {"datasetId": "dataset_current", "stageId": "stage_000"},
            },
        })
        self.assertFalse(invalid["ok"])
        self.assertEqual(invalid["error"]["code"], "INVALID_ARGUMENT")

    def test_validate_injects_harness_runtime_fields_separately_from_model_arguments(self):
        response = handle_request({
            "protocol_version": 2,
            "request_id": "validate-runtime-lineage-1",
            "operation": "validate",
            "payload": {
                "method_id": "econometrics_recommend",
                "arguments": {
                    "dependentVar": "创新指数",
                    "treatmentVar": "高质量发展指数",
                },
                "runtime": {
                    "datasetId": "dataset_current",
                    "stageId": "stage_000",
                },
            },
        })
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["result"]["arguments"], {
            "dependentVar": "创新指数",
            "treatmentVar": "高质量发展指数",
        })

        forged = handle_request({
            "protocol_version": 2,
            "request_id": "validate-forged-lineage-1",
            "operation": "validate",
            "payload": {
                "method_id": "econometrics_recommend",
                "arguments": {
                    "datasetId": "dataset_forged",
                    "stageId": "stage_forged",
                    "dependentVar": "创新指数",
                },
                "runtime": {
                    "datasetId": "dataset_current",
                    "stageId": "stage_000",
                },
            },
        })
        self.assertFalse(forged["ok"], forged)
        self.assertEqual(forged["error"]["code"], "INVALID_ARGUMENT")
        self.assertIn("runtime", forged["error"]["message_zh"])

    def test_list_size_validation_error_is_actionable_chinese(self):
        response = handle_request({
            "protocol_version": 2,
            "request_id": "frequency-group-size-1",
            "operation": "validate",
            "payload": {
                "method_id": "data_import",
                "arguments": {"action": "frequency", "groupBy": ["province", "year", "district"]},
                "runtime": {
                    "inputPath": "/controlled/current.parquet",
                    "datasetId": "dataset_current",
                    "stageId": "stage_000",
                },
            },
        })
        self.assertFalse(response["ok"], response)
        self.assertIn("groupBy", response["error"]["message_zh"])
        self.assertIn("最多允许 2 项", response["error"]["message_zh"])

    def test_heterogeneity_runner_has_a_strict_registry_contract(self):
        spec = METHODS["heterogeneity_runner"]
        valid = spec.input_model.model_validate({
            "methodFamily": "fe",
            "dependentVar": "y",
            "treatmentVar": "x",
            "heterogeneityVars": ["region"],
        })
        self.assertEqual(valid.methodFamily, "fe")
        with self.assertRaises(Exception):
            spec.input_model.model_validate({
                "methodFamily": "iv",
                "dependentVar": "y",
                "treatmentVar": "x",
            })

    def test_jsonl_health_search_describe_and_invalid_method(self):
        request_lines = [
            {"protocol_version": 1, "request_id": "health-1", "operation": "health", "payload": {}},
            {"protocol_version": 1, "request_id": "search-1", "operation": "search", "payload": {"query": "普通最小二乘", "limit": 3}},
            {"protocol_version": 1, "request_id": "describe-1", "operation": "describe", "payload": {"method_id": "ols_regression"}},
            {"protocol_version": 1, "request_id": "bad-1", "operation": "describe", "payload": {"method_id": "missing_method"}},
        ]
        process = subprocess.run(
            [sys.executable, "-m", "killstata_econometrics_engine"],
            input="\n".join(json.dumps(item, ensure_ascii=False) for item in request_lines) + "\n",
            text=True,
            capture_output=True,
            env={
                **os.environ,
                "PYTHONPATH": str(Path(__file__).parents[1] / "src"),
            },
            check=False,
        )

        self.assertEqual(process.returncode, 0, process.stderr)
        responses = [json.loads(line) for line in process.stdout.splitlines() if line.strip()]
        self.assertEqual([item["request_id"] for item in responses], ["health-1", "search-1", "describe-1", "bad-1"])
        self.assertTrue(responses[0]["ok"])
        self.assertEqual(responses[0]["result"]["registry_version"], 2)
        self.assertTrue(responses[1]["ok"])
        self.assertEqual(responses[1]["result"]["methods"][0]["method_id"], "ols_regression")
        self.assertTrue(responses[2]["ok"])
        self.assertEqual(responses[2]["result"]["method_id"], "ols_regression")
        self.assertIn("input_schema", responses[2]["result"])
        self.assertFalse(responses[3]["ok"])
        self.assertEqual(responses[3]["error"]["code"], "METHOD_NOT_FOUND")

    def test_jsonl_validation_error_with_exception_context_stays_strict_json(self):
        request = {
            "protocol_version": 2,
            "request_id": "validation-error-json-1",
            "operation": "validate",
            "payload": {
                "method_id": "data_import",
                "arguments": {"action": "profile"},
            },
        }
        process = subprocess.run(
            [sys.executable, "-m", "killstata_econometrics_engine"],
            input=json.dumps(request) + "\n",
            text=True,
            capture_output=True,
            env={**os.environ, "PYTHONPATH": str(Path(__file__).parents[1] / "src")},
            check=False,
        )

        self.assertEqual(process.returncode, 0, process.stderr)
        response = json.loads(process.stdout)
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "INVALID_ARGUMENT")
        validation_error = response["error"]["details"]["validation_errors"][0]
        self.assertIsInstance(validation_error["ctx"]["error"], str)

    def test_profile_response_is_strict_json_for_typescript_json_parse(self):
        with __import__("tempfile").TemporaryDirectory() as directory:
            data_path = Path(directory) / "data.csv"
            data_path.write_text("entity,y\nA,1\nB,\n", encoding="utf-8")
            request = {
                "protocol_version": 1,
                "request_id": "strict-json-1",
                "operation": "execute",
                "payload": {
                    "method_id": "data_import",
                    "data_path": str(data_path),
                    "output_dir": str(Path(directory) / "result"),
                    "arguments": {"action": "profile"},
                    "runtime": {
                        "inputPath": str(data_path),
                        "outputPath": str(Path(directory) / "result" / "profile.xlsx"),
                        "datasetId": "dataset_strict_json",
                        "stageId": "stage_000",
                    },
                },
            }
            process = subprocess.run(
                [sys.executable, "-m", "killstata_econometrics_engine"],
                input=json.dumps(request) + "\n",
                text=True,
                capture_output=True,
                env={
                    **os.environ,
                    "PYTHONPATH": str(Path(__file__).parents[1] / "src"),
                    "KILLSTATA_ENGINE_METHOD_ROOT": str(Path(__file__).parents[2] / "killstata-econometrics-engine" / "python"),
                },
                check=False,
            )

            self.assertEqual(process.returncode, 0, process.stderr)

            def reject_constant(value):
                raise AssertionError(f"strict JSON rejected non-finite value: {value}")

            response = json.loads(process.stdout, parse_constant=reject_constant)
            self.assertTrue(response["ok"], response)

    def test_execute_can_emit_ordered_progress_frames_before_terminal_result(self):
        with __import__("tempfile").TemporaryDirectory() as directory:
            data_path = Path(directory) / "data.csv"
            data_path.write_text("entity,y\nA,1\nB,2\n", encoding="utf-8")
            progress = []
            response = handle_request(
                {
                    "protocol_version": 2,
                    "request_id": "progress-1",
                    "operation": "execute",
                    "payload": {
                        "method_id": "data_import",
                        "data_path": str(data_path),
                        "output_dir": str(Path(directory) / "result"),
                        "arguments": {"action": "profile"},
                        "runtime": {
                            "inputPath": str(data_path),
                            "outputPath": str(Path(directory) / "result" / "profile.xlsx"),
                            "datasetId": "dataset_progress",
                            "stageId": "stage_000",
                        },
                    },
                },
                emit_progress=progress.append,
            )

            self.assertTrue(response["ok"], response)
            self.assertEqual(response["type"], "result")
            self.assertEqual([item["status"] for item in progress], ["running", "completed"])

    def test_execute_rejects_field_type_and_enum_errors_before_algorithm(self):
        response = handle_request({
            "protocol_version": 1,
            "request_id": "bad-argument-1",
            "operation": "execute",
            "payload": {
                "method_id": "ols_regression",
                "data_path": "/tmp/not-read.xlsx",
                "output_dir": "/tmp/killstata-engine-result",
                "arguments": {
                    "dependentVar": "y",
                    "treatmentVar": "x",
                    "covariates": [],
                    "covariance": "unsupported",
                },
            },
        })
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "INVALID_ARGUMENT")
        self.assertEqual(response["error"]["field"], "covariance")

    def test_execute_rejects_missing_and_unknown_method_fields_before_algorithm(self):
        base = {
            "protocol_version": 1,
            "request_id": "bad-schema-1",
            "operation": "execute",
            "payload": {
                "method_id": "ols_regression",
                "data_path": "/tmp/not-read.xlsx",
                "output_dir": "/tmp/killstata-engine-result",
                "arguments": {
                    "dependentVar": "y",
                    "covariates": [],
                    "covariance": "HC1",
                },
            },
        }
        missing = handle_request(base)
        self.assertFalse(missing["ok"])
        self.assertEqual(missing["error"]["field"], "treatmentVar")

        unknown = handle_request({
            **base,
            "request_id": "bad-schema-2",
            "payload": {
                **base["payload"],
                "arguments": {
                    "dependentVar": "y",
                    "treatmentVar": "x",
                    "covariates": [],
                    "unexpected": True,
                },
            },
        })
        self.assertFalse(unknown["ok"])
        self.assertEqual(unknown["error"]["field"], "unexpected")

    def test_execute_rejects_harness_lineage_inside_method_arguments(self):
        response = handle_request({
            "protocol_version": 1,
            "request_id": "bad-lineage-1",
            "operation": "execute",
            "payload": {
                "method_id": "ols_regression",
                "data_path": "/tmp/not-read.xlsx",
                "output_dir": "/tmp/killstata-engine-result",
                "arguments": {
                    "datasetId": "dataset_stale",
                    "stageId": "stage_stale",
                    "dependentVar": "y",
                    "treatmentVar": "x",
                },
            },
        })
        self.assertFalse(response["ok"])
        self.assertEqual(response["error"]["code"], "INVALID_ARGUMENT")
        self.assertEqual(response["error"]["field"], "datasetId")


if __name__ == "__main__":
    unittest.main()
