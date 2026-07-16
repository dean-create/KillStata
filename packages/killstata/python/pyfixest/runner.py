"""Deterministic PyFixest adapter for KillStata model-facing tools.

The model never sends formulas. It sends named variables and design choices;
this adapter validates them, aliases columns, constructs formulas, runs
PyFixest, and emits one JSON result on stdout.
"""

from __future__ import annotations

import json
import math
import re
import sys
import traceback
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import pyfixest as pf


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


def selected_columns(payload: dict[str, Any]) -> list[str]:
    scalar_keys = (
        "dependentVar",
        "treatmentVar",
        "groupVar",
        "postVar",
        "relativeTimeVar",
        "entityVar",
        "timeVar",
        "cohortVar",
        "clusterVar",
    )
    list_keys = ("covariates", "fixedEffects", "clusterVars")
    columns: list[str] = []
    for key in scalar_keys:
        value = payload.get(key)
        if isinstance(value, str) and value not in columns:
            columns.append(value)
    for key in list_keys:
        for value in payload.get(key, []):
            if value not in columns:
                columns.append(value)
    return columns


def prepare_frame(payload: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, str], int]:
    frame = load_frame(payload["dataPath"])
    if frame.columns.duplicated().any():
        duplicated = frame.columns[frame.columns.duplicated()].tolist()
        raise ValueError(f"数据中存在重复列名：{', '.join(map(str, duplicated))}")

    columns = selected_columns(payload)
    missing = [name for name in columns if name not in frame.columns]
    if missing:
        raise ValueError(f"数据中找不到变量：{', '.join(missing)}")

    rows_input = int(len(frame))
    frame = frame.loc[:, columns].dropna().copy()
    if frame.empty:
        raise ValueError("所选变量删除缺失值后没有可用样本")

    aliases = {name: f"v_{index}" for index, name in enumerate(columns)}
    frame = frame.rename(columns=aliases)
    return frame, aliases, rows_input


def require_numeric(frame: pd.DataFrame, aliases: dict[str, str], names: list[str]) -> None:
    invalid = [name for name in names if not pd.api.types.is_numeric_dtype(frame[aliases[name]])]
    if invalid:
        raise ValueError(f"以下变量必须是数值型：{', '.join(invalid)}")


def require_unique_panel(frame: pd.DataFrame, entity: str, time: str) -> None:
    if frame.duplicated([entity, time]).any():
        raise ValueError("个体变量与时间变量不能存在重复组合")


def restore_term(term: str, aliases: dict[str, str]) -> str:
    alias_to_original = {alias: original for original, alias in aliases.items()}
    alternatives = "|".join(re.escape(alias) for alias in sorted(alias_to_original, key=len, reverse=True))
    pattern = re.compile(rf"(?<![A-Za-z0-9_])(?:{alternatives})(?![A-Za-z0-9_])")
    return pattern.sub(lambda match: alias_to_original[match.group(0)], str(term))


def tidy_records(fit: Any, aliases: dict[str, str]) -> list[dict[str, Any]]:
    return tidy_frame_records(fit.tidy(), lambda term: restore_term(str(term), aliases))


