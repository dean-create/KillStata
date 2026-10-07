"""异质性、机制、安慰剂和替代规格的受控计算 handler。

Python 只处理已经由 Harness 校验并传入的规范化数据和参数；基准结果健康性、
用户确认、权限、血缘和最终展示仍由 TypeScript 负责。
"""

from __future__ import annotations

import json
import math
import os
import re
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pandas as pd
import statsmodels.formula.api as smf
from killstata_econometrics_engine.diagnosis import content_fingerprint
from killstata_econometrics_engine.errors import EngineError

_ABSOLUTE_PATH_START_PATTERN = re.compile(r"(?<![\w:/])(?:[A-Za-z]:[\\/]|/(?![\s/]))")
_INTERNAL_ID_PATTERN = re.compile(r"\b(?:dataset|stage|run|session|ses|msg|call|prt)_[A-Za-z0-9][A-Za-z0-9_-]{2,}\b", re.IGNORECASE)


def _public_text(value: Any, limit: int = 240) -> str:
    text = str(value).replace("\r", " ").replace("\n", " ")
    path_start = _ABSOLUTE_PATH_START_PATTERN.search(text)
    if path_start:
        prefix = text[: path_start.start()].rstrip().rstrip("\"'([{")
        text = f"{prefix} [内部路径及后续细节已隐藏]".strip()
    text = _INTERNAL_ID_PATTERN.sub("[内部标识]", text)
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def _json_safe(value: Any) -> Any:
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(item) for item in value]
    if hasattr(value, "item"):
        return _json_safe(value.item())
    return value


def _open_output_file(path: Path, *, binary: bool = False):
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise ValueError("异质性产物路径不能是符号链接。")
    flags = os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags, 0o600)
    except OSError as error:
        if path.is_symlink():
            raise ValueError("异质性产物路径不能是符号链接。") from error
        raise
    return os.fdopen(descriptor, "wb") if binary else os.fdopen(descriptor, "w", encoding="utf-8")


def _write_json(path: Path, value: Any) -> None:
    with _open_output_file(path) as output:
        output.write(json.dumps(_json_safe(value), ensure_ascii=False, indent=2, allow_nan=False) + "\n")


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


def _quote(name: str) -> str:
    escaped = str(name).replace("\\", "\\\\").replace('"', '\\"')
    return f'Q("{escaped}")'


def _significance(value: float | None) -> str:
    if value is None or not math.isfinite(value):
        return "unavailable"
    if value < 0.01:
        return "p<0.01"
    if value < 0.05:
        return "p<0.05"
    if value < 0.1:
        return "p<0.1"
    return "not_significant"


def _direction(value: float | None) -> str | None:
    if value is None or not math.isfinite(value):
        return None
    if abs(value) < 1e-10:
        return "zeroish"
    return "positive" if value > 0 else "negative"


def _fit_formula(
    frame: pd.DataFrame,
    dependent: str,
    treatment: str,
    covariates: list[str],
    *,
    entity: str | None,
    time: str | None,
    cluster: str | None,
    extra_terms: dict[str, pd.Series] | None = None,
    primary_term: str | None = None,
) -> tuple[Any, pd.DataFrame, str, str]:
    needed = [dependent, treatment, *covariates]
    for name in (entity, time, cluster):
        if name:
            needed.append(name)
    missing = sorted({name for name in needed if name not in frame.columns})
    if missing:
        raise ValueError(f"数据中找不到变量：{'、'.join(missing)}。")

    work = frame.loc[:, list(dict.fromkeys(needed))].copy()
    for name in [dependent, treatment, *covariates]:
        work[name] = pd.to_numeric(work[name], errors="coerce")
    for name in (entity, time):
        if name:
            # Canonical Parquet may preserve nullable Int64/String extension dtypes.
            # Patsy C() requires NumPy-compatible categorical values for FE keys.
            work[name] = work[name].astype("object")
    if extra_terms:
        for name, series in extra_terms.items():
            work[name] = pd.to_numeric(series.reindex(work.index), errors="coerce")

    drop_columns = [dependent, treatment, *covariates, *(extra_terms or {}).keys()]
    drop_columns.extend(name for name in (entity, time) if name)
    if cluster:
        drop_columns.append(cluster)
    work = work.dropna(subset=list(dict.fromkeys(drop_columns)))
    if len(work) < 20:
        raise ValueError("当前规格删除缺失值后可用样本少于 20，无法稳定估计。")

    terms = [_quote(treatment), *[_quote(name) for name in covariates]]
    if extra_terms:
        # extra_terms 是本 handler 内生成的安全短名称；保留原名才能与
        # statsmodels 返回的参数索引一致，避免交互项“已估计但找不到核心项”。
        terms.extend(extra_terms)
    rhs = " + ".join(terms) or "1"
    if entity:
        rhs += f" + C({_quote(entity)})"
    if time:
        rhs += f" + C({_quote(time)})"
    formula = f"{_quote(dependent)} ~ {rhs}"
    fit_kwargs: dict[str, Any] = {"cov_type": "HC1"}
    covariance = "HC1"
    if cluster:
        cluster_count = int(work[cluster].nunique(dropna=True))
        if cluster_count < 2:
            raise ValueError(f"聚类变量“{cluster}”在当前子样本中只剩一个聚类，无法执行聚类推断；本工具不会自动改用 HC1。")
        covariance = "cluster"
        fit_kwargs = {"cov_type": "cluster", "cov_kwds": {"groups": work[cluster].to_numpy(dtype=object)}}
    model = smf.ols(formula, data=work).fit(**fit_kwargs)
    selected_primary = primary_term or _quote(treatment)
    if selected_primary not in model.params.index:
        raise ValueError(f"模型结果中找不到核心项：{selected_primary}。")
    return model, work, covariance, selected_primary


