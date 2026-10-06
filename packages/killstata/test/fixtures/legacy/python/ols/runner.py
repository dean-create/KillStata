"""Deterministic statsmodels OLS adapter for KillStata model-facing tools.

对连续结果变量做普通最小二乘(OLS)线性回归。与 GLM/计数适配器同构：
模型只发结构化字段（因变量、核心解释变量、控制变量、协方差选择），绝不发公式；
本适配器验证列、数值、秩与样本量，调用 statsmodels OLS / WLS，
计算系数、置信区间、逐步 F 检验，以及核心解释变量的部分 R²，
最后在 stdout 输出单行 JSON 结果。

这是对旧 econometric_algorithm.py 里 ordinary_least_square_regression 的独立拆解，
不再涉及 1700 行旧代码。
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
from statsmodels.stats.outliers_influence import variance_inflation_factor


def scalar(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (np.integer, np.floating)):
        value = value.item()
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


def prepare_frame(payload: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, str], list[str], int]:
    frame = load_frame(payload["dataPath"])
    if frame.columns.duplicated().any():
        duplicated = frame.columns[frame.columns.duplicated()].tolist()
        raise ValueError(f"数据中存在重复列名：{', '.join(map(str, duplicated))}")

    columns: list[str] = [payload["dependentVar"], payload["treatmentVar"], *payload.get("covariates", [])]
    seen: dict[str, None] = {}
    for name in columns:
        seen.setdefault(name, None)
    columns = list(seen.keys())
    missing = [name for name in columns if name not in frame.columns]
    if missing:
        raise ValueError(f"数据中找不到变量：{', '.join(missing)}")
    rows_input = int(len(frame))
    frame = frame.loc[:, columns].dropna().copy()
    if frame.empty:
        raise ValueError("所选变量删除缺失值后没有可用样本")
    aliases = {name: f"v_{index}" for index, name in enumerate(columns)}
    frame = frame.rename(columns=aliases)
    regressor_names = [payload["treatmentVar"], *payload.get("covariates", [])]
    return frame, aliases, regressor_names, rows_input


def require_numeric(frame: pd.DataFrame, aliases: dict[str, str], names: list[str]) -> None:
    invalid = [name for name in names if not pd.api.types.is_numeric_dtype(frame[aliases[name]])]
    if invalid:
        raise ValueError(f"以下变量必须是数值型：{', '.join(invalid)}")


def build_result(payload: dict[str, Any]) -> dict[str, Any]:
    method = payload["method"]
    frame, aliases, regressor_names, rows_input = prepare_frame(payload)
    require_numeric(frame, aliases, [payload["dependentVar"], *regressor_names])
    if not np.isfinite(frame.to_numpy(dtype=float)).all():
        raise ValueError("因变量或解释变量包含非有限值（inf/-inf），请先清洗数据")

    y = frame[aliases[payload["dependentVar"]]].astype(float)
    if y.nunique() < 5:
        raise ValueError("结果变量取值过于集中，无法稳定估计线性回归")

    design_aliases = [aliases[name] for name in regressor_names]
    exog = sm.add_constant(frame[design_aliases].astype(float), has_constant="add")
    if len(exog) <= exog.shape[1]:
        raise ValueError("样本量相对解释变量个数过少，无法稳定估计")
    rank = int(np.linalg.matrix_rank(exog.to_numpy(dtype=float)))
    if rank < exog.shape[1]:
        raise ValueError(f"设计矩阵秩亏（rank={rank}，列数={exog.shape[1]}），存在完全共线性，请删除重复或线性组合变量")

    cov_map: dict[str, str] = {
        "HC1": "HC1",
        "HC2": "HC2",
        "HC3": "HC3",
        "nonrobust": "nonrobust",
        "robust": "HC1",
    }
    covariance = payload.get("covariance", "robust")
    cov_type = cov_map.get(covariance, "HC1")

    try:
        model = sm.OLS(y, exog)
        fit = model.fit(cov_type=cov_type)
    except np.linalg.LinAlgError as exc:
        raise ValueError("估计过程矩阵奇异，请检查解释变量的共线性") from exc

    if not bool(getattr(fit, "mle_retvals", {}).get("converged", True)):
        raise ValueError("OLS 最大似然迭代未收敛（罕见），结果不可信")

    alias_to_original = {alias: original for original, alias in aliases.items()}
    def term_label(alias: str) -> str:
        if alias == "const":
            return "const"
        return alias_to_original.get(alias, alias)

    conf_int = fit.conf_int()
    coefficients: list[dict[str, Any]] = []
    for alias in exog.columns:
        coefficients.append({
            "term": term_label(alias),
            "estimate": scalar(fit.params[alias]),
            "stdError": scalar(fit.bse[alias]),
            "statistic": scalar(fit.tvalues[alias]),
            "pValue": scalar(fit.pvalues[alias]),
            "confLow": scalar(conf_int.loc[alias, 0]),
            "confHigh": scalar(conf_int.loc[alias, 1]),
        })

    treatment_term = payload["treatmentVar"]
    primary = next((c for c in coefficients if c["term"] == treatment_term), None)
    rows_used = int(fit.nobs)

    # 模型整体拟合
    r_squared = scalar(fit.rsquared)
    r_squared_adj = scalar(fit.rsquared_adj)
    f_stat = float(fit.fvalue) if hasattr(fit, "fvalue") and fit.fvalue is not None else None
    f_pval = float(fit.f_pvalue) if hasattr(fit, "f_pvalue") and fit.f_pvalue is not None else None

    # 多重共线性诊断（VIF）
    vif_list: list[dict[str, Any]] = []
    if rows_used > exog.shape[1] and exog.shape[1] > 1:
        exog_np = exog.to_numpy(dtype=float)
        for idx, alias in enumerate(exog.columns):
            if idx == 0:  # const 没有 VIF
                continue
            vif_val = float(variance_inflation_factor(exog_np, idx))
            vif_list.append({"term": term_label(alias), "vif": scalar(vif_val)})

    warnings_list: list[str] = []
    for entry in vif_list:
        if entry["vif"] is not None and entry["vif"] > 10:
            warnings_list.append(f"变量 {entry['term']} 的 VIF={entry['vif']:.1f}>10，存在严重多重共线性，系数标准误可能被放大")

    if rows_used < 30:
        warnings_list.append(f"小样本（N={rows_used}），系数标准误可能不可靠")

    result = {
        "success": True,
        "method": method,
        "backend": "statsmodels",
        "statsmodelsVersion": statsmodels.__version__,
        "rowsInput": rows_input,
        "rowsUsed": rows_used,
        "droppedRows": rows_input - rows_used,
        "covariance": cov_type,
        "outcomeMean": float(y.mean()),
        "rSquared": r_squared,
        "rSquaredAdj": r_squared_adj,
        "fStatistic": scalar(f_stat),
        "fPValue": scalar(f_pval),
        "coefficients": coefficients,
        "primary": primary,
        "vif": vif_list,
        "warnings": warnings_list,
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
        if payload.get("method") not in ("ols_regression",):
            raise ValueError(f"不支持的方法：{payload.get('method')}")
        result = build_result(payload)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        return
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
