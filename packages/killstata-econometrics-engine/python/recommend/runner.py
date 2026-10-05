"""数据结构画像与基础计量方法推荐。

该模块只根据数据事实生成候选，不替用户决定识别策略，也不执行回归。
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd


ENTITY_HINT = re.compile(r"(entity|firm|company|province|city|county|region|district|state|id|地区|省份|省|市|区县|企业|公司|编号|代码)$", re.I)
TIME_HINT = re.compile(r"(^t$|time|year|date|month|quarter|period|week|day|年份|年|季度|月|日期|时期)", re.I)
TREATMENT_HINT = re.compile(r"(did|treat|treated|policy|post|shock|intervention|试点|政策|处理|冲击)", re.I)
INSTRUMENT_HINT = re.compile(r"(^(iv|z)$|instrument|工具变量)", re.I)


def _load_frame(data_path: str) -> pd.DataFrame:
    path = Path(data_path)
    suffix = path.suffix.lower()
    if suffix in {".xlsx", ".xls"}:
        return pd.read_excel(path)
    if suffix == ".csv":
        return pd.read_csv(path)
    if suffix == ".dta":
        return pd.read_stata(path)
    if suffix in {".parquet", ".pq"}:
        return pd.read_parquet(path)
    raise ValueError(f"不支持的数据格式：{suffix or '未知格式'}。")


def _profile_column(name: str, series: pd.Series) -> dict[str, Any]:
    values = series.dropna()
    numeric = bool(pd.api.types.is_numeric_dtype(series))
    datetime = bool(pd.api.types.is_datetime64_any_dtype(series))
    integer = bool(pd.api.types.is_integer_dtype(series))
    floating = bool(pd.api.types.is_float_dtype(series))
    integer_like = bool(integer)
    if floating and len(values):
        numeric_values = pd.to_numeric(values, errors="coerce")
        integer_like = bool(numeric_values.notna().all() and np.isfinite(numeric_values).all() and (numeric_values == numeric_values.astype(int)).all())
    binary = bool(len(values) > 0 and set(values.unique().tolist()) <= {0, 1, 0.0, 1.0})
    return {
        "name": str(name),
        "dtype_family": "numeric" if numeric else "datetime" if datetime else "categorical",
        "non_null_count": int(values.size),
        "unique_count": int(series.nunique(dropna=True)),
        "binary": binary,
        "numeric": numeric,
        "datetime": datetime,
        "integer_like": integer_like,
        "nonnegative": bool(pd.to_numeric(values, errors="coerce").min() >= 0) if numeric and len(values) else True,
    }


def _uniq(values: list[str]) -> list[str]:
    return list(dict.fromkeys(value for value in values if value))


def _value_type(column: dict[str, Any] | None) -> str:
    if not column:
        return "unknown"
    if column["binary"]:
        return "binary"
    if column["numeric"] and column["integer_like"] and column["nonnegative"]:
        return "count"
    if column["numeric"]:
        return "continuous"
    return "unknown"


def _build_profile(frame: pd.DataFrame, request: dict[str, Any]) -> dict[str, Any]:
    columns = [_profile_column(str(name), frame[name]) for name in frame.columns]
    by_name = {item["name"].strip().lower(): item for item in columns}
    explicit_entity = request.get("entityVar")
    explicit_time = request.get("timeVar")
    explicit_treatment = request.get("treatmentVar")
    explicit_dependent = request.get("dependentVar")
    candidate_entities = _uniq([item["name"] for item in columns if ENTITY_HINT.search(item["name"]) and item["unique_count"] > 1])
    candidate_times = _uniq([item["name"] for item in columns if (item["datetime"] or TIME_HINT.search(item["name"])) and item["unique_count"] > 1])
    candidate_treatments = _uniq([item["name"] for item in columns if TREATMENT_HINT.search(item["name"]) or item["name"] == explicit_treatment])
    candidate_instruments = _uniq([item["name"] for item in columns if INSTRUMENT_HINT.search(item["name"])])
    entity_var = explicit_entity or (candidate_entities[0] if candidate_entities else None)
    time_var = explicit_time or (candidate_times[0] if candidate_times else None)

    entity_count = int(frame[entity_var].nunique(dropna=True)) if entity_var in frame.columns else None
    time_count = int(frame[time_var].nunique(dropna=True)) if time_var in frame.columns else None
    duplicate_keys = int(frame.duplicated(subset=[entity_var, time_var]).sum()) if entity_var in frame.columns and time_var in frame.columns else None
    counts = frame.groupby(entity_var, dropna=False).size() if entity_var in frame.columns else None
    avg_periods = round(float(counts.mean()), 2) if counts is not None and len(counts) else None
    balanced_ratio = round(float((counts == time_count).mean()), 4) if counts is not None and time_count else None

    data_structure = "unknown"
    if entity_var and time_var and (avg_periods or 0) > 1.1 and (entity_count or 0) > 1 and (time_count or 0) > 1:
        data_structure = "panel"
    elif time_var:
        unique_time = by_name.get(str(time_var).strip().lower(), {}).get("unique_count", time_count or 0)
        if unique_time > 1 and len(frame) <= unique_time * 1.2:
            data_structure = "time_series"
        elif unique_time > 1:
            data_structure = "repeated_cross_section"
    elif len(frame) > 0:
        data_structure = "cross_section"

    dependent_column = by_name.get(str(explicit_dependent).strip().lower()) if explicit_dependent else None
    treatment_name = explicit_treatment or (candidate_treatments[0] if candidate_treatments else None)
    treatment_column = by_name.get(str(treatment_name).strip().lower()) if treatment_name else None
    return {
        "row_count": int(len(frame)),
        "column_count": int(len(columns)),
        "columns": columns,
        "explicit_entity_var": explicit_entity,
        "explicit_time_var": explicit_time,
        "explicit_treatment_var": explicit_treatment,
        "explicit_dependent_var": explicit_dependent,
        "candidate_entity_vars": candidate_entities,
        "candidate_time_vars": candidate_times,
        "candidate_treatment_vars": candidate_treatments,
        "candidate_instrument_vars": candidate_instruments,
        "entity_count": entity_count,
        "time_count": time_count,
        "duplicate_panel_keys": duplicate_keys,
        "avg_periods_per_entity": avg_periods,
        "balanced_ratio": balanced_ratio,
        "data_structure": data_structure,
        "dependent_var_type": _value_type(dependent_column),
        "treatment_var_type": _value_type(treatment_column),
    }


def _recommend(profile: dict[str, Any]) -> dict[str, Any]:
    reasons: list[str] = []
    warnings: list[str] = []
    next_methods: list[str] = []
    structure = profile["data_structure"]
    entity = profile.get("explicit_entity_var") or (profile["candidate_entity_vars"] or [None])[0]
    time = profile.get("explicit_time_var") or (profile["candidate_time_vars"] or [None])[0]
    treatment = profile.get("explicit_treatment_var") or (profile["candidate_treatment_vars"] or [None])[0]
    method = "ols_regression"
    covariance = "robust"
    confidence = "medium"
    cluster = None

    if structure == "panel":
        method, covariance, cluster = "panel_fe_regression", "cluster", entity
        confidence = "high" if entity and time else "medium"
        reasons.append("Detected repeated observations across entity and time dimensions, so a panel baseline is appropriate.")
        next_methods.append("ols_regression")
        if treatment and re.search(r"did", treatment, re.I):
            warnings.append("A DID-like treatment name was detected, but a column name is not an identification strategy; confirm timing and treatment design before choosing DID.")
        if (profile.get("entity_count") or 0) < 10:
            warnings.append(f"Only {profile.get('entity_count') or 0} clusters were detected; clustered standard errors may be unstable.")
            reasons.append("The panel baseline keeps entity-clustered inference, while the low cluster count is reported as a limitation.")
        elif (profile.get("entity_count") or 0) < 30:
            warnings.append(f"Cluster count is modest ({profile.get('entity_count')}); report clustered SE with caution and compare against robust SE.")
        if (profile.get("duplicate_panel_keys") or 0) > 0:
            warnings.append(f"Detected {profile['duplicate_panel_keys']} duplicate entity-time keys; aggregate or repair them before trusting FE estimates.")
            confidence = "low"
    elif structure == "time_series":
        covariance, confidence = "hac", "medium"
        reasons.append("Detected a single time dimension without a stable panel entity, so a time-series baseline is more appropriate than panel FE.")
        next_methods.append("ols_regression")
        warnings.append("The current built-in baseline tool is OLS-oriented; for time series you should consider trend terms, lags, and HAC inference.")
    else:
        reasons.append("No reliable panel structure was detected, so cross-sectional OLS is the safest baseline family.")
        next_methods.append("ols_regression")
        if structure == "repeated_cross_section":
            reasons[-1] = "Detected repeated observations over time without a stable entity identifier, which fits repeated cross-section OLS as a baseline."

    if profile["candidate_instrument_vars"]:
        warnings.append(f"Instrument-like variables detected: {', '.join(profile['candidate_instrument_vars'])}; instrument validity must be confirmed by the user or research design.")
    if profile["row_count"] < 100:
        warnings.append(f"Sample size is small ({profile['row_count']}); inference may be unstable.")
        confidence = "low"
    if profile["row_count"] < 250 and profile["column_count"] > 25:
        warnings.append("The sample is not large relative to the number of variables; keep the baseline specification parsimonious.")
    if profile["dependent_var_type"] == "binary":
        warnings.append("The dependent variable looks binary. OLS can still be used as a linear probability baseline, but interpretation should be explicit.")

    return {
        "data_structure": structure,
        "recommended_method": method,
        "covariance": covariance,
        "preferred_entity_var": entity,
        "preferred_time_var": time,
        "preferred_treatment_var": treatment,
        "preferred_cluster_var": cluster,
        "confidence": confidence,
        "reasons": reasons,
        "warnings": warnings,
        "next_best_methods": _uniq(next_methods),
        "post_estimation_rules": [
            "If heteroskedasticity tests fail, switch nonrobust inference to robust standard errors.",
            "If clustered SE are requested but the cluster count is too low, keep the warning and add a robust-SE comparison.",
            "If panel keys are incomplete or duplicate entity-time rows remain unresolved, block FE until the keys are repaired; do not change estimators automatically.",
            "If multicollinearity is severe, reduce overlapping controls before adding more robustness layers.",
        ],
    }


def execute(request: dict[str, Any]) -> dict[str, Any]:
    data_path = str(request.get("dataPath") or "")
    output_dir = Path(str(request.get("outputDir") or ""))
    if not data_path:
        raise ValueError("econometrics_recommend 缺少 dataPath。")
    frame = _load_frame(data_path)
    profile = _build_profile(frame, request)
    recommendation = _recommend(profile)
    output_dir.mkdir(parents=True, exist_ok=True)
    profile_path = output_dir / "profile.json"
    recommendation_path = output_dir / "recommendation.json"
    profile_path.write_text(json.dumps(profile, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    recommendation_path.write_text(json.dumps(recommendation, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    return {
        "success": True,
        "profile": profile,
        "recommendation": recommendation,
        "profilePath": str(profile_path),
        "recommendationPath": str(recommendation_path),
        "warnings": recommendation["warnings"],
    }