def _persist_spec(
    output_dir: Path,
    spec: dict[str, Any],
    model: Any,
    work: pd.DataFrame,
    covariance: str,
    primary_term: str,
    raw_primary_term: str,
) -> dict[str, Any]:
    title = _public_text(spec.get("title", spec["spec_id"]), 160)
    changed_specification = _public_text(spec["changed_specification"])
    public_primary_term = _public_text(raw_primary_term)
    spec_id = spec.get("spec_id")
    if not isinstance(spec_id, str) or re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", spec_id) is None:
        raise ValueError("规格标识必须是安全的文件名片段。")
    output_root = output_dir.resolve()
    specs_dir = output_root / "specs"
    spec_dir = specs_dir / spec_id
    if specs_dir.is_symlink() or spec_dir.is_symlink():
        raise ValueError("规格路径不能包含符号链接。")
    spec_dir.mkdir(parents=True, exist_ok=True)
    resolved_spec_dir = spec_dir.resolve()
    if resolved_spec_dir != spec_dir:
        raise ValueError("规格路径不能包含符号链接。")
    try:
        resolved_spec_dir.relative_to(output_root)
    except ValueError as error:
        raise ValueError("规格目录必须位于 Harness 指定的输出目录内。") from error
    spec_dir = resolved_spec_dir
    confidence = model.conf_int()
    coefficients = []
    for term in model.params.index:
        coefficients.append({
            "term": "primary_term" if term == primary_term else str(term),
            "raw_term": str(term),
            "coefficient": float(model.params[term]),
            "std_error": float(model.bse[term]),
            "p_value": float(model.pvalues[term]),
            "ci_lower": float(confidence.loc[term, 0]),
            "ci_upper": float(confidence.loc[term, 1]),
        })
    coefficient_path = spec_dir / "coefficient_table.csv"
    with _open_output_file(coefficient_path, binary=True) as output:
        pd.DataFrame(coefficients).to_csv(output, index=False, encoding="utf-8-sig")

    coefficient = float(model.params[primary_term])
    p_value = float(model.pvalues[primary_term])
    result = {
        "success": True,
        "method": spec["method_family"],
        "dataset_id": spec.get("dataset_id"),
        "stage_id": spec.get("stage_id"),
        "run_id": spec.get("run_id"),
        "branch": spec.get("branch"),
        "dependent_var": spec["dependent_var"],
        "treatment_var": "primary_term",
        "raw_treatment_var": public_primary_term,
        "coefficient": coefficient,
        "std_error": float(model.bse[primary_term]),
        "p_value": p_value,
        "r_squared": float(model.rsquared),
        "rows_used": int(len(work)),
        "qa_status": "pass",
        "warnings": [],
        "blocking_errors": [],
        "spec_id": spec["spec_id"],
        "spec_type": spec["spec_type"],
        "changed_specification": changed_specification,
        "output_path": str(spec_dir / "results.json"),
        "coefficients_path": str(coefficient_path),
        "diagnostics_path": str(spec_dir / "diagnostics.json"),
        "metadata_path": str(spec_dir / "model_metadata.json"),
        "narrative_path": str(spec_dir / "narrative.md"),
    }
    diagnostics = {
        "core": {"covariance_type": covariance, "rows_used": int(len(work))},
        "validate": {"warnings": [], "blocking_errors": [], "rows_used": int(len(work))},
        "post_estimation_gates": [],
    }
    metadata = {
        "dependent_var": spec["dependent_var"],
        "treatment_var": "primary_term",
        "raw_treatment_var": public_primary_term,
        "covariates": spec.get("covariates", []),
        "entity_var": spec.get("entity_var"),
        "time_var": spec.get("time_var"),
        "cluster_var": spec.get("cluster_var"),
        "rows_used": int(len(work)),
        "spec_id": spec["spec_id"],
        "spec_type": spec["spec_type"],
        "output_kind": "regression",
        "inference_basis": f"LSDV dummy fixed effects + {covariance}",
    }
    _write_json(spec_dir / "diagnostics.json", diagnostics)
    _write_json(spec_dir / "model_metadata.json", metadata)
    _write_json(spec_dir / "results.json", result)
    with _open_output_file(spec_dir / "narrative.md") as output:
        output.write(
            f"# Specification Narrative\n\n- Title: {title}\n- Changed specification: {changed_specification}\n- Grounded result: coefficient={coefficient:.6f}, p-value={p_value:.6f}, rows={len(work)}\n",
        )
    return {
        "spec_id": spec["spec_id"],
        "spec_type": spec["spec_type"],
        "status": "success",
        "result_dir": str(spec_dir),
        "result_path": result["output_path"],
        "diagnostics_path": result["diagnostics_path"],
        "metadata_path": result["metadata_path"],
        "coefficients_path": result["coefficients_path"],
        "narrative_path": result["narrative_path"],
        "changed_specification": changed_specification,
        "key_effect_direction": _direction(coefficient),
        "key_effect_significance": _significance(p_value),
        "grounded_numbers": {
            "coefficient": coefficient,
            "std_error": float(model.bse[primary_term]),
            "p_value": p_value,
            "r_squared": float(model.rsquared),
            "rows_used": int(len(work)),
        },
        "diagnostic_flags": [],
        "primary_term": "primary_term",
        "raw_primary_term": public_primary_term,
        "title": title,
    }


