"""Deterministic rdrobust sharp RDD adapter for KillStata model-facing tools.

对锐性断点回归（Sharp RDD）做局部多项式估计：以 rdrobust（Calonico-Cattaneo-Titiunik）
为后端，采用 MSE 最优带宽（mserd）+ 三角核 + 局部一次多项式的行业标准设定，返回
conventional 点估计与 bias-corrected/robust 稳健推断。

与 GLM/count/quantile/panel 适配器同构：模型只发结构化字段（结果变量、驱动变量、
断点位置、可选控制变量），绝不发明公式或带宽。适配器负责校验驱动变量在断点两侧都有
观测、结果/驱动变量为数值，然后跑 rdrobust 并抽取结构化系数。

为什么不暴露带宽/核/多项式阶：这些是方法学决策，暴露给模型只会让它乱调导致不可复现。
锁定为 rdrobust 默认（mserd 带宽 + 三角核 + p=1），这也是 CCT 教材复现 Senate 例子的设定。
"""

from __future__ import annotations

import json
import math
import sys
import warnings
from pathlib import Path
from typing import Any

import pandas as pd


def scalar(value: Any) -> Any:
    try:
        import numpy as np
        if isinstance(value, (np.integer, np.floating)):
            value = value.item()
    except Exception:
        pass
    if value is None:
        return None
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def load_frame(data_path: str) -> pd.DataFrame:
    suffix = Path(data_path).suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(data_path)
    if suffix in {".xlsx", ".xls"}:
        return pd.read_excel(data_path)
    if suffix == ".dta":
        return pd.read_stata(data_path)
    if suffix == ".parquet":
        return pd.read_parquet(data_path)
    raise ValueError(f"不支持的数据格式：{suffix or '未知格式'}")


