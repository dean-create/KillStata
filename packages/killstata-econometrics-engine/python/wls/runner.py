"""Deterministic statsmodels WLS adapter for KillStata model-facing tools.

对连续结果变量做加权最小二乘估计（WLS）。与 OLS 基本一致，唯一的额外参数是一个
权重列名——用户显式提供权重，模型无权生成。权重必须是严格正的有限数值；零权重
等同于改变有效样本，不能被静默当作排除观测的授权。

与 OLS 共享结果格式：同尺度的系数、标准误、t 值、p 值、置信区间。返回额外包含
权重列的摘要（最小/最大/中位数权重）。
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import statsmodels
import statsmodels.api as sm


def json_safe(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (np.integer, np.floating)):
        value = value.item()
    if isinstance(value, float):
        return None if (value != value or value == float("inf") or value == -float("inf")) else value
    return value


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
    data_path = payload["dataPath"]
    frame = load_frame(data_path)

    if frame.columns.duplicated().any():
        dups = frame.columns[frame.columns.duplicated()].tolist()
        raise ValueError(f"数据中存在重复列名：{', '.join(map(str, dups))}")

    dep = payload["dependentVar"]
    treat = payload["treatmentVar"]
    covars = payload.get("covariates", [])
    weights_col = payload.get("weightsVar")
    if not weights_col:
        raise ValueError("加权最小二乘必须指定权重列（weightsVar），且权重必须由用户提供")

    all_cols: list[str] = [dep, treat, weights_col, *covars]
    seen: dict[str, None] = {}
    for name in all_cols:
        seen.setdefault(name, None)
    all_cols = list(seen.keys())

    missing = [name for name in all_cols if name not in frame.columns]
    if missing:
        raise ValueError(f"数据中找不到变量：{', '.join(missing)}")

    source_weights = pd.to_numeric(frame[weights_col], errors="coerce")
    missing_weight_rows = int(source_weights.isna().sum())
    if missing_weight_rows:
        raise ValueError(f"权重列含 {missing_weight_rows} 行缺失或非数值；WLS 不会静默删除缺少权重的观测")
    source_weight_values = source_weights.to_numpy(dtype=float)
    if not np.isfinite(source_weight_values).all():
        raise ValueError("权重列包含非有限值（inf/nan），请先清洗")
    if (source_weight_values <= 0).any():
        invalid_count = int((source_weight_values <= 0).sum())
        raise ValueError(f"权重列含 {invalid_count} 个零或负值；WLS 权重必须严格为正，不能静默排除观测")

    rows_input = int(len(frame))
    sub = frame.loc[:, all_cols].dropna().copy()
    if sub.empty:
        raise ValueError("所选变量删除缺失值后没有可用样本")

    weights = sub[weights_col].astype(float)
    zero_weight_count = 0

    y = sub[dep].astype(float).values
    design_names = [treat, *covars]
    X = sm.add_constant(sub[design_names].astype(float).values, has_constant="add")
    w = weights.values

    n_obs, n_params = X.shape
    if n_obs <= n_params:
        raise ValueError("样本量相对解释变量个数过少，无法稳定估计")
    rank = int(np.linalg.matrix_rank(X))
    if rank < n_params:
        raise ValueError(f"设计矩阵秩亏（rank={rank}，列数={n_params}），存在完全共线性")

    covariance = payload.get("covariance", "nonrobust")

    try:
        model = sm.WLS(y, X, weights=w)
        if covariance == "robust":
            fit = model.fit(cov_type="HC1")
        else:
            fit = model.fit(cov_type="nonrobust")
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"加权最小二乘估计失败：{exc}") from exc

    conf_int = fit.conf_int()

    # 列名：const, treat, covars...
    col_labels = ["const", treat, *covars]
    coefficients: list[dict[str, Any]] = []
    for idx, label in enumerate(col_labels[:n_params]):
        coefficients.append({
            "term": label,
            "estimate": json_safe(fit.params[idx]),
            "stdError": json_safe(fit.bse[idx]),
            "statistic": json_safe(fit.tvalues[idx]),
            "pValue": json_safe(fit.pvalues[idx]),
            "confLow": json_safe(conf_int[idx, 0]),
            "confHigh": json_safe(conf_int[idx, 1]),
        })

    primary = next((c for c in coefficients if c["term"] == treat), None)

    rows_used = int(fit.nobs)
    rsquared = json_safe(fit.rsquared)
    adj_rsquared = json_safe(fit.rsquared_adj)

    warnings: list[str] = []

    result = {
        "success": True,
        "method": method,
        "backend": "statsmodels",
        "statsmodelsVersion": statsmodels.__version__,
        "rowsInput": rows_input,
        "rowsUsed": rows_used,
        "droppedRows": rows_input - rows_used,
        "covariance": "HC1" if covariance == "robust" else "nonrobust",
        "weightSummary": {
            "minWeight": json_safe(float(weights.min())),
            "maxWeight": json_safe(float(weights.max())),
            "medianWeight": json_safe(float(weights.median())),
            "zeroCount": zero_weight_count,
        },
        "rsquared": rsquared,
        "adjRsquared": adj_rsquared,
        "coefficients": coefficients,
        "primary": primary,
        "warnings": warnings,
    }

    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    result_path = output_dir / "results.json"
    coefficients_path = output_dir / "coefficients.csv"
    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    pd.DataFrame(coefficients).to_csv(coefficients_path, index=False, encoding="utf-8-sig")
    result["resultPath"] = str(result_path)
    result["coefficientsPath"] = str(coefficients_path)
    return result


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
        if payload.get("method") not in {"wls_regression", "weighted_least_squares"}:
            raise ValueError(f"不支持的方法：{payload.get('method')}")
        result = build_result(payload)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        return
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