def _failed_spec(spec: dict[str, Any], error: Exception) -> dict[str, Any]:
    return {
        "spec_id": spec["spec_id"],
        "spec_type": spec["spec_type"],
        "status": "failed",
        "changed_specification": _public_text(spec["changed_specification"]),
        "diagnostic_flags": ["execution_failed"],
        "title": _public_text(spec.get("title", spec["spec_id"]), 160),
        "error": _public_text(error),
    }


def _skipped(spec_id: str, spec_type: str, title: str, changed: str, flag: str, warning: str) -> dict[str, Any]:
    return {
        "spec_id": spec_id,
        "spec_type": spec_type,
        "status": "skipped",
        "changed_specification": _public_text(changed),
        "diagnostic_flags": [flag],
        "title": _public_text(title, 160),
        "warning": _public_text(warning),
    }


def _subsample_specs(frame: pd.DataFrame, variable: str, template: dict[str, Any], ordinal: int) -> list[dict[str, Any]]:
    base_spec_id = f"heter_split_{ordinal:03d}"
    if variable not in frame.columns:
        return [_skipped(base_spec_id, "heterogeneity", f"Split: {variable}", f"subsample split on {variable}", "missing_variable", f"Variable not found: {variable}")]
    numeric = pd.to_numeric(frame[variable], errors="coerce")
    specs: list[dict[str, Any]] = []
    if numeric.notna().sum() >= max(10, int(len(frame) * 0.6)):
        threshold = float(numeric.median())
        for side, mask in (("low", numeric <= threshold), ("high", numeric > threshold)):
            specs.append({**template, "spec_id": f"{base_spec_id}_{side}", "spec_type": "heterogeneity", "title": f"Split {variable}: {side}", "changed_specification": f"Estimate on subsample {variable} {'<=' if side == 'low' else '>'} median({threshold:.6f})", "row_filter": mask.fillna(False)})
        return specs
    levels = [str(value) for value in frame[variable].dropna().astype(str).unique().tolist()]
    for level_index, level in enumerate(levels, start=1):
        specs.append({**template, "spec_id": f"{base_spec_id}_group_{level_index:02d}", "spec_type": "heterogeneity", "title": f"Split {variable}: {level}", "changed_specification": f"Estimate on subsample {variable}={level}", "row_filter": frame[variable].astype(str) == level})
    return specs


