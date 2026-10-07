from __future__ import annotations

import csv
import io
import math
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import statsmodels.api as sm
from statsmodels.stats.outliers_influence import variance_inflation_factor

from ..errors import EngineError
from ..io import atomic_json_write, atomic_text_write


def _scalar(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (np.integer, np.floating)):
        value = value.item()
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    return value if isinstance(value, (str, int, float, bool)) else str(value)


def _load_frame(data_path: str) -> pd.DataFrame:
    suffix = Path(data_path).suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(data_path)
    if suffix in {".xlsx", ".xls"}:
        return pd.read_excel(data_path)
    if suffix == ".dta":
        return pd.read_stata(data_path)
    if suffix == ".parquet":
        return pd.read_parquet(data_path)
    raise EngineError("DATA_FORMAT_UNSUPPORTED", f"不支持的数据格式：{suffix or '未知格式'}。", method_id="ols_regression")


def _write_coefficients(path: Path, coefficients: list[dict[str, Any]]) -> None:
    buffer = io.StringIO(newline="")
    writer = csv.DictWriter(buffer, fieldnames=["term", "estimate", "stdError", "statistic", "pValue", "confLow", "confHigh"])
    writer.writeheader()
    writer.writerows(coefficients)
    atomic_text_write(path, "\ufeff" + buffer.getvalue())


def run(payload: dict[str, Any]) -> dict[str, Any]:
    data_path = payload.get("data_path")
    output_dir = payload.get("output_dir")
    arguments = payload.get("arguments")
    if not isinstance(data_path, str) or not data_path:
        raise EngineError("INVALID_ARGUMENT", "execute 缺少 data_path。", method_id="ols_regression", field="data_path")
    if not isinstance(output_dir, str) or not output_dir:
        raise EngineError("INVALID_ARGUMENT", "execute 缺少 output_dir。", method_id="ols_regression", field="output_dir")
    if not isinstance(arguments, dict):
        raise EngineError("INVALID_ARGUMENT", "execute 的 arguments 必须是 JSON 对象。", method_id="ols_regression", field="arguments")

    dependent = arguments.get("dependentVar")
    treatment = arguments.get("treatmentVar")
    covariates = arguments.get("covariates", [])
    if not isinstance(dependent, str) or not dependent.strip():
        raise EngineError("INVALID_ARGUMENT", "dependentVar 必须是非空列名。", method_id="ols_regression", field="dependentVar")
    if not isinstance(treatment, str) or not treatment.strip():
        raise EngineError("INVALID_ARGUMENT", "treatmentVar 必须是非空列名。", method_id="ols_regression", field="treatmentVar")
    if not isinstance(covariates, list) or any(not isinstance(item, str) or not item.strip() for item in covariates):
        raise EngineError("INVALID_ARGUMENT", "covariates 必须是非空字符串列名数组。", method_id="ols_regression", field="covariates")
    names = [dependent, treatment, *covariates]
    if len(set(names)) != len(names):
        raise EngineError("INVALID_ARGUMENT", "因变量、核心解释变量和控制变量不能重复。", method_id="ols_regression", field="covariates")

    frame = _load_frame(data_path)
    missing = [name for name in names if name not in frame.columns]
    if missing:
        raise EngineError("DATA_COLUMN_MISSING", f"数据中找不到变量：{', '.join(missing)}。", method_id="ols_regression", field="arguments")
    selected = frame.loc[:, names].apply(pd.to_numeric, errors="coerce").dropna()
    if selected.empty:
        raise EngineError("DATA_NO_USABLE_ROWS", "所选变量删除缺失值后没有可用样本。", method_id="ols_regression")
    # 规范化 Parquet 阶段可能使用 pandas nullable Float64；statsmodels 会把
    # ExtensionArray 解释成 object。这里把已通过数值转换的列显式落成普通
    # NumPy float64，避免“数据已导入但基准回归无法执行”的跨阶段 dtype 断裂。
    selected = pd.DataFrame(
        selected.to_numpy(dtype=float),
        columns=selected.columns,
        index=selected.index,
    )
    if selected[dependent].nunique() < 2:
        raise EngineError("DATA_NO_VARIATION", "结果变量没有足够变异，无法估计 OLS。", method_id="ols_regression", field="dependentVar")

    exog = sm.add_constant(selected[[treatment, *covariates]], has_constant="add")
    if len(exog) <= exog.shape[1]:
        raise EngineError("DATA_TOO_FEW_ROWS", "样本量相对解释变量个数过少，无法稳定估计。", method_id="ols_regression")
    if int(np.linalg.matrix_rank(exog.to_numpy(dtype=float))) < exog.shape[1]:
        raise EngineError("DESIGN_MATRIX_RANK_DEFICIENT", "设计矩阵秩亏，存在完全共线性，请检查解释变量。", method_id="ols_regression")

    covariance = arguments.get("covariance", "HC1")
    covariance_map = {"robust": "HC1", "HC1": "HC1", "HC2": "HC2", "HC3": "HC3", "nonrobust": "nonrobust"}
    cov_type = covariance_map.get(covariance)
    if cov_type is None:
        raise EngineError("INVALID_ARGUMENT", f"不支持的 covariance：{covariance}。", method_id="ols_regression", field="covariance")
    fit = sm.OLS(selected[dependent], exog).fit(cov_type=cov_type)
    confidence = fit.conf_int()
    coefficients: list[dict[str, Any]] = []
    for term in exog.columns:
        coefficients.append({
            "term": "const" if term == "const" else term,
            "estimate": _scalar(fit.params[term]),
            "stdError": _scalar(fit.bse[term]),
            "statistic": _scalar(fit.tvalues[term]),
            "pValue": _scalar(fit.pvalues[term]),
            "confLow": _scalar(confidence.loc[term, 0]),
            "confHigh": _scalar(confidence.loc[term, 1]),
        })

    regressors = selected[[treatment, *covariates]]
    vif_matrix = exog.to_numpy(dtype=float)
    vif = [
        {"variable": str(column), "vif": _scalar(variance_inflation_factor(vif_matrix, index + 1))}
        for index, column in enumerate(regressors.columns)
    ]
    warnings = [
        f"变量 {item['variable']} 的 VIF={item['vif']:.2f} > 10，存在较强多重共线性迹象；请结合研究设计核查，不自动删除变量。"
        for item in vif
        if isinstance(item["vif"], (int, float)) and item["vif"] > 10
    ]

    result = {
        "success": True,
        "method": "ols_regression",
        "rowsInput": int(len(frame)),
        "rowsUsed": int(len(selected)),
        "droppedRows": int(len(frame) - len(selected)),
        "covariance": cov_type,
        "outcomeMean": _scalar(selected[dependent].mean()),
        "rSquared": _scalar(fit.rsquared),
        "rSquaredAdj": _scalar(fit.rsquared_adj),
        "coefficients": coefficients,
        "primary": next((item for item in coefficients if item["term"] == treatment), None),
        "vif": vif,
        "warnings": warnings,
    }
    result_dir = Path(output_dir)
    result_path = result_dir / "results.json"
    coefficients_path = result_dir / "coefficients.csv"
    result["resultPath"] = str(result_path)
    result["coefficientsPath"] = str(coefficients_path)
    atomic_json_write(result_path, result)
    _write_coefficients(coefficients_path, coefficients)
    return result