def tidy_frame_records(tidy: pd.DataFrame, term_name: Any = str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for term, row in tidy.iterrows():
        records.append(
            {
                "term": term_name(term),
                "estimate": scalar(row.get("Estimate")),
                "stdError": scalar(row.get("Std. Error")),
                "statistic": scalar(row.get("t value")),
                "pValue": scalar(row.get("Pr(>|t|)")),
                "confLow": scalar(row.get("2.5%")),
                "confHigh": scalar(row.get("97.5%")),
            }
        )
    return records


def common_result(
    payload: dict[str, Any],
    fit: Any,
    frame: pd.DataFrame,
    aliases: dict[str, str],
    rows_input: int,
) -> dict[str, Any]:
    coefficients = tidy_records(fit, aliases)
    rows_used = int(getattr(fit, "_N", len(getattr(fit, "_data", []))))
    cluster_vars = payload.get("clusterVars") or ([payload["clusterVar"]] if payload.get("clusterVar") else [])
    cluster_counts = {
        name: int(frame[aliases[name]].nunique())
        for name in cluster_vars
    }
    warnings: list[str] = []
    for name, count in cluster_counts.items():
        if count < 30:
            warnings.append(f"聚类数量较少（{name}：{count}），聚类推断可能不稳定。")
    return {
        "success": True,
        "method": payload["method"],
        "backend": "pyfixest",
        "pyfixestVersion": pf.__version__,
        "rowsInput": rows_input,
        "rowsUsed": rows_used,
        "droppedRows": rows_input - rows_used,
        "coefficients": coefficients,
        "rSquared": scalar(getattr(fit, "_r2", None)),
        "rSquaredWithin": scalar(getattr(fit, "_r2_within", None)),
        "covariance": payload.get("covariance"),
        "clusterVars": cluster_vars,
        "clusterCounts": cluster_counts,
        "fixedEffects": payload.get("fixedEffects", []),
        "warnings": warnings,
    }


def run_hdfe(payload: dict[str, Any]) -> dict[str, Any]:
    frame, aliases, rows_input = prepare_frame(payload)
    numeric = [payload["dependentVar"], payload["treatmentVar"], *payload.get("covariates", [])]
    require_numeric(frame, aliases, numeric)

    for fixed_effect in payload["fixedEffects"]:
        if frame[aliases[fixed_effect]].nunique() < 2:
            raise ValueError(f"固定效应变量至少需要两个取值：{fixed_effect}")
    for cluster in payload.get("clusterVars", []):
        if frame[aliases[cluster]].nunique() < 2:
            raise ValueError(f"聚类变量至少需要两个簇：{cluster}")

    rhs = " + ".join(aliases[name] for name in [payload["treatmentVar"], *payload.get("covariates", [])])
    fixed_effects = " + ".join(aliases[name] for name in payload["fixedEffects"])
    formula = f"{aliases[payload['dependentVar']]} ~ {rhs} | {fixed_effects}"
    covariance = payload["covariance"]
    if payload.get("clusterVars"):
        vcov: str | dict[str, str] = {
            covariance: " + ".join(aliases[name] for name in payload["clusterVars"])
        }
    else:
        vcov = covariance

    fit = pf.feols(formula, data=frame, vcov=vcov)
    result = common_result(payload, fit, frame, aliases, rows_input)
    primary_term = payload["treatmentVar"]
    result["primary"] = next(
        (record for record in result["coefficients"] if record["term"] == primary_term),
        None,
    )
    if result["primary"] is None:
        raise ValueError(f"核心解释变量被共线性检查删除：{primary_term}")
    return result


def run_static_did(payload: dict[str, Any]) -> dict[str, Any]:
    frame, aliases, rows_input = prepare_frame(payload)
    numeric = [
        payload["dependentVar"],
        payload["groupVar"],
        payload["postVar"],
        *payload.get("covariates", []),
    ]
    require_numeric(frame, aliases, numeric)

    for key, label in (("groupVar", "处理组变量"), ("postVar", "政策后变量")):
        values = set(frame[aliases[payload[key]]].unique())
        if not values.issubset({0, 1, False, True}) or len(values) != 2:
            raise ValueError(f"传统 DID 的{label}必须同时包含 0 和 1")

    group = aliases[payload["groupVar"]]
    post = aliases[payload["postVar"]]
    if len(frame.groupby([group, post], observed=True)) != 4:
        raise ValueError("传统 DID 必须同时包含处理组/对照组与政策前/政策后四个样本单元")

    controls = [aliases[name] for name in payload.get("covariates", [])]
    rhs = f"{group} * {post}"
    if controls:
        rhs += " + " + " + ".join(controls)
    formula = f"{aliases[payload['dependentVar']]} ~ {rhs}"
    fit = pf.feols(formula, data=frame, vcov=payload["covariance"])
    result = common_result(payload, fit, frame, aliases, rows_input)
    interaction_term = f"{payload['groupVar']}:{payload['postVar']}"
    result["primary"] = next(
        (record for record in result["coefficients"] if record["term"] == interaction_term),
        None,
    )
    if result["primary"] is None:
        raise ValueError("传统 DID 的处理组与政策后交互项无法估计")
    result["warnings"].append("数据只有两个时期，无法仅凭本样本检验政策前平行趋势。")
    return result


def run_did2s(payload: dict[str, Any]) -> dict[str, Any]:
    frame, aliases, rows_input = prepare_frame(payload)
    numeric = [
        payload["dependentVar"],
        payload["relativeTimeVar"],
        payload["timeVar"],
        *payload.get("covariates", []),
    ]
    require_numeric(frame, aliases, numeric)
    treatment = frame[aliases[payload["treatmentVar"]]]
    if not set(treatment.unique()).issubset({0, 1, False, True}) or treatment.nunique() != 2:
        raise ValueError("DID2S 的处理变量必须同时包含 0 和 1")
    ordered = frame.sort_values([aliases[payload["entityVar"]], aliases[payload["timeVar"]]])
    treatment_changes = ordered.groupby(aliases[payload["entityVar"]], sort=False)[
        aliases[payload["treatmentVar"]]
    ].diff()
    if (treatment_changes < 0).any():
        raise ValueError("DID2S 的处理状态一旦变为 1，就不能再回到 0")
    entity = aliases[payload["entityVar"]]
    time = aliases[payload["timeVar"]]
    relative_time = aliases[payload["relativeTimeVar"]]
    first_treatment = (
        frame.loc[treatment.astype(bool)]
        .groupby(entity, sort=False)[time]
        .min()
    )
    observed_first_treatment = frame[entity].map(first_treatment)
    treated_entity = observed_first_treatment.notna()
    expected_relative_time = frame[time] - observed_first_treatment
    actual_relative_time = frame[relative_time]
    aligned_treated = np.isclose(
        actual_relative_time[treated_entity].astype(float),
        expected_relative_time[treated_entity].astype(float),
        rtol=0,
        atol=1e-9,
    )
    aligned_never_treated = np.isneginf(actual_relative_time[~treated_entity].astype(float))
    if not aligned_treated.all() or not aligned_never_treated.all():
        raise ValueError("DID2S 的相对时期与实际首次处理时点不一致；从未处理组请使用 -inf")
    if payload["referencePeriod"] not in set(frame[aliases[payload["relativeTimeVar"]]].unique()):
        raise ValueError("相对时期变量中不存在指定的参考期")
    require_unique_panel(frame, aliases[payload["entityVar"]], aliases[payload["timeVar"]])
    if frame[aliases[payload["clusterVar"]]].nunique() < 2:
        raise ValueError("聚类变量至少需要两个簇")

    controls = payload.get("covariates", [])
    first_stage_rhs = " + ".join(aliases[name] for name in controls) if controls else "0"
    first_stage = (
        f"~ {first_stage_rhs} | {aliases[payload['entityVar']]} + {aliases[payload['timeVar']]}"
    )
    second_stage = (
        f"~ i({aliases[payload['relativeTimeVar']]}, ref={payload['referencePeriod']})"
    )
    fit = pf.did2s(
        frame,
        yname=aliases[payload["dependentVar"]],
        first_stage=first_stage,
        second_stage=second_stage,
        treatment=aliases[payload["treatmentVar"]],
        cluster=aliases[payload["clusterVar"]],
    )
    result = common_result(payload, fit, frame, aliases, rows_input)
    result["referencePeriod"] = payload["referencePeriod"]
    result["primary"] = next(
        (
            record
            for record in result["coefficients"]
            if re.search(r"::0(?:\.0)?$", record["term"])
        ),
        None,
    )
    if result["primary"] is None:
        raise ValueError("DID2S 没有生成事件期 0 的处理效应")
    return result


def run_saturated_event_study(payload: dict[str, Any]) -> dict[str, Any]:
    frame, aliases, rows_input = prepare_frame(payload)
    numeric = [payload["dependentVar"], payload["cohortVar"], payload["timeVar"], *payload.get("covariates", [])]
    require_numeric(frame, aliases, numeric)
    require_unique_panel(frame, aliases[payload["entityVar"]], aliases[payload["timeVar"]])
    if frame[aliases[payload["clusterVar"]]].nunique() < 2:
        raise ValueError("聚类变量至少需要两个簇")
    cohort_count = frame.groupby(aliases[payload["entityVar"]], sort=False)[
        aliases[payload["cohortVar"]]
    ].nunique()
    if (cohort_count != 1).any():
        raise ValueError("同一个体的首次处理时期必须保持不变")

    cohorts = frame[aliases[payload["cohortVar"]]]
    if (cohorts < 0).any():
        raise ValueError("首次处理时期不能为负数")
    if 0 not in set(cohorts.unique()):
        raise ValueError("首次处理时期变量必须用 0 表示从未处理组")
    treated_cohorts = sorted(value for value in cohorts.unique() if value > 0)
    if len(treated_cohorts) < 2:
        raise ValueError("现代交错处理事件研究至少需要两个不同的处理批次")
    observed_periods = set(frame[aliases[payload["timeVar"]]].unique())
    invalid_cohorts = [value for value in treated_cohorts if value not in observed_periods]
    if invalid_cohorts:
        raise ValueError("首次处理时期必须对应数据中实际存在的时间取值")

    fit = pf.event_study(
        frame,
        yname=aliases[payload["dependentVar"]],
        idname=aliases[payload["entityVar"]],
        tname=aliases[payload["timeVar"]],
        gname=aliases[payload["cohortVar"]],
        xfml=None,
        cluster=aliases[payload["clusterVar"]],
        estimator="saturated",
        att=False,
    )
    result = common_result(payload, fit, frame, aliases, rows_input)
    result["coefficients"] = tidy_frame_records(fit.aggregate(), lambda period: str(period))
    result["primary"] = next(
        (record for record in result["coefficients"] if float(record["term"]) == 0),
        None,
    )
    if result["primary"] is None:
        raise ValueError("现代交错处理事件研究没有生成事件期 0 的处理效应")
    result["warnings"].append(
        "PyFixest 0.60.0 将 saturated 事件研究标记为 beta，结果需做独立稳健性核验。"
    )
    return result


def persist(result: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    coefficients_path = output_dir / "coefficients.csv"
    result_path = output_dir / "results.json"
    pd.DataFrame(result.get("coefficients", [])).to_csv(coefficients_path, index=False)
    result["coefficientsPath"] = str(coefficients_path)
    result["resultPath"] = str(result_path)
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    return result


def main() -> None:
    payload = json.load(sys.stdin)
    method = payload.get("method")
    runners = {
        "hdfe_regression": run_hdfe,
        "did_static": run_static_did,
        "did2s": run_did2s,
        "did_event_study_saturated": run_saturated_event_study,
    }
    if method not in runners:
        raise ValueError(f"不支持的 PyFixest 方法：{method}")
    result = persist(runners[method](payload), payload)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        traceback.print_exc(file=sys.stderr)
        print(
            json.dumps(
                {
                    "success": False,
                    "errorCode": type(error).__name__,
                    "message": str(error) or "PyFixest 计量分析失败",
                },
                ensure_ascii=False,
            )
        )