def _interaction_spec(frame: pd.DataFrame, variable: str, template: dict[str, Any], ordinal: int) -> dict[str, Any]:
    spec_id = f"heter_interaction_{ordinal:03d}"
    if variable not in frame.columns:
        return _skipped(spec_id, "heterogeneity", f"Interaction: {variable}", f"interaction term for {variable}", "missing_variable", f"Variable not found: {variable}")
    numeric = pd.to_numeric(frame[variable], errors="coerce")
    if numeric.notna().sum() >= max(10, int(len(frame) * 0.6)):
        centered = numeric - float(numeric.median())
        interaction_name = f"int_{variable}"
        extra_terms: dict[str, pd.Series] = {}
        if variable not in template.get("covariates", []) and variable not in {template.get("entity_var"), template.get("time_var")}:
            extra_terms[f"mod_{variable}"] = centered
        extra_terms[interaction_name] = pd.to_numeric(frame[template["treatment_var"]], errors="coerce") * centered
        return {**template, "spec_id": spec_id, "spec_type": "heterogeneity", "mode": "interaction", "title": f"Interaction: {variable}", "changed_specification": f"Add centered {variable} main effect and treatment × {variable} interaction", "extra_terms": extra_terms, "primary_term": interaction_name, "raw_primary_term": f"{template['treatment_var']} × centered({variable})"}
    levels = [str(value) for value in frame[variable].dropna().astype(str).unique().tolist()[:6]]
    if len(levels) == 2:
        focal = levels[1]
        interaction_name = f"int_{variable}"
        dummy = pd.Series(np.where(frame[variable].astype(str) == focal, 1.0, 0.0), index=frame.index)
        extra_terms = {}
        if variable not in template.get("covariates", []) and variable not in {template.get("entity_var"), template.get("time_var")}:
            extra_terms[f"mod_{variable}"] = dummy
        extra_terms[interaction_name] = pd.to_numeric(frame[template["treatment_var"]], errors="coerce") * dummy
        return {**template, "spec_id": spec_id, "spec_type": "heterogeneity", "mode": "interaction", "title": f"Interaction: {variable}", "changed_specification": f"Add 1[{variable}={focal}] main effect and treatment × 1[{variable}={focal}] interaction", "extra_terms": extra_terms, "primary_term": interaction_name, "raw_primary_term": f"{template['treatment_var']} × 1[{variable}={focal}]"}
    return _skipped(spec_id, "heterogeneity", f"Interaction: {variable}", f"interaction term for {variable}", "unsupported_interaction_shape", f"Skipped interaction for {variable}: only binary or mostly numeric variables are supported.")


