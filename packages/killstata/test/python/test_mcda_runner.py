"""MCDA runner 的进程级协议与数学安全门测试。

本文件刻意通过 stdin/stdout 调用 runner，而不是直接导入内部函数：这才覆盖
TypeScript Harness 实际启动的 Python 进程边界。运行：

  KILLSTATA_PYTHON=/Users/cw/.killstata/venv/bin/python \
    $KILLSTATA_PYTHON packages/killstata/test/python/test_mcda_runner.py
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


REPO_ROOT = Path(__file__).resolve().parents[4]
RUNNER = REPO_ROOT / "packages" / "killstata-econometrics-engine" / "python" / "mcda" / "runner.py"


def base_frame() -> pd.DataFrame:
    # 两列在明确方向正向化后完全相同；所以熵权应相等，TOPSIS 排名也必须严格单调。
    return pd.DataFrame(
        {
            "id": ["A", "B", "C", "D"],
            "benefit": [1.0, 2.0, 3.0, 4.0],
            "cost": [4.0, 3.0, 2.0, 1.0],
        }
    )


def run_runner(payload: dict[str, Any]) -> tuple[int, dict[str, Any], str]:
    proc = subprocess.run(
        [sys.executable, str(RUNNER)],
        input=json.dumps(payload, ensure_ascii=False),
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.stdout.strip(), f"runner 没有输出 JSON；stderr={proc.stderr!r}"
    return proc.returncode, json.loads(proc.stdout), proc.stderr


def valid_payload(tmp: Path, method: str, frame: pd.DataFrame | None = None) -> dict[str, Any]:
    data_path = tmp / "input.csv"
    (frame if frame is not None else base_frame()).to_csv(data_path, index=False)
    return {
        "method": method,
        "dataPath": str(data_path),
        "outputDir": str(tmp / "output"),
        "idColumns": ["id"],
        "indicators": [
            {"column": "benefit", "direction": "benefit"},
            {"column": "cost", "direction": "cost"},
        ],
        "scope": "global",
    }


def require_rejection(payload: dict[str, Any], expected: str) -> None:
    code, response, stderr = run_runner(payload)
    assert code == 0, stderr
    assert response["success"] is False
    assert expected in response["message"], response["message"]
    # 失败不许留下看似可用的子 stage 表格。
    assert not (Path(payload["outputDir"]) / "scores.parquet").exists()


def test_entropy_weight_writes_parquet_with_directional_score_and_equal_weights() -> None:
    with tempfile.TemporaryDirectory() as raw:
        payload = valid_payload(Path(raw), "entropy_weight")
        code, response, stderr = run_runner(payload)

        assert code == 0, stderr
        assert stderr == ""
        assert response["success"] is True
        assert response["method"] == "entropy_weight"
        assert response["scoreColumn"] == "ks_entropy_weight_score"
        assert response["rankColumn"] == "ks_entropy_weight_rank"
        assert response["groupCount"] == 1
        assert [entry["column"] for entry in response["weights"]] == ["benefit", "cost"]
        np.testing.assert_allclose([entry["weight"] for entry in response["weights"]], [0.5, 0.5], atol=1e-12)
        assert Path(response["scoresPath"]).is_file()
        assert Path(response["resultPath"]).is_file()

        scores = pd.read_parquet(response["scoresPath"])
        assert scores["id"].tolist() == ["A", "B", "C", "D"]
        np.testing.assert_allclose(scores["ks_entropy_weight_score"], [0.0, 1 / 3, 2 / 3, 1.0], atol=1e-12)
        assert scores["ks_entropy_weight_rank"].tolist() == [4, 3, 2, 1]


def test_topsis_uses_manual_weights_and_returns_bounded_closeness() -> None:
    with tempfile.TemporaryDirectory() as raw:
        payload = valid_payload(Path(raw), "topsis")
        payload["weightSource"] = "manual"
        payload["manualWeights"] = {"benefit": 0.5, "cost": 0.5}
        code, response, stderr = run_runner(payload)

        assert code == 0, stderr
        assert response["success"] is True
        assert response["weightSource"] == "manual"
        scores = pd.read_parquet(response["scoresPath"])
        values = scores["ks_topsis_score"].to_numpy(dtype=float)
        assert np.all((0.0 <= values) & (values <= 1.0))
        np.testing.assert_allclose(values, [0.0, 1 / 3, 2 / 3, 1.0], atol=1e-12)
        assert scores["ks_topsis_rank"].tolist() == [4, 3, 2, 1]


def test_topsis_requires_an_explicit_weight_source() -> None:
    with tempfile.TemporaryDirectory() as raw:
        payload = valid_payload(Path(raw), "topsis")
        require_rejection(payload, "必须明确提供 weightSource")


def test_topsis_is_row_order_and_positive_unit_scale_invariant() -> None:
    with tempfile.TemporaryDirectory() as raw:
        root = Path(raw)
        original = valid_payload(root, "topsis")
        original["weightSource"] = "equal"
        _, first, _ = run_runner(original)
        base = pd.read_parquet(first["scoresPath"]).set_index("id")["ks_topsis_rank"].to_dict()
        scaled = base_frame().sample(frac=1, random_state=7).copy()
        scaled["benefit"] *= 1000
        scaled["cost"] *= 0.1
        second = valid_payload(root, "topsis", scaled)
        second["outputDir"] = str(root / "scaled")
        second["weightSource"] = "equal"
        _, response, _ = run_runner(second)
        assert response["success"] is True
        actual = pd.read_parquet(response["scoresPath"]).set_index("id")["ks_topsis_rank"].to_dict()
        assert actual == base


def test_topsis_never_ranks_a_strictly_dominated_alternative_above_its_dominator() -> None:
    frame = pd.DataFrame(
        {
            "id": ["dominates", "dominated", "tradeoff"],
            "benefit_a": [10.0, 9.0, 5.0],
            "benefit_b": [10.0, 9.0, 15.0],
        }
    )
    with tempfile.TemporaryDirectory() as raw:
        payload = valid_payload(Path(raw), "topsis", frame)
        payload["indicators"] = [
            {"column": "benefit_a", "direction": "benefit"},
            {"column": "benefit_b", "direction": "benefit"},
        ]
        payload["weightSource"] = "manual"
        payload["manualWeights"] = {"benefit_a": 0.5, "benefit_b": 0.5}
        _, response, _ = run_runner(payload)
        assert response["success"] is True
        ranks = pd.read_parquet(response["scoresPath"]).set_index("id")["ks_topsis_rank"]
        assert int(ranks["dominates"]) < int(ranks["dominated"])


def test_topsis_gives_equal_scores_the_same_rank() -> None:
    frame = pd.DataFrame(
        {
            "id": ["same_a", "same_b", "other"],
            "benefit": [10.0, 10.0, 5.0],
            "cost": [2.0, 2.0, 8.0],
        }
    )
    with tempfile.TemporaryDirectory() as raw:
        payload = valid_payload(Path(raw), "topsis", frame)
        payload["weightSource"] = "equal"
        _, response, _ = run_runner(payload)
        assert response["success"] is True
        scores = pd.read_parquet(response["scoresPath"]).set_index("id")
        assert scores.loc["same_a", "ks_topsis_score"] == scores.loc["same_b", "ks_topsis_score"]
        assert scores.loc["same_a", "ks_topsis_rank"] == scores.loc["same_b", "ks_topsis_rank"]


def test_by_group_scores_and_ranks_are_calculated_independently() -> None:
    frame = pd.DataFrame(
        {
            "id": ["A", "B", "C", "D", "E", "F"],
            "group": ["east"] * 3 + ["west"] * 3,
            "benefit": [1.0, 2.0, 3.0, 30.0, 20.0, 10.0],
            "cost": [3.0, 2.0, 1.0, 10.0, 20.0, 30.0],
        }
    )
    with tempfile.TemporaryDirectory() as raw:
        payload = valid_payload(Path(raw), "topsis", frame)
        payload["scope"] = "by_group"
        payload["groupColumns"] = ["group"]
        payload["weightSource"] = "equal"
        code, response, stderr = run_runner(payload)

        assert code == 0, stderr
        assert response["success"] is True
        assert response["groupCount"] == 2
        scores = pd.read_parquet(response["scoresPath"])
        assert scores.groupby("group")["ks_topsis_rank"].apply(list).to_dict() == {
            "east": [3, 2, 1],
            "west": [1, 2, 3],
        }


def test_by_group_preview_never_compares_scores_across_groups() -> None:
    frame = pd.DataFrame(
        {
            "id": ["A", "B", "C", "D", "E", "F", "G", "H"],
            "period": [2020] * 4 + [2021] * 4,
            "benefit": [1.0, 2.0, 3.0, 4.0, 4.0, 3.0, 2.0, 1.0],
            "cost": [4.0, 3.0, 2.0, 1.0, 1.0, 2.0, 3.0, 4.0],
        }
    )
    with tempfile.TemporaryDirectory() as raw:
        payload = valid_payload(Path(raw), "topsis", frame)
        payload["scope"] = "by_group"
        payload["groupColumns"] = ["period"]
        payload["weightSource"] = "equal"
        code, response, stderr = run_runner(payload)

        assert code == 0, stderr
        assert response["success"] is True
        assert response["top"] == []
        assert response["bottom"] == []
        previews = response["topByGroup"]
        assert set(previews) == {"period=2020", "period=2021"}
        assert [row["id"] for row in previews["period=2020"]] == ["D", "C", "B", "A"]
        assert [row["id"] for row in previews["period=2021"]] == ["E", "F", "G", "H"]


def test_rejects_missing_indicator_values_before_writing_output() -> None:
    frame = base_frame()
    frame.loc[1, "benefit"] = np.nan
    with tempfile.TemporaryDirectory() as raw:
        require_rejection(valid_payload(Path(raw), "entropy_weight", frame), "缺失值")


def test_rejects_infinite_indicator_values_before_writing_output() -> None:
    frame = base_frame()
    frame.loc[1, "benefit"] = np.inf
    with tempfile.TemporaryDirectory() as raw:
        require_rejection(valid_payload(Path(raw), "entropy_weight", frame), "非有限值")


def test_rejects_constant_indicator() -> None:
    frame = base_frame()
    frame["cost"] = 1.0
    with tempfile.TemporaryDirectory() as raw:
        require_rejection(valid_payload(Path(raw), "entropy_weight", frame), "常数指标")


def test_rejects_duplicate_identifier() -> None:
    frame = base_frame()
    frame.loc[1, "id"] = "A"
    with tempfile.TemporaryDirectory() as raw:
        require_rejection(valid_payload(Path(raw), "entropy_weight", frame), "存在重复")


def test_rejects_indicator_without_direction() -> None:
    with tempfile.TemporaryDirectory() as raw:
        payload = valid_payload(Path(raw), "entropy_weight")
        del payload["indicators"][1]["direction"]
        require_rejection(payload, "direction")


def test_rejects_pathological_manual_weights() -> None:
    with tempfile.TemporaryDirectory() as raw:
        payload = valid_payload(Path(raw), "topsis")
        payload["weightSource"] = "manual"
        payload["manualWeights"] = {"benefit": 0.9, "cost": 0.05}
        require_rejection(payload, "和必须为 1")


def test_rejects_group_with_fewer_than_three_rows() -> None:
    frame = base_frame()
    frame["group"] = ["east", "east", "west", "west"]
    with tempfile.TemporaryDirectory() as raw:
        payload = valid_payload(Path(raw), "topsis", frame)
        payload["scope"] = "by_group"
        payload["groupColumns"] = ["group"]
        require_rejection(payload, "至少需要 3 行")


def test_rejects_group_columns_when_scope_is_global() -> None:
    with tempfile.TemporaryDirectory() as raw:
        payload = valid_payload(Path(raw), "entropy_weight")
        payload["groupColumns"] = ["id"]
        require_rejection(payload, "scope=global")


def test_rejects_existing_score_or_rank_columns_without_overwriting_source_data() -> None:
    frame = base_frame()
    frame["ks_topsis_score"] = 0.0
    with tempfile.TemporaryDirectory() as raw:
        payload = valid_payload(Path(raw), "topsis", frame)
        require_rejection(payload, "输出列已存在")


def _run() -> int:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
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
