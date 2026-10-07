"""受管数据预处理 runner 的协议测试。"""

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pandas as pd


RUNNER = Path(__file__).resolve().parents[2] / "python" / "preprocess" / "runner.py"


def invoke(payload: dict) -> dict:
    completed = subprocess.run(
        [sys.executable, str(RUNNER)],
        input=json.dumps(payload),
        text=True,
        capture_output=True,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    lines = [line for line in completed.stdout.splitlines() if line.strip()]
    assert len(lines) == 1, f"runner stdout must contain exactly one JSON line, got: {completed.stdout!r}"
    return json.loads(lines[0])


def with_source_frame(callback) -> None:
    with tempfile.TemporaryDirectory(prefix="killstata-preprocess-runner-") as temp:
        root = Path(temp)
        source = root / "source.csv"
        pd.DataFrame(
            {
                "id": [1, 2, 3, 4, 5],
                "income": [1.0, 2.0, None, 4.0, 100.0],
                "x": [1.0, 2.0, 3.0, 4.0, 5.0],
            }
        ).to_csv(source, index=False)
        callback(root, source)


def test_winsorize_writes_a_structured_result_and_parquet() -> None:
    def run(root: Path, source: Path) -> None:
        output = root / "result.parquet"
        result = invoke(
            {
                "method": "winsorize",
                "dataPath": str(source),
                "outputPath": str(output),
                "columns": ["income"],
                "options": {"lower": 0.25, "upper": 0.25},
            }
        )
        assert result["success"] is True
        assert result["method"] == "winsorize"
        assert result["rows_before"] == 5
        assert result["rows_after"] == 5
        assert output.exists()
        assert pd.read_parquet(output)["income"].max() < 100.0

    with_source_frame(run)


def test_zscore_detect_handles_missing_values_and_caps_examples() -> None:
    def run(root: Path, source: Path) -> None:
        result = invoke(
            {
                "method": "zscore_detect",
                "dataPath": str(source),
                "outputPath": str(root / "ignored.parquet"),
                "columns": ["income"],
                "options": {"threshold": 1.0},
            }
        )
        assert result["success"] is True
        assert result["method"] == "zscore_detect"
        assert result["detected"]["income"]["count"] >= 1
        assert len(result["detected"]["income"]["sample_indices"]) <= 20

    with_source_frame(run)


def test_log_transform_rejects_an_invalid_domain_without_traceback() -> None:
    def run(root: Path, source: Path) -> None:
        result = invoke(
            {
                "method": "log_transform",
                "dataPath": str(source),
                "outputPath": str(root / "result.parquet"),
                "columns": ["income"],
                "options": {"offset": -2.0},
            }
        )
        assert result["success"] is False
        assert result["error_code"] == "INVALID_DOMAIN"
        assert "traceback" not in result

    with_source_frame(run)


def test_log_transform_keeps_the_source_column_and_creates_the_requested_suffix() -> None:
    def run(root: Path, source: Path) -> None:
        output = root / "result.parquet"
        result = invoke(
            {
                "method": "log_transform",
                "dataPath": str(source),
                "outputPath": str(output),
                "columns": ["income"],
                "options": {"offset": 1.0, "suffix": "_ln"},
            }
        )
        assert result["success"] is True
        frame = pd.read_parquet(output)
        assert frame["income"].tolist()[:2] == [1.0, 2.0]
        assert "income_ln" in frame.columns
        assert "income" not in result["new_columns"]

    with_source_frame(run)


def test_all_hidden_methods_still_delegate_to_the_shared_core() -> None:
    """14 个方法即使暂不暴露给模型，也必须在唯一核心上持续可运行。"""
    with tempfile.TemporaryDirectory(prefix="killstata-preprocess-full-contract-") as temp:
        root = Path(temp)
        source = root / "source.csv"
        pd.DataFrame({"id": [1, 2, 3, 4, 5], "x": [1.0, 2.0, 3.0, 4.0, 100.0], "y": [2.0, 3.0, 4.0, 5.0, 6.0]}).to_csv(source, index=False)
        methods = {
            "knn_impute": {"k": 2}, "iqr_detect": {"factor": 1.5}, "trim": {"lower": 0.1, "upper": 0.1},
            "minmax_scale": {"suffix": "_mm"}, "robust_scale": {"suffix": "_rs"},
            "boxcox_transform": {"suffix": "_bc", "shift": 0.0}, "yeojohnson_transform": {"suffix": "_yj"},
        }
        for method, options in methods.items():
            result = invoke({"method": method, "dataPath": str(source), "outputPath": str(root / f"{method}.parquet"), "columns": ["x"], "options": options})
            assert result["success"] is True, f"{method}: {result}"


def test_rejects_an_existing_output_suffix_before_overwriting_source_data() -> None:
    with tempfile.TemporaryDirectory(prefix="killstata-preprocess-collision-") as temp:
        root = Path(temp)
        source = root / "source.csv"
        pd.DataFrame({"income": [1.0, 2.0, 3.0], "income_ln": [0.0, 0.69, 1.10]}).to_csv(source, index=False)
        result = invoke(
            {
                "method": "log_transform",
                "dataPath": str(source),
                "outputPath": str(root / "result.parquet"),
                "columns": ["income"],
                "options": {"offset": 1.0, "suffix": "_ln"},
            }
        )
        assert result["success"] is False
        assert result["error_code"] == "COLUMN_COLLISION"
        assert not (root / "result.parquet").exists()


def _run() -> int:
    tests = [obj for name, obj in sorted(globals().items()) if name.startswith("test_") and callable(obj)]
    failures = 0
    for test in tests:
        try:
            test()
            print(f"PASS {test.__name__}")
        except AssertionError as exc:
            failures += 1
            print(f"FAIL {test.__name__}: {exc}")
        except Exception as exc:  # noqa: BLE001
            failures += 1
            print(f"ERROR {test.__name__}: {type(exc).__name__}: {exc}")
    print(f"\n{len(tests) - failures}/{len(tests)} passed")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_run())