def execute(request: dict[str, Any]) -> dict[str, Any]:
    if request.get("methodFamily") != "fe":
        raise ValueError("当前异质性执行器只支持可映射到线性 FE/LSDV 的基准；DID、DID2S 和事件研究不会被替换为 OLS+固定效应。")
    output_dir = Path(str(request.get("outputDir") or ""))
    data_path = str(request.get("dataPath") or "")
    if not data_path:
        raise ValueError("heterogeneity_runner 缺少 dataPath。")
    frame = _load_frame(data_path)
    expected_fingerprint = request.get("expectedDataFingerprint")
    actual_fingerprint = content_fingerprint(frame)
    if not isinstance(expected_fingerprint, str) or expected_fingerprint != actual_fingerprint:
        raise EngineError(
            "DATA_FINGERPRINT_MISMATCH",
            "异质性执行数据与当前诊断指纹不一致；未运行任何扩展规格。请重新诊断当前数据阶段后再继续。",
            method_id="heterogeneity_runner",
            field="expectedDataFingerprint",
            details={
                "expected_data_fingerprint": expected_fingerprint,
                "actual_data_fingerprint": actual_fingerprint,
            },
        )
    output_dir.mkdir(parents=True, exist_ok=True)
    template = {
        "dataset_id": request.get("datasetId"),
        "stage_id": request.get("stageId"),
        "run_id": request.get("runId"),
        "branch": request.get("branch"),
        "method_family": request["methodFamily"],
        "dependent_var": request["dependentVar"],
        "treatment_var": request["treatmentVar"],
        "covariates": request.get("covariates") or [],
        "entity_var": request.get("entityVar"),
        "time_var": request.get("timeVar"),
        "cluster_var": request.get("clusterVar"),
    }
    specs: list[dict[str, Any]] = []
    warnings: list[str] = []
    for ordinal, variable in enumerate(request.get("heterogeneityVars") or [], start=1):
        for spec in _subsample_specs(frame, variable, template, ordinal):
            if spec.get("status") == "skipped":
                specs.append(spec)
            else:
                subset = frame.loc[spec.pop("row_filter")].copy()
                try:
                    model, work, covariance, primary = _fit_formula(subset, spec["dependent_var"], spec["treatment_var"], spec["covariates"], entity=spec.get("entity_var"), time=spec.get("time_var"), cluster=spec.get("cluster_var"))
                    specs.append(_persist_spec(output_dir, spec, model, work, covariance, primary, spec["treatment_var"]))
                except Exception as error:
                    specs.append(_failed_spec(spec, error))
        spec = _interaction_spec(frame, variable, template, ordinal)
        if spec.get("status") == "skipped":
            specs.append(spec)
        else:
            try:
                model, work, covariance, primary = _fit_formula(frame, spec["dependent_var"], spec["treatment_var"], spec["covariates"], entity=spec.get("entity_var"), time=spec.get("time_var"), cluster=spec.get("cluster_var"), extra_terms=spec.get("extra_terms"), primary_term=spec.get("primary_term"))
                specs.append(_persist_spec(output_dir, spec, model, work, covariance, primary, spec["raw_primary_term"]))
            except Exception as error:
                specs.append(_failed_spec(spec, error))

    for ordinal, variable in enumerate(request.get("mechanismVars") or [], start=1):
        spec = {**template, "spec_id": f"mechanism_{ordinal:03d}", "spec_type": "mechanism", "title": f"Mechanism: {variable}", "dependent_var": variable, "changed_specification": f"Replace dependent variable with mechanism variable {variable}"}
        try:
            model, work, covariance, primary = _fit_formula(frame, spec["dependent_var"], spec["treatment_var"], spec["covariates"], entity=spec.get("entity_var"), time=spec.get("time_var"), cluster=spec.get("cluster_var"))
            specs.append(_persist_spec(output_dir, spec, model, work, covariance, primary, spec["treatment_var"]))
        except Exception as error:
            specs.append(_failed_spec(spec, error))

    placebo = request.get("placebo") or False
    placebo_vars = placebo.get("variables") or [] if isinstance(placebo, dict) else []
    if placebo is True:
        warnings.append("placebo=true received without explicit variables; skipped.")
    for ordinal, variable in enumerate(placebo_vars, start=1):
        spec = {**template, "spec_id": f"placebo_{ordinal:03d}", "spec_type": "placebo", "title": f"Placebo: {variable}", "treatment_var": variable, "changed_specification": f"Use placebo treatment variable {variable}"}
        try:
            model, work, covariance, primary = _fit_formula(frame, spec["dependent_var"], spec["treatment_var"], spec["covariates"], entity=spec.get("entity_var"), time=spec.get("time_var"), cluster=spec.get("cluster_var"))
            specs.append(_persist_spec(output_dir, spec, model, work, covariance, primary, spec["treatment_var"]))
        except Exception as error:
            specs.append(_failed_spec(spec, error))

    for ordinal, alternative in enumerate(request.get("alternativeSpecifications") or [], start=1):
        name = alternative.get("name", "spec")
        spec = {**template, "spec_id": f"alternative_{ordinal:03d}", "spec_type": "alternative_spec", "title": f"Alternative: {name}", "dependent_var": alternative.get("dependentVar") or template["dependent_var"], "treatment_var": alternative.get("treatmentVar") or template["treatment_var"], "covariates": alternative.get("covariates") or template["covariates"], "changed_specification": f"Alternative specification: {name}"}
        try:
            model, work, covariance, primary = _fit_formula(frame, spec["dependent_var"], spec["treatment_var"], spec["covariates"], entity=spec.get("entity_var"), time=spec.get("time_var"), cluster=spec.get("cluster_var"))
            specs.append(_persist_spec(output_dir, spec, model, work, covariance, primary, spec["treatment_var"]))
        except Exception as error:
            specs.append(_failed_spec(spec, error))

    return {"success": True, "output_dir": str(output_dir), "warnings": warnings, "specs": specs}
