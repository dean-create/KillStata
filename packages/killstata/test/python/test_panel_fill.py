"""
面板前向/后向填充分组正确性测试（本轮挖出的 1B：静默跨个体污染）。

背景：forward_fill / backward_fill 底层是全表 df[col].ffill()，不按个体分组。
面板数据（个体聚集排列）下，pandas 的 ffill 会把上一个个体末期的值填进下一个个体
首期，产生跨个体数值污染，且不报错。修复后应支持 group_by（entity），组内填充、不跨组。

运行：
  KILLSTATA_PYTHON=/Users/cw/.killstata/venv/bin/python \
    $KILLSTATA_PYTHON packages/killstata/test/python/test_panel_fill.py
"""

import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "killstata-econometrics-engine", "python", "econometrics"))
from data_preprocess import forward_backward_fill  # noqa: E402


def build_panel() -> pd.DataFrame:
    # City1 六年、City2 六年，个体聚集排列（最常见的面板布局）
    return pd.DataFrame(
        {
            "city": ["City1"] * 6 + ["City2"] * 6,
            "year": list(range(2015, 2021)) * 2,
            "gdp": [100, 110, 120, 130, 140, 150, None, 210, 220, 230, 240, 250],
        }
    )


def test_forward_fill_does_not_leak_across_entities() -> None:
    """City2 首年缺失，组内没有更早的值可前向填 → 必须保持 NaN，绝不能被 City1 末期污染。"""
    df = build_panel()
    out, _ = forward_backward_fill(df, columns=["gdp"], direction="forward", group_by=["city"])
    city2_first = out.loc[out["city"] == "City2", "gdp"].iloc[0]
    assert pd.isna(city2_first), f"City2 首年应保持 NaN，却被填成 {city2_first}（疑似跨个体污染）"


def test_forward_fill_still_fills_within_entity() -> None:
    """组内的缺失应正常前向填充：City1 2017 缺失 → 用 2016 的 110 填。"""
    df = build_panel()
    df.loc[2, "gdp"] = None  # City1 2017
    out, _ = forward_backward_fill(df, columns=["gdp"], direction="forward", group_by=["city"])
    assert out.loc[2, "gdp"] == 110, f"City1 2017 应被组内前值 110 填充，实际 {out.loc[2, 'gdp']}"


def test_backward_fill_does_not_leak_across_entities() -> None:
    """对称验证后向填充：City1 末年缺失，组内没有更晚的值 → 保持 NaN，不能借用 City2 首期。"""
    df = build_panel()
    df.loc[5, "gdp"] = None  # City1 2020（末年）
    out, _ = forward_backward_fill(df, columns=["gdp"], direction="backward", group_by=["city"])
    city1_last = out.loc[5, "gdp"]
    assert pd.isna(city1_last), f"City1 末年应保持 NaN，却被填成 {city1_last}（疑似跨个体污染）"


def test_no_group_by_keeps_flat_behavior() -> None:
    """非面板（无 group_by）时保持原全表填充行为，不破坏时间序列等正常用法。"""
    df = pd.DataFrame({"y": [1.0, None, 3.0]})
    out, _ = forward_backward_fill(df, columns=["y"], direction="forward", group_by=None)
    assert out.loc[1, "y"] == 1.0


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
