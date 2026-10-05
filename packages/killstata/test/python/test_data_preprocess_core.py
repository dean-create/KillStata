"""数据处理核心的数值与安全合同。

运行：
  python3 packages/killstata/test/python/test_data_preprocess_core.py
"""

import os
import sys

import numpy as np
import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "killstata-econometrics-engine", "python", "econometrics"))
from data_preprocess import (  # noqa: E402
    build_quality_report,
    detect_iqr_outliers,
    detect_zscore_outliers,
    fill_missing_statistics,
    log_transform_columns,
    standardize_columns,
)


def test_log_transform_rejects_non_positive_domain() -> None:
    frame = pd.DataFrame({"income": [-1.0, 0.0, 3.0]})
    try:
        log_transform_columns(frame, columns=["income"], offset=1.0)
    except ValueError as exc:
        assert "positive" in str(exc).lower()
        return
    raise AssertionError("log transform must reject x + offset <= 0 instead of writing -inf/NaN")


def test_median_impute_rejects_an_all_missing_column() -> None:
    frame = pd.DataFrame({"income": [np.nan, np.nan]})
    try:
        fill_missing_statistics(frame, columns=["income"], strategy="median")
    except ValueError as exc:
        assert "all missing" in str(exc).lower()
        return
    raise AssertionError("median imputation must not claim success when no value can be imputed")


def test_standardize_uses_population_scale_for_cross_library_contract() -> None:
    frame = pd.DataFrame({"x": [1.0, 2.0, 3.0]})
    output, _ = standardize_columns(frame, columns=["x"], suffix="_z")
    expected = np.array([-1.224744871391589, 0.0, 1.224744871391589])
    assert np.allclose(output["x_z"].to_numpy(), expected, atol=1e-12)


def test_outlier_detection_keeps_original_row_indices_when_missing_values_exist() -> None:
    """检测算法也必须在唯一核心中，并且不能因 dropna 让异常行号错位。"""
    frame = pd.DataFrame({"x": [1.0, np.nan, 2.0, 3.0, 100.0]})
    zscore = detect_zscore_outliers(frame, columns=["x"], threshold=1.0)
    iqr = detect_iqr_outliers(frame, columns=["x"], factor=1.0)
    assert zscore["x"]["sample_indices"] == [4]
    assert iqr["x"]["sample_indices"] == [4]


def test_duplicate_entity_time_resolvable_by_a_hierarchy_column_is_not_reported_as_a_true_duplicate() -> None:
    """2026-08-12 gf.xlsx 事故的回归锁。

    真实现场：("地区","年份") 上有 115 个重复对，但重复的地区全部叫"其他"，分属 6 个不同
    省份（北京/天津/山西/黑龙江/上海/西藏），是 6 个完全独立的观测单位——不是重复记录。
    旧版本 build_quality_report 只报告"发现 115 条重复"，把"是否真实重复"这个可以用一行
    pandas 代码确定性回答的问题丢给模型/用户去猜；模型据此向用户提议"删除重复行"并标为
    推荐项，用户选择后会静默损毁这 115 行合法数据。
    修复后：build_quality_report 自己验证候选列，能消解就直接报告消解方案，绝不建议删除。
    """
    provinces = ["北京市", "天津市", "山西省", "黑龙江省", "上海市", "西藏自治区"]
    years = list(range(2000, 2023))
    frame = pd.DataFrame(
        [{"省份": province, "地区": "其他", "年份": year, "指数": hash((province, year)) % 100} for province in provinces for year in years]
    )
    assert int(frame.duplicated(subset=["地区", "年份"]).sum()) == len(years) * (len(provinces) - 1)

    _, report = build_quality_report(frame, entity_var="地区", time_var="年份")

    assert report["status"] == "block"
    assert report["duplicate_key_resolution"] is not None
    assert report["duplicate_key_resolution"]["resolving_column"] == "省份"
    assert report["duplicate_key_resolution"]["composite_entities"] == len(provinces)
    assert len(report["blocking_errors"]) == 1
    message = report["blocking_errors"][0]
    assert "Verified" in message
    assert "'省份'" in message
    assert "not a true duplicate-record issue" in message
    assert "Deduplicate panel keys" not in " ".join(report["suggested_repairs"])


def test_genuine_duplicate_rows_are_still_blocked_without_a_false_resolution() -> None:
    """负面对照：真正的重复记录（没有任何列能消解）必须仍被拦截，不能被误判为可消解。"""
    frame = pd.DataFrame(
        {
            "地区": ["A", "A", "A", "B", "B"],
            "年份": [2020, 2020, 2021, 2020, 2021],
            "备注": ["x", "x", "y", "z", "w"],
            "指数": [1.0, 2.0, 3.0, 4.0, 5.0],
        }
    )
    _, report = build_quality_report(frame, entity_var="地区", time_var="年份")

    assert report["status"] == "block"
    assert report["duplicate_key_resolution"] is None
    assert report["blocking_errors"] == ["Found 1 duplicate entity-time rows"]
    assert "Deduplicate panel keys" in " ".join(report["suggested_repairs"])


def test_outlier_warning_does_not_claim_unmodeled_columns_have_no_effect() -> None:
    frame = pd.DataFrame({"y": [0.0] * 100 + [1000.0], "x": list(range(101))})
    _, report = build_quality_report(frame)
    warning = " ".join(report["warnings"])
    assert "不进入回归则忽略" not in warning
    assert "未纳入本次规格" in warning
    assert "遗漏变量影响未被本次模型评估" in warning


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