def build_result(payload: dict[str, Any]) -> dict[str, Any]:
    method = payload["method"]
    is_fuzzy = method == "rdd_fuzzy"
    if method not in ("rdd_sharp", "rdd_fuzzy"):
        raise ValueError(f"不支持的方法：{method}")

    dependent = payload["dependentVar"]
    running = payload["runningVar"]
    cutoff = float(payload["cutoff"])
    covariates: list[str] = list(payload.get("covariates", []))
    fuzzy_var: str | None = payload.get("fuzzyVar", None)
    cluster_var: str | None = payload.get("clusterVar", None)

    if is_fuzzy and not fuzzy_var:
        raise ValueError("模糊断点回归（rdd_fuzzy）必须指定 fuzzyVar（是否接受处理的二分变量）")
    if not is_fuzzy and fuzzy_var:
        raise ValueError("锐性断点回归（rdd_sharp）不应有 fuzzyVar")

    if running == dependent:
        raise ValueError("驱动变量不能同时作为结果变量")
    if running in covariates or dependent in covariates:
        raise ValueError("结果变量或驱动变量不能出现在控制变量中")
    if cluster_var and cluster_var in {dependent, running, fuzzy_var, *covariates}:
        raise ValueError("聚类标识必须是独立的分组列，不能兼作结果、运行、处理或控制变量")

    frame = load_frame(payload["dataPath"])
    if frame.columns.duplicated().any():
        dups = frame.columns[frame.columns.duplicated()].tolist()
        raise ValueError(f"数据中存在重复列名：{', '.join(map(str, dups))}")

    columns = [dependent, running, *covariates]
    if fuzzy_var:
        columns.append(fuzzy_var)
    if cluster_var:
        columns.append(cluster_var)
    missing = [c for c in columns if c not in frame.columns]
    if missing:
        raise ValueError(f"数据中找不到变量：{', '.join(missing)}")

    if cluster_var and frame[cluster_var].isna().any():
        missing_clusters = int(frame[cluster_var].isna().sum())
        raise ValueError(f"聚类标识列 {cluster_var} 有 {missing_clusters} 行缺失；请先核对标识，不能静默删除观测后再计算聚类推断")

    rows_input = int(len(frame))
    sub = frame.loc[:, columns].dropna().copy()
    if sub.empty:
        raise ValueError("所选变量删除缺失值后没有可用样本")
    if cluster_var and sub[cluster_var].nunique() < 2:
        raise ValueError(f"聚类标识列 {cluster_var} 少于两个簇，无法计算聚类稳健推断")

    for name in (dependent, running, *covariates):
        if not pd.api.types.is_numeric_dtype(sub[name]):
            raise ValueError(f"变量 {name} 必须是数值型")
    if fuzzy_var and not pd.api.types.is_numeric_dtype(sub[fuzzy_var]):
        raise ValueError(f"fuzzyVar {fuzzy_var} 必须是数值型（0/1 二分推荐）")

    x = sub[running].astype(float)
    # 断点两侧都必须有观测，否则无法识别跳跃
    if (x > cutoff).sum() == 0 or (x < cutoff).sum() == 0:
        raise ValueError(f"驱动变量在断点 {cutoff} 两侧必须都有观测，当前有一侧为空")

    y = sub[dependent].astype(float)
    covs = sub[covariates].astype(float) if covariates else None
    fuzzy = sub[fuzzy_var].astype(float) if fuzzy_var else None

    import contextlib
    import io

    import rdrobust
    # rdrobust 默认往 stdout 打印结果表——重定向掉，保证 stdout 只有本适配器的 JSON。
    with warnings.catch_warnings(), contextlib.redirect_stdout(io.StringIO()):
        warnings.simplefilter("ignore")
        rd_kwargs = {"y": y, "x": x, "c": cutoff, "covs": covs, "fuzzy": fuzzy}
        if cluster_var:
            rd_kwargs.update({"cluster": sub[cluster_var], "vce": "cr1"})
        out = rdrobust.rdrobust(**rd_kwargs)

    # rdrobust 返回 DataFrame 索引为 Conventional/Bias-Corrected/Robust
    coef = out.coef
    se = out.se
    pv = out.pv
    ci = out.ci
    bws = out.bws

    def table_row(
        coefficients: Any,
        standard_errors: Any,
        p_values: Any,
        intervals: Any,
        label: str,
        ci_label: str | None = None,
    ) -> dict[str, Any]:
        c = scalar(coefficients.loc[label].iloc[0])
        s = scalar(standard_errors.loc[label].iloc[0])
        p = scalar(p_values.loc[label].iloc[0])
        lo = scalar(intervals.loc[ci_label or label].iloc[0]) if intervals is not None else None
        hi = scalar(intervals.loc[ci_label or label].iloc[1]) if intervals is not None else None
        return {"estimate": c, "stdError": s, "pValue": p, "confLow": lo, "confHigh": hi}

    def row(label: str, ci_label: str | None = None) -> dict[str, Any]:
        return table_row(coef, se, pv, ci, label, ci_label)

    conventional = row("Conventional")
    bias_corrected = row("Bias-Corrected")
    robust = row("Robust")

    h_left = scalar(bws.loc["h"].iloc[0])
    b_left = scalar(bws.loc["b"].iloc[0])
    n_h = getattr(out, "N_h", None)
    n_left = int(n_h[0]) if n_h is not None else None
    n_right = int(n_h[1]) if n_h is not None else None

    # 统一主结果必须是同一行估计量与推断：Robust 行是偏差校正点估计配稳健 SE/p/CI。
    # 常规与单独的偏差校正结果仍分别返回，禁止把常规点估计和未以其为中心的稳健区间拼接。
    primary = dict(robust)
    first_stage = None
    if is_fuzzy:
        first_stage_tables = (
            getattr(out, "tau_T", None),
            getattr(out, "se_T", None),
            getattr(out, "pv_T", None),
            getattr(out, "ci_T", None),
        )
        if any(table is None for table in first_stage_tables[:3]):
            raise ValueError("rdrobust 未返回模糊断点第一阶段处理跳变结果，不能将该估计作为完整成功结果")
        tau_t, se_t, pv_t, ci_t = first_stage_tables
        first_stage = {
            "conventional": table_row(tau_t, se_t, pv_t, ci_t, "Conventional"),
            "biasCorrected": table_row(tau_t, se_t, pv_t, ci_t, "Bias-Corrected"),
            "robust": table_row(tau_t, se_t, pv_t, ci_t, "Robust"),
        }
        first_stage["primary"] = dict(first_stage["robust"])

    warnings_list: list[str] = []
    if sub[running].nunique() < len(sub):
        warnings_list.append("运行变量存在重复取值；rdrobust 已按默认 masspoints=adjust 处理带宽选择。")
    if n_left is not None and n_right is not None and min(n_left, n_right) < 20:
        warnings_list.append(f"断点一侧有效样本较少（左 {n_left} / 右 {n_right}），局部估计不稳定")

    cluster_count = scalar(getattr(out, "n_clust", None)) if cluster_var else None
    variance_method = scalar(getattr(out, "vce", None))

    result = {
        "success": True,
        "method": method,
        "backend": "rdrobust",
        "rdrobustVersion": _rdrobust_version(),
        "rowsInput": rows_input,
        "rowsUsed": int(len(sub)),
        "cutoff": cutoff,
        "runningVar": running,
        "dependentVar": dependent,
        "fuzzyVar": fuzzy_var,
        "bandwidth": {"h": h_left, "b": b_left},
        "nEffective": {"left": n_left, "right": n_right},
        "conventional": conventional,
        "biasCorrected": bias_corrected,
        "robust": robust,
        "primary": primary,
        "warnings": warnings_list,
    }
    if cluster_var:
        result["clusterVar"] = cluster_var
        result["nClusters"] = cluster_count
        result["varianceMethod"] = variance_method
    if first_stage is not None:
        result["firstStage"] = first_stage

    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    result_path = output_dir / "results.json"
    coefficients_path = output_dir / "coefficients.csv"
    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    rows_out = [
        {"estimator": "conventional", **conventional},
        {"estimator": "bias_corrected", **bias_corrected},
        {"estimator": "robust", **robust},
    ]
    pd.DataFrame(rows_out).to_csv(coefficients_path, index=False, encoding="utf-8-sig")
    # 不要用 .resolve()：macOS 上会把 /var 解析成 /private/var，与 TS path.resolve 对不上。
    result["resultPath"] = str(result_path)
    result["coefficientsPath"] = str(coefficients_path)
    return result


def _rdrobust_version() -> str:
    try:
        from importlib.metadata import version
        return version("rdrobust")
    except Exception:
        return "unknown"


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
        result = build_result(payload)
    except Exception as exc:  # noqa: BLE001 —— 统一转结构化失败，绝不把 traceback 泄漏到对话
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        return
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
