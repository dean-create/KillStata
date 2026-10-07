import csv
import json
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import pandas as pd
import numpy as np
import statsmodels.api as sm
from statsmodels.stats.outliers_influence import variance_inflation_factor

from killstata_econometrics_engine import protocol as engine_protocol
from killstata_econometrics_engine.diagnosis import content_fingerprint
from killstata_econometrics_engine.protocol import handle_request as _handle_request


def _frame_for_fingerprint(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix == ".parquet":
        return pd.read_parquet(path)
    if suffix in {".xlsx", ".xls"}:
        return pd.read_excel(path)
    return pd.read_csv(path)


def handle_request(request, **kwargs):
    """Mimic the TypeScript Harness injecting the active data diagnosis into capabilities."""
    payload = request.get("payload")
    if isinstance(payload, dict) and payload.get("method_id") in {"heterogeneity_runner", "composite_evaluation"}:
        runtime = payload.setdefault("runtime", {})
        if isinstance(runtime, dict) and "expectedDataFingerprint" not in runtime:
            runtime["expectedDataFingerprint"] = content_fingerprint(_frame_for_fingerprint(Path(payload["data_path"])))
    return _handle_request(request, **kwargs)


class EngineExecuteTests(unittest.TestCase):
    def test_direct_execute_rechecks_preflight_and_rejects_rank_deficiency_before_estimation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "rank-deficient.csv"
            output_dir = root / "ols-output"
            frame = pd.DataFrame({
                "y": [1.0, 2.0, 3.5, 5.0, 8.0],
                "x": [1.0, 2.0, 3.0, 4.0, 5.0],
                "x_copy": [1.0, 2.0, 3.0, 4.0, 5.0],
            })
            frame.to_csv(data_path, index=False)

            response = handle_request({
                "protocol_version": 2,
                "request_id": "execute-rank-deficient-direct",
                "operation": "execute",
                "payload": {
                    "method_id": "ols_regression",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "covariates": ["x_copy"],
                        "covariance": "HC1",
                    },
                },
            })

            self.assertFalse(response["ok"], response)
            self.assertEqual(response["error"]["code"], "DESIGN_MATRIX_RANK_DEFICIENT")
            self.assertEqual(
                response["error"]["details"]["preflight"]["issues"][0]["code"],
                "DESIGN_MATRIX_RANK_DEFICIENT",
            )
            self.assertIn("共线", response["error"]["message_zh"])
            self.assertFalse((output_dir / "results.json").exists())
            self.assertFalse((output_dir / "coefficients.csv").exists())

    def test_direct_execute_blocks_incompatible_glm_and_poisson_outcomes_before_estimation(self):
        cases = (
            (
                "logit_regression",
                {"outcome": [1.2, 2.4, 3.6, 4.8], "predictor": [0.0, 1.0, 2.0, 3.0]},
                {"dependentVar": "outcome", "treatmentVar": "predictor", "covariates": [], "covariance": "robust"},
                "BINARY_OUTCOME_NOT_01",
            ),
            (
                "poisson_regression",
                {"outcome": [-1.0, 0.0, 1.0, 2.0], "predictor": [0.0, 1.0, 2.0, 3.0]},
                {"dependentVar": "outcome", "treatmentVar": "predictor", "covariates": [], "covariance": "robust"},
                "POISSON_OUTCOME_NEGATIVE",
            ),
        )
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for index, (method_id, values, arguments, issue_code) in enumerate(cases):
                with self.subTest(method_id=method_id):
                    data_path = root / f"{method_id}.csv"
                    output_dir = root / f"{method_id}-output"
                    pd.DataFrame(values).to_csv(data_path, index=False)
                    response = handle_request({
                        "protocol_version": 2,
                        "request_id": f"execute-preflight-block-{index}",
                        "operation": "execute",
                        "payload": {
                            "method_id": method_id,
                            "data_path": str(data_path),
                            "output_dir": str(output_dir),
                            "arguments": arguments,
                        },
                    })

                    self.assertFalse(response["ok"], response)
                    self.assertEqual(response["error"]["code"], issue_code)
                    self.assertEqual(
                        response["error"]["details"]["preflight"]["issues"][0]["code"],
                        issue_code,
                    )
                    self.assertFalse((output_dir / "results.json").exists())
                    self.assertFalse((output_dir / "coefficients.csv").exists())

    def test_execute_rejects_data_fingerprint_changed_after_spec_preparation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "data.csv"
            output_dir = root / "ols-output"
            pd.DataFrame({
                "y": [1.0, 2.1, 3.8, 4.6, 7.2, 8.1],
                "x": [0.0, 1.0, 2.0, 3.0, 4.0, 5.0],
            }).to_csv(data_path, index=False)

            response = handle_request({
                "protocol_version": 2,
                "request_id": "execute-stale-data-fingerprint",
                "operation": "execute",
                "payload": {
                    "method_id": "ols_regression",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {"dependentVar": "y", "treatmentVar": "x", "covariates": [], "covariance": "HC1"},
                    "expected_data_fingerprint": f"sha256:{'b' * 64}",
                },
            })

            self.assertFalse(response["ok"], response)
            self.assertEqual(response["error"]["code"], "DATA_FINGERPRINT_MISMATCH")
            self.assertFalse((output_dir / "results.json").exists())
            self.assertFalse((output_dir / "coefficients.csv").exists())

    def test_execute_estimates_the_same_snapshot_that_passed_preflight(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "mutable.csv"
            output_dir = root / "result"
            original_frame = pd.DataFrame({
                "y": [5.0, 7.0, 9.0, 11.0, 13.0],
                "x": [0.0, 1.0, 2.0, 3.0, 4.0],
            })
            original_frame.to_csv(data_path, index=False)
            expected_fingerprint = content_fingerprint(pd.read_csv(data_path))
            real_preflight = engine_protocol.preflight_method
            mutation_count = 0
            preflight_paths: list[Path] = []

            def mutate_source_after_preflight(method_id, snapshot_path, arguments):
                nonlocal mutation_count
                preflight_paths.append(Path(snapshot_path))
                result = real_preflight(method_id, snapshot_path, arguments)
                if mutation_count == 0:
                    mutation_count += 1
                    pd.DataFrame({
                        "y": [100.0, 110.0, 120.0, 130.0, 140.0],
                        "x": [0.0, 1.0, 2.0, 3.0, 4.0],
                    }).to_csv(data_path, index=False)
                return result

            request = {
                "protocol_version": 2,
                "request_id": "execute-ols-snapshot-consistency",
                "operation": "execute",
                "payload": {
                    "method_id": "ols_regression",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "covariates": [],
                        "covariance": "HC1",
                    },
                    "expected_data_fingerprint": expected_fingerprint,
                },
            }

            with patch.object(engine_protocol, "preflight_method", side_effect=mutate_source_after_preflight):
                response = engine_protocol.handle_request(request)

            self.assertTrue(response["ok"], response)
            self.assertEqual(mutation_count, 1)
            self.assertFalse(preflight_paths[0].exists())
            self.assertAlmostEqual(response["result"]["payload"]["primary"]["estimate"], 2.0, places=8)
            self.assertEqual(response["result"]["payload"]["rowsUsed"], len(original_frame))
            self.assertNotIn("killstata-execution-snapshot", json.dumps(response))

    def test_runner_io_failure_is_not_misreported_as_snapshot_creation_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "data.csv"
            pd.DataFrame({"y": [1.0, 3.0, 5.0, 7.0], "x": [0.0, 1.0, 2.0, 3.0]}).to_csv(data_path, index=False)
            request = {
                "protocol_version": 2,
                "request_id": "execute-runner-io-error",
                "operation": "execute",
                "payload": {
                    "method_id": "ols_regression",
                    "data_path": str(data_path),
                    "output_dir": str(root / "result"),
                    "arguments": {"dependentVar": "y", "treatmentVar": "x", "covariates": []},
                },
            }

            with patch(
                "killstata_econometrics_engine.runner_bridge.execute_registered_method",
                side_effect=OSError("simulated estimator output I/O failure"),
            ):
                response = engine_protocol.handle_request(request)

            self.assertFalse(response["ok"], response)
            self.assertEqual(response["error"]["code"], "METHOD_EXECUTION_FAILED")

    def test_source_change_during_snapshot_copy_stops_before_preflight_or_estimation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "changing.csv"
            output_dir = root / "result"
            pd.DataFrame({"y": [1.0, 3.0, 5.0, 7.0], "x": [0.0, 1.0, 2.0, 3.0]}).to_csv(data_path, index=False)
            real_copyfileobj = engine_protocol.shutil.copyfileobj

            def copy_then_mutate_source(source_file, snapshot_file, *args, **kwargs):
                real_copyfileobj(source_file, snapshot_file, *args, **kwargs)
                pd.DataFrame({"y": [10.0, 30.0, 50.0, 70.0], "x": [0.0, 1.0, 2.0, 3.0]}).to_csv(data_path, index=False)

            with patch.object(engine_protocol.shutil, "copyfileobj", side_effect=copy_then_mutate_source):
                response = engine_protocol.handle_request({
                    "protocol_version": 2,
                    "request_id": "execute-changing-source-during-snapshot",
                    "operation": "execute",
                    "payload": {
                        "method_id": "ols_regression",
                        "data_path": str(data_path),
                        "output_dir": str(output_dir),
                        "arguments": {"dependentVar": "y", "treatmentVar": "x", "covariates": []},
                    },
                })

            self.assertFalse(response["ok"], response)
            self.assertEqual(response["error"]["code"], "DATA_SNAPSHOT_UNSTABLE")
            self.assertIn("估计器没有运行", response["error"]["message_zh"])
            self.assertFalse((output_dir / "results.json").exists())
            self.assertFalse((output_dir / "coefficients.csv").exists())

    def test_create_relative_time_uses_confirmed_cohort_and_never_treated_sentinel(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "did-panel.csv"
            output_path = root / "relative-time.parquet"
            frame = pd.DataFrame([
                {"unit": unit, "year": year, "cohort": cohort, "treated": int(cohort is not None and year >= cohort), "y": float(year)}
                for unit, cohort in (("A", 2012), ("B", 2013), ("C", None))
                for year in (2010, 2011, 2012, 2013)
            ])
            frame.to_csv(data_path, index=False)
            original = pd.read_csv(data_path)
            response = handle_request({
                "protocol_version": 2,
                "request_id": "create-relative-time-valid",
                "operation": "execute",
                "payload": {
                    "method_id": "data_preprocess",
                    "data_path": str(data_path),
                    "output_dir": str(root / "result"),
                    "arguments": {
                        "method": "create_relative_time",
                        "columns": [],
                        "options": {
                            "entity_var": "unit",
                            "time_var": "year",
                            "cohort_var": "cohort",
                            "treatment_var": "treated",
                            "output_column": "relative_time",
                        },
                    },
                    "runtime": {"datasetId": "dataset_relative", "stageId": "stage_000", "outputPath": str(output_path)},
                },
            })

            self.assertTrue(response["ok"], response)
            self.assertTrue(output_path.is_file())
            self.assertEqual(response["result"]["payload"]["rows_before"], len(frame))
            self.assertEqual(response["result"]["payload"]["rows_after"], len(frame))
            pd.testing.assert_frame_equal(pd.read_csv(data_path), original)
            result = pd.read_parquet(output_path)
            self.assertEqual(result.loc[result["unit"] == "A", "relative_time"].tolist(), [-2.0, -1.0, 0.0, 1.0])
            self.assertEqual(result.loc[result["unit"] == "B", "relative_time"].tolist(), [-3.0, -2.0, -1.0, 0.0])
            self.assertTrue(np.isneginf(result.loc[result["unit"] == "C", "relative_time"].to_numpy(dtype=float)).all())

    def test_create_relative_time_rejects_treatment_cohort_mismatch_without_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "mismatched-did.csv"
            output_path = root / "relative-time.parquet"
            pd.DataFrame({
                "unit": ["A", "A", "B", "B"],
                "year": [2011, 2012, 2011, 2012],
                "cohort": [2012, 2012, None, None],
                "treated": [0, 0, 0, 0],
            }).to_csv(data_path, index=False)

            response = handle_request({
                "protocol_version": 2,
                "request_id": "create-relative-time-mismatch",
                "operation": "execute",
                "payload": {
                    "method_id": "data_preprocess",
                    "data_path": str(data_path),
                    "output_dir": str(root / "result"),
                    "arguments": {
                        "method": "create_relative_time",
                        "columns": [],
                        "options": {
                            "entity_var": "unit",
                            "time_var": "year",
                            "cohort_var": "cohort",
                            "treatment_var": "treated",
                            "output_column": "relative_time",
                        },
                    },
                    "runtime": {"datasetId": "dataset_relative", "stageId": "stage_000", "outputPath": str(output_path)},
                },
            })

            self.assertFalse(response["ok"], response)
            self.assertIn("处理标志", response["error"]["message_zh"])
            self.assertNotIn("取值不受支持", response["error"]["message_zh"])
            self.assertFalse(output_path.exists())

    def test_create_relative_time_rejects_duplicate_keys_cohort_drift_and_column_collision(self):
        valid = pd.DataFrame({
            "unit": ["A", "A", "B", "B"],
            "year": [2011, 2012, 2011, 2012],
            "cohort": [2012, 2012, None, None],
            "treated": [0, 1, 0, 0],
        })
        cases = {
            "duplicate_key": pd.concat([valid, valid.iloc[[0]]], ignore_index=True),
            "cohort_drift": valid.assign(cohort=[2011, 2012, None, None]),
            "output_collision": valid.assign(relative_time=[-1.0, 0.0, float("-inf"), float("-inf")]),
        }
        for label, frame in cases.items():
            with self.subTest(label=label), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                data_path = root / "invalid-relative-time.csv"
                output_path = root / "relative-time.parquet"
                frame.to_csv(data_path, index=False)
                response = handle_request({
                    "protocol_version": 2,
                    "request_id": f"create-relative-time-{label}",
                    "operation": "execute",
                    "payload": {
                        "method_id": "data_preprocess",
                        "data_path": str(data_path),
                        "output_dir": str(root / "result"),
                        "arguments": {
                            "method": "create_relative_time",
                            "columns": [],
                            "options": {
                                "entity_var": "unit",
                                "time_var": "year",
                                "cohort_var": "cohort",
                                "treatment_var": "treated",
                                "output_column": "relative_time",
                            },
                        },
                        "runtime": {"datasetId": "dataset_relative", "stageId": "stage_000", "outputPath": str(output_path)},
                    },
                })

                self.assertFalse(response["ok"], response)
                self.assertFalse(output_path.exists())

    def test_direct_topsis_runner_rejects_implicit_equal_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "matrix.csv"
            data_path.write_text("id,x,y\na,1,3\nb,2,2\nc,3,1\n", encoding="utf-8")
            output_dir = root / "scores"
            payload = {
                "method": "topsis", "dataPath": str(data_path), "outputDir": str(output_dir),
                "expectedDataFingerprint": content_fingerprint(pd.read_csv(data_path)),
                "idColumns": ["id"],
                "indicators": [{"column": "x", "direction": "benefit"}, {"column": "y", "direction": "cost"}],
                "scope": "global",
            }
            runner = Path(__file__).parents[1] / "python" / "mcda" / "runner.py"
            process = subprocess.run([sys.executable, str(runner)], input=json.dumps(payload), text=True, capture_output=True, check=False)
            self.assertEqual(process.returncode, 0, process.stderr)
            response = json.loads(process.stdout)
            self.assertFalse(response["success"], response)
            self.assertIn("weightSource", response["message"])
            self.assertFalse((output_dir / "scores.parquet").exists())

    def test_direct_topsis_runner_rejects_boolean_and_string_manual_weights(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "matrix.csv"
            data_path.write_text("id,x,y\na,1,3\nb,2,2\nc,3,1\n", encoding="utf-8")
            runner = Path(__file__).parents[1] / "python" / "mcda" / "runner.py"
            for label, weights in (
                ("boolean", {"x": True, "y": 0.0}),
                ("string", {"x": "0.5", "y": 0.5}),
            ):
                with self.subTest(label=label):
                    output_dir = root / label
                    payload = {
                        "method": "topsis", "dataPath": str(data_path), "outputDir": str(output_dir),
                        "expectedDataFingerprint": content_fingerprint(pd.read_csv(data_path)),
                        "idColumns": ["id"],
                        "indicators": [{"column": "x", "direction": "benefit"}, {"column": "y", "direction": "cost"}],
                        "scope": "global", "weightSource": "manual", "manualWeights": weights,
                    }
                    process = subprocess.run([sys.executable, str(runner)], input=json.dumps(payload), text=True, capture_output=True, check=False)
                    self.assertEqual(process.returncode, 0, process.stderr)
                    response = json.loads(process.stdout)
                    self.assertFalse(response["success"], response)
                    self.assertIn("manualWeights", response["message"])
                    self.assertFalse((output_dir / "scores.parquet").exists())

    def test_minmax_scale_executes_json_array_range_and_writes_scaled_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "data.csv"
            output_path = root / "stage.parquet"
            data_path.write_text("id,x\na,0\nb,1\nc,2\n", encoding="utf-8")
            response = handle_request({
                "protocol_version": 2, "request_id": "execute-minmax-json-range", "operation": "execute",
                "payload": {
                    "method_id": "data_preprocess", "data_path": str(data_path), "output_dir": str(root / "result"),
                    "arguments": {"method": "minmax_scale", "columns": ["x"], "options": {"feature_range": [-1, 1]}},
                    "runtime": {"datasetId": "dataset_minmax_json", "stageId": "stage_000", "outputPath": str(output_path)},
                },
            })
            self.assertTrue(response["ok"], response)
            self.assertTrue(output_path.is_file())
            scaled = pd.read_parquet(output_path)
            np.testing.assert_allclose(scaled["x_mm"].to_numpy(), [-1.0, 0.0, 1.0])

    def test_data_import_actions_share_one_jsonl_engine_contract(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "data.csv"
            data_path.write_text("entity,time,y,x\nA,2020,1,2\nA,2021,2,3\nB,2020,3,4\n", encoding="utf-8")
            export_path = root / "export.csv"
            requests = [
                {"protocol_version": 1, "request_id": "profile-1", "operation": "execute", "payload": {"method_id": "data_import", "data_path": str(data_path), "output_dir": str(root / "profile"), "arguments": {"action": "profile", "variables": ["y", "x"]}, "runtime": {"inputPath": str(data_path), "outputPath": str(root / "profile" / "profile.xlsx"), "datasetId": "dataset_import_contract", "stageId": "stage_000"}}},
                {"protocol_version": 1, "request_id": "frequency-1", "operation": "execute", "payload": {"method_id": "data_import", "data_path": str(data_path), "output_dir": str(root / "frequency"), "arguments": {"action": "frequency", "variables": ["time"], "groupBy": ["entity", "time"]}, "runtime": {"inputPath": str(data_path), "outputPath": str(root / "frequency" / "frequency.xlsx"), "datasetId": "dataset_import_contract", "stageId": "stage_000"}}},
                {"protocol_version": 1, "request_id": "correlation-1", "operation": "execute", "payload": {"method_id": "data_import", "data_path": str(data_path), "output_dir": str(root / "correlation"), "arguments": {"action": "correlation", "variables": ["y", "x"]}, "runtime": {"inputPath": str(data_path), "outputPath": str(root / "correlation" / "correlation.xlsx"), "datasetId": "dataset_import_contract", "stageId": "stage_000"}}},
                {"protocol_version": 1, "request_id": "validate-1", "operation": "execute", "payload": {"method_id": "data_import", "data_path": str(data_path), "output_dir": str(root / "validate"), "arguments": {"action": "validate", "entityVar": "entity", "timeVar": "time"}, "runtime": {"inputPath": str(data_path), "outputPath": str(root / "validate" / "validate.json"), "datasetId": "dataset_import_contract", "stageId": "stage_000"}}},
                {"protocol_version": 1, "request_id": "export-1", "operation": "execute", "payload": {"method_id": "data_import", "data_path": str(data_path), "output_dir": str(root / "export"), "arguments": {"action": "export", "format": "csv"}, "runtime": {"inputPath": str(data_path), "outputPath": str(export_path), "datasetId": "dataset_import_contract", "stageId": "stage_000"}}},
            ]
            process = subprocess.run(
                [sys.executable, "-m", "killstata_econometrics_engine"],
                input="\n".join(json.dumps(request) for request in requests) + "\n",
                text=True,
                capture_output=True,
                env={
                    **__import__("os").environ,
                    "PYTHONPATH": str(Path(__file__).parents[1] / "src"),
                    "KILLSTATA_ENGINE_METHOD_ROOT": str(Path(__file__).parents[2] / "killstata-econometrics-engine" / "python"),
                },
                check=False,
            )
            self.assertEqual(process.returncode, 0, process.stderr)
            responses = [json.loads(line) for line in process.stdout.splitlines() if line.strip()]
            self.assertEqual([item["request_id"] for item in responses], [request["request_id"] for request in requests])
            self.assertTrue(all(item["ok"] for item in responses), responses)
            self.assertEqual(responses[0]["result"]["payload"]["variables"], ["y", "x"])
            self.assertEqual(responses[1]["result"]["payload"]["group_by"], ["entity", "time"])
            self.assertTrue(Path(responses[1]["result"]["payload"]["output_path"]).exists())
            self.assertTrue(Path(responses[0]["result"]["payload"]["output_path"]).exists())
            self.assertEqual(sorted(responses[2]["result"]["payload"]["correlation"]), ["x", "y"])
            self.assertEqual(responses[3]["result"]["payload"]["autoQa"]["status"], "pass")
            self.assertTrue(export_path.exists())

    def test_execute_ols_returns_common_envelope_and_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "data.csv"
            output_dir = root / "result"
            with data_path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.writer(handle)
                writer.writerow(["y", "x"])
                writer.writerows([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5]])

            request = {
                "protocol_version": 1,
                "request_id": "execute-ols-1",
                "operation": "execute",
                "payload": {
                    "method_id": "ols_regression",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "covariates": [],
                        "covariance": "HC1",
                    },
                },
            }
            process = subprocess.run(
                [sys.executable, "-m", "killstata_econometrics_engine"],
                input=json.dumps(request) + "\n",
                text=True,
                capture_output=True,
                env={
                    "PYTHONPATH": str(Path(__file__).parents[1] / "src"),
                    "KILLSTATA_ENGINE_METHOD_ROOT": str(Path(__file__).parents[2] / "killstata-econometrics-engine" / "python"),
                },
                check=False,
            )

            self.assertEqual(process.returncode, 0, process.stderr)
            response = json.loads(process.stdout)
            self.assertTrue(response["ok"], response)
            result = response["result"]
            self.assertEqual(result["method_id"], "ols_regression")
            self.assertTrue(result["success"])
            self.assertEqual(result["payload"]["rowsUsed"], 5)
            self.assertEqual(result["payload"]["vif"][0]["variable"], "x")
            self.assertAlmostEqual(result["payload"]["vif"][0]["vif"], 1.0)
            self.assertTrue((output_dir / "results.json").exists())
            self.assertTrue((output_dir / "coefficients.csv").exists())

    def test_wls_direct_execute_rejects_zero_weights_without_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "zero_wls_weight.csv"
            output_dir = root / "result"
            pd.DataFrame({
                "outcome": [1.0, 2.0, 3.0, 4.0],
                "predictor": [0.0, 1.0, 2.0, 3.0],
                "precision_weight": [1.0, 0.0, 2.0, 3.0],
            }).to_csv(data_path, index=False)

            response = handle_request({
                "protocol_version": 2,
                "request_id": "execute-wls-zero-weight",
                "operation": "execute",
                "payload": {
                    "method_id": "wls_regression",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "dependentVar": "outcome",
                        "treatmentVar": "predictor",
                        "weightsVar": "precision_weight",
                        "covariates": [],
                        "covariance": "robust",
                    },
                },
            })

            self.assertFalse(response["ok"], response)
            self.assertIn("严格为正", response["error"]["message_zh"])
            self.assertFalse((output_dir / "results.json").exists())
            self.assertFalse((output_dir / "coefficients.csv").exists())

    def test_wls_direct_execute_rejects_missing_weights_without_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "missing_wls_weight.csv"
            output_dir = root / "result"
            pd.DataFrame({
                "outcome": [1.0, 2.0, 3.0, 4.0],
                "predictor": [0.0, 1.0, 2.0, 3.0],
                "precision_weight": [1.0, None, 2.0, 3.0],
            }).to_csv(data_path, index=False)

            response = handle_request({
                "protocol_version": 2,
                "request_id": "execute-wls-missing-weight",
                "operation": "execute",
                "payload": {
                    "method_id": "wls_regression",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "dependentVar": "outcome",
                        "treatmentVar": "predictor",
                        "weightsVar": "precision_weight",
                        "covariates": [],
                        "covariance": "robust",
                    },
                },
            })

            self.assertFalse(response["ok"], response)
            self.assertIn("权重", response["error"]["message_zh"])
            self.assertFalse((output_dir / "results.json").exists())
            self.assertFalse((output_dir / "coefficients.csv").exists())

    def test_ols_reports_vif_for_treatment_and_controls_and_warns_on_high_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "near_collinear.csv"
            frame = pd.DataFrame([
                {
                    "y": 1 + 1.5 * ((index - 40.5) / 23) + 0.2 * (((index - 40.5) / 23) + (0.2 if index % 2 == 0 else -0.2)),
                    "x": (index - 40.5) / 23,
                    "control": (index - 40.5) / 23 + (0.2 if index % 2 == 0 else -0.2),
                }
                for index in range(1, 81)
            ])
            frame.to_csv(data_path, index=False)

            response = handle_request({
                "protocol_version": 1,
                "request_id": "execute-ols-vif-1",
                "operation": "execute",
                "payload": {
                    "method_id": "ols_regression",
                    "data_path": str(data_path),
                    "output_dir": str(root / "result"),
                    "arguments": {
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "covariates": ["control"],
                        "covariance": "HC1",
                    },
                },
            })

            self.assertTrue(response["ok"], response)
            payload = response["result"]["payload"]
            self.assertEqual({row["variable"] for row in payload["vif"]}, {"x", "control"})
            self.assertGreater(max(row["vif"] for row in payload["vif"]), 10)
            self.assertTrue(any("VIF" in warning for warning in payload["warnings"]))

    def test_ols_vif_matches_auxiliary_regressions_with_intercept(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "uncentered.csv"
            frame = pd.DataFrame([
                {
                    "y": 2 + 0.4 * (index + 20) + 0.3 * (4 + 0.8 * (index + 20) + (1 if index % 2 == 0 else -1)),
                    "x": index + 20,
                    "control": 4 + 0.8 * (index + 20) + (1 if index % 2 == 0 else -1),
                }
                for index in range(1, 81)
            ])
            frame.to_csv(data_path, index=False)
            response = handle_request({
                "protocol_version": 1,
                "request_id": "execute-ols-vif-intercept-1",
                "operation": "execute",
                "payload": {
                    "method_id": "ols_regression",
                    "data_path": str(data_path),
                    "output_dir": str(root / "result"),
                    "arguments": {
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "covariates": ["control"],
                        "covariance": "HC1",
                    },
                },
            })

            self.assertTrue(response["ok"], response)
            actual = {row["variable"]: row["vif"] for row in response["result"]["payload"]["vif"]}
            design = sm.add_constant(frame[["x", "control"]], has_constant="add").to_numpy(dtype=float)
            expected = {
                "x": variance_inflation_factor(design, 1),
                "control": variance_inflation_factor(design, 2),
            }
            for variable in expected:
                self.assertAlmostEqual(actual[variable], expected[variable], places=6)

    def test_execute_data_import_profiles_and_writes_canonical_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "data.csv"
            output_dir = root / "import"
            with data_path.open("w", newline="", encoding="utf-8") as handle:
                writer = csv.writer(handle)
                writer.writerow(["province", "year", "outcome"])
                writer.writerows([["A", 2020, 1], ["A", 2021, 2], ["B", 2020, 3]])

            request = {
                "protocol_version": 1,
                "request_id": "execute-import-1",
                "operation": "execute",
                "payload": {
                    "method_id": "data_import",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {"action": "import"},
                    "runtime": {
                        "inputPath": str(data_path),
                        "outputPath": str(output_dir / "data.parquet"),
                        "datasetId": "dataset_import_test",
                        "stageId": "stage_000",
                    },
                },
            }
            process = subprocess.run(
                [sys.executable, "-m", "killstata_econometrics_engine"],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                env={
                    **__import__("os").environ,
                    "PYTHONPATH": str(Path(__file__).parents[1] / "src"),
                    "KILLSTATA_ENGINE_METHOD_ROOT": str(Path(__file__).parents[2] / "killstata-econometrics-engine" / "python"),
                },
                check=False,
            )
            self.assertEqual(process.returncode, 0, process.stderr)
            response = json.loads(process.stdout)
            self.assertTrue(response["ok"], response)
            self.assertEqual(response["result"]["payload"]["rows"], 3)
            self.assertTrue(response["result"]["payload"]["resultPath"])
            self.assertTrue((output_dir / "data.parquet").exists())
            self.assertTrue((output_dir / "schema.json").exists())

    def test_ols_accepts_nullable_numeric_dtypes_from_canonical_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "data.csv"
            data_path.write_text("entity,year,y,x\nA,2020,1,2\nA,2021,2,3\nB,2020,3,4\nB,2021,4,5\n", encoding="utf-8")
            imported = handle_request({
                "protocol_version": 1,
                "request_id": "nullable-import-1",
                "operation": "execute",
                "payload": {
                    "method_id": "data_import",
                    "data_path": str(data_path),
                    "output_dir": str(root / "import"),
                    "arguments": {"action": "import"},
                    "runtime": {
                        "inputPath": str(data_path),
                        "outputPath": str(root / "import" / "data.parquet"),
                        "datasetId": "dataset_nullable_test",
                        "stageId": "stage_000",
                    },
                },
            })
            self.assertTrue(imported["ok"], imported)
            canonical_path = imported["result"]["payload"]["dataPath"]
            estimated = handle_request({
                "protocol_version": 1,
                "request_id": "nullable-ols-1",
                "operation": "execute",
                "payload": {
                    "method_id": "ols_regression",
                    "data_path": canonical_path,
                    "output_dir": str(root / "ols"),
                    "arguments": {"dependentVar": "y", "treatmentVar": "x", "covariates": []},
                },
            })
            self.assertTrue(estimated["ok"], estimated)
            self.assertEqual(estimated["result"]["payload"]["rowsUsed"], 4)

    def test_econometrics_recommend_runs_through_the_python_registry(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.csv"
            data_path.write_text(
                "entity,year,y,x\nA,2020,1,2\nA,2021,2,3\nB,2020,3,4\nB,2021,4,5\n",
                encoding="utf-8",
            )
            response = handle_request({
                "protocol_version": 1,
                "request_id": "recommend-registry-1",
                "operation": "execute",
                "payload": {
                    "method_id": "econometrics_recommend",
                    "data_path": str(data_path),
                    "output_dir": str(root / "recommend"),
                    "arguments": {
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "entityVar": "entity",
                        "timeVar": "year",
                    },
                    "runtime": {"datasetId": "dataset_recommend_test", "stageId": "stage_000"},
                },
            })
            self.assertTrue(response["ok"], response)
            payload = response["result"]["payload"]
            self.assertEqual(payload["recommendation"]["recommended_method"], "panel_fe_regression")
            self.assertEqual(payload["profile"]["row_count"], 4)

    def test_heterogeneity_runner_writes_structured_spec_artifacts(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.csv"
            rows = [
                f"{entity},{year},{year * 0.1 + offset},{year * 0.2 + offset}, {exposure}\n"
                for entity, offset, exposure in (("A", 1, 0.0), ("B", 2, 0.0), ("C", 3, 1.0), ("D", 4, 1.0))
                for year in range(2000, 2010)
            ]
            data_path.write_text("entity,year,y,x,exposure\n" + "".join(rows), encoding="utf-8")
            response = handle_request({
                "protocol_version": 1,
                "request_id": "heterogeneity-execute-1",
                "operation": "execute",
                "payload": {
                    "method_id": "heterogeneity_runner",
                    "data_path": str(data_path),
                    "output_dir": str(root / "heterogeneity"),
                    "arguments": {
                        "methodFamily": "fe",
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "entityVar": "entity",
                        "timeVar": "year",
                        "heterogeneityVars": ["exposure"],
                    },
                    "runtime": {
                        "datasetId": "dataset_heterogeneity_test",
                        "stageId": "stage_000",
                        "runId": "run_000",
                        "branch": "main",
                        "outputDir": str(root / "heterogeneity"),
                    },
                },
            })
            self.assertTrue(response["ok"], response)
            specs = response["result"]["payload"]["specs"]
            successful = [spec for spec in specs if spec["status"] == "success"]
            self.assertGreaterEqual(len(successful), 1)
            self.assertTrue(Path(successful[0]["result_path"]).exists())
            self.assertTrue(Path(successful[0]["coefficients_path"]).exists())
            self.assertTrue(Path(successful[0]["coefficients_path"]).read_bytes().startswith(b"\xef\xbb\xbf"))
            diagnostics = json.loads(Path(successful[0]["diagnostics_path"]).read_text(encoding="utf-8"))
            self.assertEqual(diagnostics["core"]["covariance_type"], "HC1")

    def test_heterogeneity_runner_rejects_data_fingerprint_mismatch_before_writing_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.csv"
            rows = [
                f"{entity},{year},{year * 0.1 + offset},{year * 0.2 + offset},{group}\n"
                for entity, offset, group in (("A", 1, 0), ("B", 2, 0), ("C", 3, 1), ("D", 4, 1))
                for year in range(2000, 2010)
            ]
            data_path.write_text("entity,year,y,x,group\n" + "".join(rows), encoding="utf-8")
            output_dir = root / "heterogeneity"
            response = handle_request({
                "protocol_version": 2,
                "request_id": "heterogeneity-stale-fingerprint",
                "operation": "execute",
                "payload": {
                    "method_id": "heterogeneity_runner",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "methodFamily": "fe",
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "entityVar": "entity",
                        "timeVar": "year",
                        "heterogeneityVars": ["group"],
                    },
                    "runtime": {
                        "datasetId": "dataset_heterogeneity_test",
                        "stageId": "stage_000",
                        "runId": "run_000",
                        "branch": "main",
                        "outputDir": str(output_dir),
                        "expectedDataFingerprint": f"sha256:{'0' * 64}",
                    },
                },
            })

            self.assertFalse(response["ok"], response)
            self.assertEqual(response["error"]["code"], "DATA_FINGERPRINT_MISMATCH")
            self.assertIn("当前诊断指纹不一致", response["error"]["message_zh"])
            self.assertFalse(output_dir.exists())

    def test_heterogeneity_runner_requires_harness_diagnosis_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.csv"
            data_path.write_text("entity,year,y,x\nA,1,1,0\nA,2,2,1\n", encoding="utf-8")
            output_dir = root / "heterogeneity"
            response = _handle_request({
                "protocol_version": 2,
                "request_id": "heterogeneity-missing-fingerprint",
                "operation": "execute",
                "payload": {
                    "method_id": "heterogeneity_runner",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "methodFamily": "fe",
                        "dependentVar": "y",
                        "treatmentVar": "x",
                    },
                    "runtime": {"outputDir": str(output_dir)},
                },
            })

            self.assertFalse(response["ok"], response)
            self.assertEqual(response["error"]["code"], "DATA_FINGERPRINT_MISMATCH")
            self.assertFalse(output_dir.exists())

    def test_composite_evaluation_rejects_data_fingerprint_mismatch_before_writing_outputs(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "matrix.csv"
            pd.DataFrame({
                "id": ["a", "b", "c", "d"],
                "benefit": [1.0, 2.0, 3.0, 4.0],
                "cost": [4.0, 3.0, 2.0, 1.0],
            }).to_csv(data_path, index=False)
            output_dir = root / "composite"
            response = _handle_request({
                "protocol_version": 2,
                "request_id": "composite-stale-fingerprint",
                "operation": "execute",
                "payload": {
                    "method_id": "composite_evaluation",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "method": "entropy_weight",
                        "idColumns": ["id"],
                        "indicators": [
                            {"column": "benefit", "direction": "benefit"},
                            {"column": "cost", "direction": "cost"},
                        ],
                        "scope": "global",
                    },
                    "runtime": {
                        "datasetId": "dataset_composite_test",
                        "stageId": "stage_000",
                        "expectedDataFingerprint": f"sha256:{'0' * 64}",
                    },
                },
            })

            self.assertFalse(response["ok"], response)
            self.assertEqual(response["error"]["code"], "DATA_FINGERPRINT_MISMATCH")
            self.assertFalse(output_dir.exists())

    def test_heterogeneity_runner_rejects_missing_harness_data_fingerprint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.csv"
            data_path.write_text("entity,year,y,x\nA,1,1,0\nA,2,2,1\n", encoding="utf-8")
            output_dir = root / "heterogeneity"
            response = _handle_request({
                "protocol_version": 2,
                "request_id": "heterogeneity-missing-fingerprint",
                "operation": "execute",
                "payload": {
                    "method_id": "heterogeneity_runner",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "methodFamily": "fe",
                        "dependentVar": "y",
                        "treatmentVar": "x",
                    },
                    "runtime": {"outputDir": str(output_dir)},
                },
            })

            self.assertFalse(response["ok"], response)
            self.assertEqual(response["error"]["code"], "DATA_FINGERPRINT_MISMATCH")
            self.assertFalse(output_dir.exists())

    def test_heterogeneity_runner_rejects_did_family_instead_of_running_lsdv(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.csv"
            data_path.write_text("entity,year,y,x\nA,1,1,0\nA,2,2,1\n", encoding="utf-8")
            output_dir = root / "heterogeneity"
            response = handle_request({
                "protocol_version": 1,
                "request_id": "heterogeneity-did-must-not-become-lsdv",
                "operation": "execute",
                "payload": {
                    "method_id": "heterogeneity_runner",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "methodFamily": "did",
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "entityVar": "entity",
                        "timeVar": "year",
                    },
                    "runtime": {"outputDir": str(output_dir)},
                },
            })

            self.assertFalse(response["ok"])
            self.assertIn("DID", response["error"]["message_zh"])
            self.assertFalse(output_dir.exists())

    def test_heterogeneity_runner_accepts_nullable_integer_time_from_canonical_parquet(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.parquet"
            records = []
            for group in ("north", "south"):
                for entity_index in range(4):
                    entity = f"{group}-{entity_index}"
                    treated = entity_index % 2
                    for year in range(2000, 2010):
                        treatment = float(treated and year >= 2005)
                        records.append({
                            "entity": entity,
                            "year": year,
                            "group": group,
                            "x": treatment,
                            "y": 0.7 * treatment + entity_index * 0.3 + (year - 2000) * 0.1,
                        })
            frame = pd.DataFrame(records)
            frame["entity"] = frame["entity"].astype("string")
            frame["year"] = frame["year"].astype("Int64")
            frame["group"] = frame["group"].astype("string")
            frame.to_parquet(data_path, index=False)

            response = handle_request({
                "protocol_version": 2,
                "request_id": "heterogeneity-nullable-int-time",
                "operation": "execute",
                "payload": {
                    "method_id": "heterogeneity_runner",
                    "data_path": str(data_path),
                    "output_dir": str(root / "heterogeneity"),
                    "arguments": {
                        "methodFamily": "fe",
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "entityVar": "entity",
                        "timeVar": "year",
                        "heterogeneityVars": ["group"],
                    },
                    "runtime": {
                        "datasetId": "dataset_heterogeneity_nullable_int",
                        "stageId": "stage_000",
                        "runId": "run_heterogeneity_nullable_int",
                        "branch": "main",
                        "outputDir": str(root / "heterogeneity"),
                    },
                },
            })

            self.assertTrue(response["ok"], response)
            subgroup_specs = [
                spec for spec in response["result"]["payload"]["specs"]
                if spec["spec_id"].startswith("heter_split_")
            ]
            self.assertEqual(len(subgroup_specs), 2)
            self.assertTrue(all(spec["status"] == "success" for spec in subgroup_specs), subgroup_specs)

    def test_heterogeneity_interaction_includes_moderator_main_effect(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.csv"
            records = []
            for entity_index in range(12):
                treated_group = entity_index >= 6
                for period_index, year in enumerate(range(2000, 2012)):
                    treatment = float(treated_group and year >= 2006)
                    moderator = entity_index * 0.4 + period_index * 0.15 + ((entity_index * period_index) % 5) * 0.07
                    outcome = 0.6 * treatment + 0.3 * moderator + 0.2 * treatment * moderator + entity_index * 0.5 + period_index * 0.1
                    records.append({"entity": f"unit-{entity_index}", "year": year, "group": "treated" if treated_group else "control", "x": treatment, "moderator": moderator, "y": outcome})
            pd.DataFrame(records).to_csv(data_path, index=False)

            response = handle_request({
                "protocol_version": 2,
                "request_id": "heterogeneity-interaction-hierarchical-terms",
                "operation": "execute",
                "payload": {
                    "method_id": "heterogeneity_runner",
                    "data_path": str(data_path),
                    "output_dir": str(root / "heterogeneity"),
                    "arguments": {
                        "methodFamily": "fe",
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "entityVar": "entity",
                        "timeVar": "year",
                        "clusterVar": "entity",
                        "heterogeneityVars": ["moderator"],
                    },
                    "runtime": {
                        "datasetId": "dataset_heterogeneity_interaction",
                        "stageId": "stage_000",
                        "runId": "run_heterogeneity_interaction",
                        "branch": "main",
                        "outputDir": str(root / "heterogeneity"),
                    },
                },
            })

            self.assertTrue(response["ok"], response)
            specs = response["result"]["payload"]["specs"]
            interaction = next(spec for spec in specs if spec["spec_id"] == "heter_interaction_001")
            self.assertEqual(interaction["status"], "success", interaction)
            coefficients = pd.read_csv(interaction["coefficients_path"])
            self.assertIn("mod_moderator", set(coefficients["term"]))
            self.assertIn("int_moderator", set(coefficients["raw_term"]))

    def test_heterogeneity_subgroup_with_one_cluster_does_not_fall_back_to_hc1(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.csv"
            records = []
            for region in ("north", "south"):
                for entity_index in range(3):
                    entity = f"{region}-{entity_index}"
                    for year_index in range(10):
                        treatment = float((entity_index + year_index) % 3 == 0)
                        outcome = entity_index * 0.4 + year_index * 0.2 + treatment * (0.8 + entity_index * 0.1)
                        records.append({"entity": entity, "year": 2000 + year_index, "region": region, "x": treatment, "y": outcome})
            pd.DataFrame(records).to_csv(data_path, index=False)

            response = handle_request({
                "protocol_version": 2,
                "request_id": "heterogeneity-single-cluster-subgroup",
                "operation": "execute",
                "payload": {
                    "method_id": "heterogeneity_runner",
                    "data_path": str(data_path),
                    "output_dir": str(root / "heterogeneity"),
                    "arguments": {
                        "methodFamily": "fe",
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "entityVar": "entity",
                        "timeVar": "year",
                        "clusterVar": "region",
                        "heterogeneityVars": ["region"],
                    },
                    "runtime": {"outputDir": str(root / "heterogeneity")},
                },
            })

            self.assertTrue(response["ok"], response)
            split_specs = [
                spec for spec in response["result"]["payload"]["specs"]
                if spec["spec_id"].startswith("heter_split_")
            ]
            self.assertEqual(len(split_specs), 2)
            self.assertTrue(all(spec["status"] == "failed" for spec in split_specs), split_specs)
            self.assertTrue(all("一个聚类" in spec.get("error", "") for spec in split_specs), split_specs)

    def test_heterogeneity_spec_errors_redact_paths_and_bound_public_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.csv"
            data_path.write_text("entity,year,y,x\nA,1,1,0\nA,2,2,1\n", encoding="utf-8")
            private_column = "/Users/alice/O'Brien/private analysis/" + "x" * 320
            response = handle_request({
                "protocol_version": 1,
                "request_id": "heterogeneity-public-error-bounds",
                "operation": "execute",
                "payload": {
                    "method_id": "heterogeneity_runner",
                    "data_path": str(data_path),
                    "output_dir": str(root / "heterogeneity"),
                    "arguments": {
                        "methodFamily": "fe",
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "entityVar": "entity",
                        "timeVar": "year",
                        "mechanismVars": [private_column, "prt_private_attachment_id"],
                    },
                    "runtime": {"outputDir": str(root / "heterogeneity")},
                },
            })

            self.assertTrue(response["ok"], response)
            specs = response["result"]["payload"]["specs"]
            self.assertEqual(len(specs), 2)
            self.assertTrue(all(spec["status"] == "failed" for spec in specs), specs)
            for spec in specs:
                public_spec = json.dumps(spec)
                self.assertNotIn("/Users/alice/O'Brien", public_spec)
                self.assertNotIn("Brien/private analysis", public_spec)
                self.assertNotIn("prt_private_attachment_id", public_spec)
                self.assertLessEqual(len(spec["title"]), 160)
                self.assertLessEqual(len(spec["changed_specification"]), 240)
                self.assertLessEqual(len(spec["error"]), 240)

    def test_heterogeneity_alternative_name_cannot_escape_the_output_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.csv"
            rows = [
                f"{entity},{year},{year * 0.1 + offset},{year * 0.2 + offset},{exposure}\n"
                for entity, offset, exposure in (("A", 1, 0.0), ("B", 2, 0.0), ("C", 3, 1.0), ("D", 4, 1.0))
                for year in range(2000, 2010)
            ]
            data_path.write_text("entity,year,y,x,exposure\n" + "".join(rows), encoding="utf-8")
            output_dir = root / "heterogeneity"
            response = handle_request({
                "protocol_version": 1,
                "request_id": "heterogeneity-alternative-path-traversal",
                "operation": "execute",
                "payload": {
                    "method_id": "heterogeneity_runner",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "methodFamily": "fe",
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "entityVar": "entity",
                        "timeVar": "year",
                        "alternativeSpecifications": [{"name": "../../../../escape"}],
                    },
                    "runtime": {
                        "datasetId": "dataset_heterogeneity_path_test",
                        "stageId": "stage_000",
                        "runId": "run_000",
                        "branch": "main",
                        "outputDir": str(output_dir),
                    },
                },
            })
            self.assertTrue(response["ok"], response)
            self.assertFalse((root / "escape").exists())
            for spec in response["result"]["payload"]["specs"]:
                result_dir = spec.get("result_dir")
                if result_dir:
                    self.assertTrue(Path(result_dir).resolve().is_relative_to(output_dir.resolve()))

    def test_heterogeneity_spec_symlink_cannot_alias_a_sibling_spec(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.csv"
            rows = [
                f"{entity},{year},{year * 0.1 + offset},{year * 0.2 + offset},{exposure}\n"
                for entity, offset, exposure in (("A", 1, 0.0), ("B", 2, 0.0), ("C", 3, 1.0), ("D", 4, 1.0))
                for year in range(2000, 2010)
            ]
            data_path.write_text("entity,year,y,x,exposure\n" + "".join(rows), encoding="utf-8")
            output_dir = root / "heterogeneity"
            shadow_dir = output_dir / "specs" / "shadow"
            shadow_dir.mkdir(parents=True)
            sentinel = shadow_dir / "results.json"
            sentinel.write_text("keep sibling specification", encoding="utf-8")
            (output_dir / "specs" / "alternative_001").symlink_to(shadow_dir, target_is_directory=True)

            response = handle_request({
                "protocol_version": 1,
                "request_id": "heterogeneity-spec-symlink-alias",
                "operation": "execute",
                "payload": {
                    "method_id": "heterogeneity_runner",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "methodFamily": "fe",
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "entityVar": "entity",
                        "timeVar": "year",
                        "alternativeSpecifications": [{"name": "alternative"}],
                    },
                    "runtime": {
                        "datasetId": "dataset_heterogeneity_symlink_test",
                        "stageId": "stage_000",
                        "runId": "run_000",
                        "branch": "main",
                        "outputDir": str(output_dir),
                    },
                },
            })
            self.assertTrue(response["ok"], response)
            spec = response["result"]["payload"]["specs"][0]
            self.assertEqual(spec["spec_id"], "alternative_001")
            self.assertEqual(spec["status"], "failed")
            self.assertNotIn("result_path", spec)
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep sibling specification")

    def test_heterogeneity_result_file_symlink_cannot_overwrite_external_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.csv"
            rows = [
                f"{entity},{year},{year * 0.1 + offset},{year * 0.2 + offset}\n"
                for entity, offset in (("A", 1), ("B", 2), ("C", 3), ("D", 4))
                for year in range(2000, 2010)
            ]
            data_path.write_text("entity,year,y,x\n" + "".join(rows), encoding="utf-8")
            output_dir = root / "heterogeneity"
            spec_dir = output_dir / "specs" / "alternative_001"
            spec_dir.mkdir(parents=True)
            sentinel = root / "outside-results.json"
            sentinel.write_text("keep external result", encoding="utf-8")
            (spec_dir / "results.json").symlink_to(sentinel)

            response = handle_request({
                "protocol_version": 2,
                "request_id": "heterogeneity-result-file-symlink",
                "operation": "execute",
                "payload": {
                    "method_id": "heterogeneity_runner",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "methodFamily": "fe",
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "entityVar": "entity",
                        "timeVar": "year",
                        "alternativeSpecifications": [{"name": "alternative"}],
                    },
                    "runtime": {
                        "datasetId": "dataset_heterogeneity_leaf_symlink",
                        "stageId": "stage_000",
                        "runId": "run_000",
                        "branch": "main",
                        "outputDir": str(output_dir),
                    },
                },
            })

            self.assertTrue(response["ok"], response)
            spec = response["result"]["payload"]["specs"][0]
            self.assertEqual(spec["status"], "failed")
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "keep external result")

    def test_panel_duplicate_key_is_classified_as_data_quality_error(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.csv"
            data_path.write_text("entity,time,y,x\nA,2020,1,1\nA,2020,2,2\n", encoding="utf-8")
            request = {
                "protocol_version": 1,
                "request_id": "execute-panel-duplicate-1",
                "operation": "execute",
                "payload": {
                    "method_id": "panel_fe_regression",
                    "data_path": str(data_path),
                    "output_dir": str(root / "result"),
                    "arguments": {
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "covariates": [],
                        "entityVar": "entity",
                        "timeVar": "time",
                    },
                },
            }
            process = subprocess.run(
                [sys.executable, "-m", "killstata_econometrics_engine"],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                env={
                    **__import__("os").environ,
                    "PYTHONPATH": str(Path(__file__).parents[1] / "src"),
                    "KILLSTATA_ENGINE_METHOD_ROOT": str(Path(__file__).parents[2] / "killstata-econometrics-engine" / "python"),
                },
                check=False,
            )
            response = json.loads(process.stdout)
            self.assertFalse(response["ok"])
            self.assertEqual(response["error"]["code"], "DATA_PANEL_KEY_NOT_UNIQUE")
            self.assertIn("entity×time", response["error"]["message_zh"])
            self.assertEqual(
                response["error"]["details"]["preflight"]["issues"][0]["code"],
                "DATA_PANEL_KEY_NOT_UNIQUE",
            )
            self.assertEqual(response["error"]["details"]["preflight"]["status"], "requires_user_decision")

    def test_panel_missing_key_is_blocked_before_any_estimation_artifact(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel_missing_key.csv"
            output_dir = root / "panel-output"
            data_path.write_text(
                "entity,time,y,x\nA,2020,1,1\n,2020,2,2\nB,2020,3,3\nB,2021,4,4\n",
                encoding="utf-8",
            )

            response = handle_request({
                "protocol_version": 2,
                "request_id": "execute-panel-missing-key",
                "operation": "execute",
                "payload": {
                    "method_id": "panel_fe_regression",
                    "data_path": str(data_path),
                    "output_dir": str(output_dir),
                    "arguments": {
                        "dependentVar": "y",
                        "treatmentVar": "x",
                        "covariates": [],
                        "entityVar": "entity",
                        "timeVar": "time",
                    },
                },
            })

            self.assertFalse(response["ok"], response)
            preflight = response["error"]["details"]["preflight"]
            self.assertEqual(preflight["status"], "requires_user_decision")
            issue = next((item for item in preflight["issues"] if item["code"] == "DATA_PANEL_KEY_MISSING"), None)
            self.assertIsNotNone(issue, preflight["issues"])
            self.assertEqual(issue["evidence"]["missingEntityRows"], 1)
            self.assertFalse((output_dir / "results.json").exists())
            self.assertFalse((output_dir / "coefficients.csv").exists())

    def test_rank_failure_returns_actionable_chinese_repair_hint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "rank.csv"
            data_path.write_text("y,x,c\n1,1,2\n2,2,4\n3,3,6\n4,4,8\n5,5,10\n", encoding="utf-8")
            response = handle_request({
                "protocol_version": 1,
                "request_id": "execute-rank-error-1",
                "operation": "execute",
                "payload": {
                    "method_id": "ols_regression",
                    "data_path": str(data_path),
                    "output_dir": str(root / "result"),
                    "arguments": {"dependentVar": "y", "treatmentVar": "x", "covariates": ["c"]},
                },
            })
            self.assertFalse(response["ok"])
            self.assertEqual(response["error"]["code"], "DESIGN_MATRIX_RANK_DEFICIENT")
            self.assertIn("修复建议：", response["error"]["message_zh"])
            issues = response["error"]["details"]["preflight"]["issues"]
            self.assertTrue(any(issue["code"] == "DESIGN_MATRIX_RANK_DEFICIENT" for issue in issues))
            self.assertTrue(response["error"]["details"]["preflight"]["repair_plan"])

    def test_data_preprocess_uses_registry_handler_inside_long_lived_engine(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "data.csv"
            output_path = root / "stage.parquet"
            data_path.write_text("year\n2020\n2021\n", encoding="utf-8")
            request = {
                "protocol_version": 1,
                "request_id": "execute-preprocess-1",
                "operation": "execute",
                "payload": {
                    "method_id": "data_preprocess",
                    "data_path": str(data_path),
                    "output_dir": str(root / "result"),
                    "arguments": {
                        "method": "create_column",
                        "columns": ["year"],
                        "options": {"output_column": "post", "operator": "gte", "right_value": 2021},
                    },
                    "runtime": {
                        "datasetId": "dataset_preprocess_test",
                        "stageId": "stage_000",
                        "outputPath": str(output_path),
                    },
                },
            }
            process = subprocess.run(
                [sys.executable, "-m", "killstata_econometrics_engine"],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                env={
                    **__import__("os").environ,
                    "PYTHONPATH": str(Path(__file__).parents[1] / "src"),
                    "KILLSTATA_ENGINE_METHOD_ROOT": str(Path(__file__).parents[2] / "killstata-econometrics-engine" / "python"),
                },
                check=False,
            )
            response = json.loads(process.stdout)
            self.assertTrue(response["ok"], response)
            self.assertTrue(output_path.exists())

    def test_numeric_coercion_uses_only_declared_missing_tokens_and_preserves_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "text-stage.parquet"
            output_path = root / "numeric-stage.parquet"
            pd.DataFrame({
                "unit": [1, 2, 3, 4],
                "vote": pd.Series(["10.5", "NA", "20", "30"], dtype="string"),
            }).to_parquet(data_path, index=False)
            response = handle_request({
                "protocol_version": 2,
                "request_id": "coerce-numeric-explicit-missing",
                "operation": "execute",
                "payload": {
                    "method_id": "data_preprocess",
                    "data_path": str(data_path),
                    "output_dir": str(root / "result"),
                    "arguments": {
                        "method": "coerce_numeric",
                        "columns": ["vote"],
                        "options": {"missing_tokens": ["NA"]},
                    },
                    "runtime": {
                        "datasetId": "dataset_numeric_coerce",
                        "stageId": "stage_000",
                        "outputPath": str(output_path),
                    },
                },
            })

            self.assertTrue(response["ok"], response)
            payload = response["result"]["payload"]
            self.assertEqual(payload["rows_before"], 4)
            self.assertEqual(payload["rows_after"], 4)
            self.assertEqual(payload["converted_numeric"], ["vote"])
            self.assertEqual(payload["missing_tokens_converted"], {"vote": 1})
            self.assertTrue(output_path.exists())
            converted = pd.read_parquet(output_path)
            self.assertTrue(pd.api.types.is_numeric_dtype(converted["vote"]))
            self.assertEqual(converted["vote"].isna().sum(), 1)
            self.assertEqual(converted["vote"].dropna().tolist(), [10.5, 20.0, 30.0])
            original = pd.read_parquet(data_path)
            self.assertEqual(original["vote"].tolist(), ["10.5", "NA", "20", "30"])

    def test_numeric_coercion_rejects_undeclared_text_without_writing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "mixed-stage.parquet"
            output_path = root / "must-not-exist.parquet"
            pd.DataFrame({"vote": pd.Series(["10", "NA", "not-a-number"], dtype="string")}).to_parquet(data_path, index=False)
            response = handle_request({
                "protocol_version": 2,
                "request_id": "coerce-numeric-reject-unknown",
                "operation": "execute",
                "payload": {
                    "method_id": "data_preprocess",
                    "data_path": str(data_path),
                    "output_dir": str(root / "result"),
                    "arguments": {
                        "method": "coerce_numeric",
                        "columns": ["vote"],
                        "options": {"missing_tokens": ["NA"]},
                    },
                    "runtime": {
                        "datasetId": "dataset_numeric_coerce_reject",
                        "stageId": "stage_000",
                        "outputPath": str(output_path),
                    },
                },
            })

            self.assertFalse(response["ok"], response)
            self.assertEqual(response["error"]["code"], "INVALID_ARGUMENT")
            self.assertIn("not-a-number", response["error"]["message_zh"])
            self.assertFalse(output_path.exists())

    def test_numeric_coercion_uses_only_declared_missing_tokens_and_preserves_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "text-stage.parquet"
            output_path = root / "numeric-stage.parquet"
            pd.DataFrame({
                "unit": [1, 2, 3, 4],
                "vote": pd.Series(["10.5", "NA", "20", "30"], dtype="string"),
            }).to_parquet(data_path, index=False)
            response = handle_request({
                "protocol_version": 2,
                "request_id": "coerce-numeric-explicit-missing",
                "operation": "execute",
                "payload": {
                    "method_id": "data_preprocess",
                    "data_path": str(data_path),
                    "output_dir": str(root / "result"),
                    "arguments": {
                        "method": "coerce_numeric",
                        "columns": ["vote"],
                        "options": {"missing_tokens": ["NA"]},
                    },
                    "runtime": {
                        "datasetId": "dataset_numeric_coerce",
                        "stageId": "stage_000",
                        "outputPath": str(output_path),
                    },
                },
            })

            self.assertTrue(response["ok"], response)
            payload = response["result"]["payload"]
            self.assertEqual(payload["rows_before"], 4)
            self.assertEqual(payload["rows_after"], 4)
            self.assertEqual(payload["converted_numeric"], ["vote"])
            self.assertEqual(payload["missing_tokens_converted"], {"vote": 1})
            self.assertTrue(output_path.exists())
            converted = pd.read_parquet(output_path)
            self.assertTrue(pd.api.types.is_numeric_dtype(converted["vote"]))
            self.assertEqual(converted["vote"].isna().sum(), 1)
            self.assertEqual(converted["vote"].dropna().tolist(), [10.5, 20.0, 30.0])
            original = pd.read_parquet(data_path)
            self.assertEqual(original["vote"].tolist(), ["10.5", "NA", "20", "30"])

    def test_numeric_coercion_rejects_undeclared_text_without_writing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "mixed-stage.parquet"
            output_path = root / "must-not-exist.parquet"
            pd.DataFrame({"vote": pd.Series(["10", "NA", "not-a-number"], dtype="string")}).to_parquet(data_path, index=False)
            response = handle_request({
                "protocol_version": 2,
                "request_id": "coerce-numeric-reject-unknown",
                "operation": "execute",
                "payload": {
                    "method_id": "data_preprocess",
                    "data_path": str(data_path),
                    "output_dir": str(root / "result"),
                    "arguments": {
                        "method": "coerce_numeric",
                        "columns": ["vote"],
                        "options": {"missing_tokens": ["NA"]},
                    },
                    "runtime": {
                        "datasetId": "dataset_numeric_coerce_reject",
                        "stageId": "stage_000",
                        "outputPath": str(output_path),
                    },
                },
            })

            self.assertFalse(response["ok"], response)
            self.assertEqual(response["error"]["code"], "INVALID_ARGUMENT")
            self.assertIn("not-a-number", response["error"]["message_zh"])
            self.assertFalse(output_path.exists())

    def test_filter_coerces_a_numeric_string_for_a_numeric_column(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "data.csv"
            data_path.write_text("year,y\n2020,1\n2021,2\n2021,3\n", encoding="utf-8")
            response = handle_request({
                "protocol_version": 1,
                "request_id": "execute-filter-numeric-string-1",
                "operation": "execute",
                "payload": {
                    "method_id": "data_preprocess",
                    "data_path": str(data_path),
                    "output_dir": str(root / "result"),
                    "arguments": {
                        "method": "filter",
                        "columns": [],
                        "options": {
                            "rules": [{"column": "year", "operator": "eq", "value": "2021"}],
                        },
                    },
                    "runtime": {
                        "datasetId": "dataset_filter_test",
                        "stageId": "stage_000",
                        "outputPath": str(root / "result.parquet"),
                    },
                },
            })
            self.assertTrue(response["ok"], response)
            self.assertEqual(response["result"]["payload"]["rows_after"], 2)

    def test_preprocess_filter_rejects_nonnumeric_comparisons_with_actionable_chinese_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "filters.csv"
            data_path.write_text("city,revenue\n北京,100\n上海,200\n广州,300\n", encoding="utf-8")

            def execute_filter(request_id, column, value):
                return handle_request({
                    "protocol_version": 1,
                    "request_id": request_id,
                    "operation": "execute",
                    "payload": {
                        "method_id": "data_preprocess",
                        "data_path": str(data_path),
                        "output_dir": str(root / request_id),
                        "arguments": {
                            "method": "filter",
                            "columns": [],
                            "options": {"rules": [{"column": column, "operator": "gt", "value": value}]},
                        },
                        "runtime": {
                            "datasetId": "dataset_filter_errors",
                            "stageId": "stage_000",
                            "outputPath": str(root / f"{request_id}.parquet"),
                        },
                    },
                })

            text_column = execute_filter("filter-text-column", "city", 100)
            self.assertFalse(text_column["ok"], text_column)
            self.assertEqual(text_column["error"]["code"], "INVALID_ARGUMENT")
            self.assertIn("city", text_column["error"]["message_zh"])
            self.assertIn("不是数值型", text_column["error"]["message_zh"])

            bad_value = execute_filter("filter-bad-value", "revenue", "abc")
            self.assertFalse(bad_value["ok"], bad_value)
            self.assertEqual(bad_value["error"]["code"], "INVALID_ARGUMENT")
            self.assertIn("筛选值必须是数值", bad_value["error"]["message_zh"])

            numeric_string = execute_filter("filter-numeric-string", "revenue", "150")
            self.assertTrue(numeric_string["ok"], numeric_string)
            self.assertEqual(numeric_string["result"]["payload"]["rows_after"], 2)

    def test_numeric_filter_rejects_mixed_nonmissing_text_without_dropping_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "mixed.csv"
            data_path.write_text("id,income\na,100\nb,unknown\nc,200\n", encoding="utf-8")

            def execute(request_id, source):
                output_path = root / f"{request_id}.parquet"
                response = handle_request({
                    "protocol_version": 2, "request_id": request_id, "operation": "execute",
                    "payload": {
                        "method_id": "data_preprocess", "data_path": str(source),
                        "output_dir": str(root / request_id),
                        "arguments": {"method": "filter", "options": {"rules": [{"column": "income", "operator": "gt", "value": 150}]}},
                        "runtime": {"datasetId": "dataset_filter_mixed", "stageId": "stage_000", "outputPath": str(output_path)},
                    },
                })
                return response, output_path

            rejected, output = execute("mixed-filter", data_path)
            self.assertFalse(rejected["ok"], rejected)
            self.assertEqual(rejected["error"]["code"], "INVALID_ARGUMENT")
            self.assertIn("income", rejected["error"]["message_zh"])
            self.assertFalse(output.exists())

            missing_path = root / "missing.csv"
            missing_path.write_text("id,income\na,100\nb,\nc,200\n", encoding="utf-8")
            accepted, accepted_output = execute("missing-filter", missing_path)
            self.assertTrue(accepted["ok"], accepted)
            self.assertEqual(accepted["result"]["payload"]["rows_after"], 1)
            self.assertTrue(accepted_output.exists())

    def test_numeric_filter_rejects_boolean_equality_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "numeric-filter.csv"
            data_path.write_text("id,income\na,1\nb,2\n", encoding="utf-8")
            rules = [
                {"column": "income", "operator": "eq", "value": True},
                {"column": "income", "operator": "in", "values": [True]},
            ]
            for index, rule in enumerate(rules):
                with self.subTest(rule=rule):
                    output_path = root / f"boolean-filter-{index}.parquet"
                    response = handle_request({
                        "protocol_version": 2,
                        "request_id": f"boolean-numeric-filter-{index}",
                        "operation": "execute",
                        "payload": {
                            "method_id": "data_preprocess",
                            "data_path": str(data_path),
                            "output_dir": str(root / f"boolean-filter-output-{index}"),
                            "arguments": {"method": "filter", "options": {"rules": [rule]}},
                            "runtime": {"datasetId": "dataset_filter_boolean", "stageId": "stage_000", "outputPath": str(output_path)},
                        },
                    })
                    self.assertFalse(response["ok"], response)
                    self.assertEqual(response["error"]["code"], "INVALID_ARGUMENT")
                    self.assertIn("布尔", response["error"]["message_zh"])
                    self.assertFalse(output_path.exists())

    def test_filter_contains_treats_the_search_value_as_literal_text(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "literal-filter.csv"
            data_path.write_text("id,code\na,A.B\nb,ABC\nc,XYZ\n", encoding="utf-8")
            output_path = root / "literal-filter.parquet"
            response = handle_request({
                "protocol_version": 2,
                "request_id": "literal-filter-dot",
                "operation": "execute",
                "payload": {
                    "method_id": "data_preprocess",
                    "data_path": str(data_path),
                    "output_dir": str(root / "literal-filter-output"),
                    "arguments": {"method": "filter", "options": {"rules": [{"column": "code", "operator": "contains", "value": "."}]}},
                    "runtime": {"datasetId": "dataset_filter_literal", "stageId": "stage_000", "outputPath": str(output_path)},
                },
            })
            self.assertTrue(response["ok"], response)
            filtered = pd.read_parquet(output_path)
            self.assertEqual(filtered["code"].tolist(), ["A.B"])

    def test_import_keeps_negative_infinity_sentinel_numeric_for_did2s(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "did2s.csv"
            data_path.write_text("unit,year,treat,relative_time\nA,2001,0,-Infinity\nA,2002,1,0\n", encoding="utf-8")
            response = handle_request({
                "protocol_version": 1,
                "request_id": "execute-import-did2s-sentinel-1",
                "operation": "execute",
                "payload": {
                    "method_id": "data_import",
                    "data_path": str(data_path),
                    "output_dir": str(root / "result"),
                    "arguments": {"action": "import"},
                    "runtime": {
                        "inputPath": str(data_path),
                        "outputPath": str(root / "result" / "did2s.parquet"),
                        "datasetId": "dataset_did2s_test",
                        "stageId": "stage_000",
                    },
                },
            })
            self.assertTrue(response["ok"], response)
            imported = pd.read_parquet(response["result"]["payload"]["dataPath"])
            self.assertTrue(pd.api.types.is_numeric_dtype(imported["relative_time"]))
            self.assertTrue(np.isneginf(float(imported.loc[0, "relative_time"])))

    def test_event_study_accepts_nullable_numeric_columns_from_canonical_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "event-study.csv"
            rows = []
            for unit, cohort in (("A", 2004), ("B", 2006), ("C", 0)):
                for year in range(2001, 2009):
                    treated = int(cohort > 0 and year >= cohort)
                    rows.append(f"{unit},{year},{year + treated},{treated},{cohort},{unit}\n")
            source.write_text("unit,year,y,treat,cohort,cluster\n" + "".join(rows), encoding="utf-8")
            imported = handle_request({
                "protocol_version": 1,
                "request_id": "execute-import-event-study-1",
                "operation": "execute",
                "payload": {
                    "method_id": "data_import",
                    "data_path": str(source),
                    "output_dir": str(root / "import"),
                    "arguments": {"action": "import"},
                    "runtime": {
                        "inputPath": str(source),
                        "outputPath": str(root / "import" / "event-study.parquet"),
                        "datasetId": "dataset_event_test",
                        "stageId": "stage_000",
                    },
                },
            })
            self.assertTrue(imported["ok"], imported)
            estimated = handle_request({
                "protocol_version": 1,
                "request_id": "execute-event-study-1",
                "operation": "execute",
                "payload": {
                    "method_id": "did_event_study_saturated",
                    "data_path": imported["result"]["payload"]["dataPath"],
                    "output_dir": str(root / "event-study"),
                    "arguments": {
                        "dependentVar": "y",
                        "treatmentVar": "treat",
                        "cohortVar": "cohort",
                        "entityVar": "unit",
                        "timeVar": "year",
                        "clusterVar": "cluster",
                        "covariates": [],
                    },
                },
            })
            self.assertTrue(estimated["ok"], estimated)

    def test_event_study_retains_missing_cohort_controls_with_confirmed_zero_sentinel(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "event-study-missing-cohort.csv"
            rows = []
            for unit, cohort in (("A", 2004), ("B", 2006), ("C", None), ("D", None), ("E", 2004), ("F", 2006)):
                for year in range(2001, 2009):
                    treated = int(cohort is not None and year >= cohort)
                    rows.append({
                        "unit": unit,
                        "year": year,
                        "y": float(year + treated),
                        "treat": treated,
                        "cohort": cohort,
                        "cluster": unit,
                    })
            pd.DataFrame(rows).to_csv(source, index=False)
            imported = handle_request({
                "protocol_version": 1,
                "request_id": "execute-import-event-study-missing-cohort",
                "operation": "execute",
                "payload": {
                    "method_id": "data_import",
                    "data_path": str(source),
                    "output_dir": str(root / "import"),
                    "arguments": {"action": "import"},
                    "runtime": {
                        "inputPath": str(source),
                        "outputPath": str(root / "import" / "event-study.parquet"),
                        "datasetId": "dataset_event_missing_cohort_test",
                        "stageId": "stage_000",
                    },
                },
            })
            self.assertTrue(imported["ok"], imported)
            canonical_path = Path(imported["result"]["payload"]["dataPath"])
            source_hash = canonical_path.read_bytes()
            estimated = handle_request({
                "protocol_version": 1,
                "request_id": "execute-event-study-missing-cohort",
                "operation": "execute",
                "payload": {
                    "method_id": "did_event_study_saturated",
                    "data_path": str(canonical_path),
                    "output_dir": str(root / "event-study"),
                    "arguments": {
                        "dependentVar": "y",
                        "treatmentVar": "treat",
                        "cohortVar": "cohort",
                        "entityVar": "unit",
                        "timeVar": "year",
                        "clusterVar": "cluster",
                        "neverTreatedCohortValue": 0,
                        "covariates": [],
                    },
                },
            })

            self.assertTrue(estimated["ok"], estimated)
            self.assertEqual(estimated["result"]["payload"]["rowsUsed"], len(rows))
            self.assertIn("从未处理", " ".join(estimated["result"]["payload"]["warnings"]))
            self.assertEqual(canonical_path.read_bytes(), source_hash)

    def test_did2s_accepts_arrow_string_clusters_from_canonical_stage(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "did2s.csv"
            rows = []
            for unit, cohort in (("A", 2004), ("B", 2006), ("C", 0), ("D", 0), ("E", 2004), ("F", 2006)):
                for year in range(2001, 2009):
                    treated = int(cohort > 0 and year >= cohort)
                    relative_time = year - cohort if cohort > 0 else "-Infinity"
                    rows.append(f"{unit},{year},{year + treated},{treated},{cohort},{relative_time},{unit}\n")
            source.write_text("unit,year,y,treat,cohort,relative_time,cluster\n" + "".join(rows), encoding="utf-8")
            imported = handle_request({
                "protocol_version": 1,
                "request_id": "execute-import-did2s-cluster-1",
                "operation": "execute",
                "payload": {
                    "method_id": "data_import",
                    "data_path": str(source),
                    "output_dir": str(root / "import"),
                    "arguments": {"action": "import"},
                    "runtime": {
                        "inputPath": str(source),
                        "outputPath": str(root / "import" / "did2s.parquet"),
                        "datasetId": "dataset_did2s_cluster_test",
                        "stageId": "stage_000",
                    },
                },
            })
            self.assertTrue(imported["ok"], imported)
            estimated = handle_request({
                "protocol_version": 1,
                "request_id": "execute-did2s-cluster-1",
                "operation": "execute",
                "payload": {
                    "method_id": "did2s",
                    "data_path": imported["result"]["payload"]["dataPath"],
                    "output_dir": str(root / "did2s"),
                    "arguments": {
                        "dependentVar": "y",
                        "treatmentVar": "treat",
                        "relativeTimeVar": "relative_time",
                        "entityVar": "unit",
                        "timeVar": "year",
                        "clusterVar": "cluster",
                        "covariates": [],
                        "referencePeriod": -1,
                    },
                },
            })
            self.assertTrue(estimated["ok"], estimated)

    def test_did2s_preserves_never_treated_rows_when_optional_cohort_is_missing(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "did2s-never-treated.csv"
            rows = []
            cohorts = [(f"treated_2004_{index}", 2004) for index in range(4)]
            cohorts += [(f"treated_2006_{index}", 2006) for index in range(4)]
            cohorts += [(f"never_{index}", None) for index in range(4)]
            for unit_index, (unit, cohort) in enumerate(cohorts):
                for year in range(2001, 2009):
                    treated = int(cohort is not None and year >= cohort)
                    outcome = 0.25 * year + unit_index * 0.2 + 1.5 * treated
                    relative_time = year - cohort if cohort is not None else float("-inf")
                    rows.append({
                        "unit": unit,
                        "year": year,
                        "outcome": outcome,
                        "treated": treated,
                        "cohort": cohort,
                        "relative_time": relative_time,
                        "cluster": unit,
                    })
            pd.DataFrame(rows).to_csv(data_path, index=False)

            response = handle_request({
                "protocol_version": 2,
                "request_id": "did2s-null-cohort-never-treated",
                "operation": "execute",
                "payload": {
                    "method_id": "did2s",
                    "data_path": str(data_path),
                    "output_dir": str(root / "did2s-result"),
                    "arguments": {
                        "dependentVar": "outcome",
                        "treatmentVar": "treated",
                        "entityVar": "unit",
                        "timeVar": "year",
                        "cohortVar": "cohort",
                        "relativeTimeVar": "relative_time",
                        "clusterVar": "cluster",
                        "referencePeriod": -1,
                        "covariates": [],
                    },
                },
            })

            self.assertTrue(response["ok"], response)
            self.assertEqual(response["result"]["payload"]["rowsUsed"], len(rows))
            self.assertEqual(response["result"]["payload"]["method"], "did2s")


if __name__ == "__main__":
    unittest.main()
