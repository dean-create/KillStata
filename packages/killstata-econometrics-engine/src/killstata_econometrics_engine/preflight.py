from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .readiness_models import DataIssue, MethodPreflightResult, RepairOption
from .diagnosis import content_fingerprint


def _load_frame(data_path: str) -> pd.DataFrame:
    suffix = Path(data_path).suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(data_path)
    if suffix in {".xlsx", ".xls"}:
        return pd.read_excel(data_path)
    if suffix in {".dta"}:
        return pd.read_stata(data_path)
    if suffix in {".parquet", ".pq"}:
        return pd.read_parquet(data_path)
    raise ValueError(f"不支持的数据格式：{suffix or '未知格式'}。")


def _repair(method_id: str, repair_id: str, label: str, description: str, impact: str) -> RepairOption:
    return RepairOption(
        repair_id=repair_id,
        label_zh=label,
        description_zh=description,
        semantic_impact=impact,  # type: ignore[arg-type]
        requires_confirmation=True,
        resulting_method_ids=[method_id],
    )


def preflight_method(method_id: str, data_path: str, arguments: dict[str, Any]) -> MethodPreflightResult:
    frame = _load_frame(data_path)
    data_fingerprint = content_fingerprint(frame)
    issues: list[DataIssue] = []
    repairs: list[RepairOption] = []

    names: list[str] = []
    numeric_names: list[str] = []
    for key in ("dependentVar", "treatmentVar", "entityVar", "timeVar", "groupVar", "postVar", "analysisUnitVar", "runningVar", "fuzzyVar", "weightsVar", "cohortVar", "relativeTimeVar", "clusterVar"):
        value = arguments.get(key)
        if isinstance(value, str) and value.strip():
            names.append(value)
            if key not in {"entityVar", "timeVar", "groupVar", "postVar", "analysisUnitVar", "clusterVar"}:
                numeric_names.append(value)
    for key in ("covariates", "fixedEffects", "clusterVars", "instrumentVars"):
        values = arguments.get(key)
        if isinstance(values, list):
            names.extend(value for value in values if isinstance(value, str) and value.strip())
            if key not in {"fixedEffects", "clusterVars"}:
                numeric_names.extend(value for value in values if isinstance(value, str) and value.strip())

    missing = sorted(set(name for name in names if name not in frame.columns))
    if missing:
        issues.append(DataIssue(
            code="DATA_COLUMN_MISSING",
            severity="blocking",
            summary_zh=f"当前数据中找不到变量：{'、'.join(missing)}。",
            evidence={"columns": missing},
        ))
        repairs.append(_repair(method_id, "confirm_real_columns", "确认真实列名", "先读取当前阶段字段并确认变量角色，不自动替换研究变量。", "identification"))

    if len(frame.dropna(how="all")) == 0:
        issues.append(DataIssue(code="DATA_NO_USABLE_ROWS", severity="blocking", summary_zh="当前数据没有可用观测。"))
        repairs.append(_repair(
            method_id,
            "confirm_nonempty_estimation_data",
            "确认当前数据阶段包含有效观测",
            "请核对工作表、导入结果和缺失值处理；系统不会伪造观测或自动切换数据阶段。",
            "identification",
        ))

    invalid_numeric = [
        name for name in sorted(set(numeric_names))
        if name in frame.columns and not pd.api.types.is_numeric_dtype(frame[name])
    ]
    if invalid_numeric:
        issues.append(DataIssue(
            code="DATA_NUMERIC_REQUIRED",
            severity="blocking",
            summary_zh=f"当前方法要求数值变量，但以下列不是数值型：{'、'.join(invalid_numeric)}。",
            evidence={"columns": invalid_numeric},
        ))
        repairs.append(_repair(method_id, "confirm_numeric_encoding", "确认数值编码", "先确认类别编码或可审计的类型转换规则，不静默改变量含义。", "measurement"))

    model_variable_methods = {
        "ols_regression", "wls_regression", "robust_regression", "quantile_regression", "hdfe_regression",
    }
    if method_id in model_variable_methods:
        model_names = list(dict.fromkeys(
            name for name in [arguments.get("dependentVar"), arguments.get("treatmentVar"), *(arguments.get("covariates") or [])]
            if isinstance(name, str) and name in frame.columns and name not in invalid_numeric
        ))
        if model_names:
            complete_cases = frame[model_names].dropna()
            if complete_cases.empty:
                issues.append(DataIssue(
                    code="DATA_NO_USABLE_CASES",
                    severity="blocking",
                    summary_zh="当前模型变量没有共同的完整观测，不能在不确定样本处理规则的情况下估计。",
                    evidence={"columns": model_names},
                ))
                repairs.append(_repair(
                    method_id,
                    "confirm_complete_case_sample",
                    "确认模型变量缺失后的有效样本",
                    "请检查所选变量的缺失情况，并决定是否补充数据或采用明确的样本处理规则；系统不会静默删行或填补。",
                    "sample",
                ))
            else:
                constant_model_columns = [name for name in model_names if complete_cases[name].nunique(dropna=True) < 2]
                if constant_model_columns:
                    issues.append(DataIssue(
                        code="DATA_MODEL_VARIABLE_CONSTANT",
                        severity="blocking",
                        summary_zh=f"当前模型变量没有有效变异：{'、'.join(constant_model_columns)}。",
                        evidence={"columns": constant_model_columns},
                    ))
                    repairs.append(_repair(
                        method_id,
                        "confirm_constant_model_variables",
                        "确认无变异的模型变量",
                        "请核对变量定义及样本范围；移除或重定义变量会改变模型规格，系统不会静默处理。",
                        "identification",
                    ))

    if method_id == "hdfe_regression":
        fixed_effects = arguments.get("fixedEffects")
        constant_effects = [
            name for name in fixed_effects or []
            if isinstance(name, str) and name in frame.columns and frame[name].nunique(dropna=True) < 2
        ]
        if constant_effects:
            issues.append(DataIssue(
                code="DATA_FIXED_EFFECT_NO_VARIATION",
                severity="blocking",
                summary_zh=f"固定效应维度没有有效变化：{'、'.join(constant_effects)}。",
                evidence={"columns": constant_effects},
            ))
            repairs.append(_repair(
                method_id,
                "confirm_constant_fixed_effects",
                "确认无变化的固定效应维度",
                "请重新核对研究单位及固定效应维度；移除该维度会改变模型规格，系统不会静默处理。",
                "identification",
            ))

    weights_var = arguments.get("weightsVar")
    if method_id == "wls_regression" and isinstance(weights_var, str) and weights_var in frame.columns and weights_var not in invalid_numeric:
        weights = pd.to_numeric(frame[weights_var], errors="coerce").to_numpy(dtype=float, na_value=np.nan)
        finite = np.isfinite(weights)
        missing_weight_rows = int(np.isnan(weights).sum())
        nonfinite_weight_rows = int((~finite & ~np.isnan(weights)).sum())
        nonpositive_weight_rows = int((finite & (weights <= 0)).sum())
        invalid_weight_rows = missing_weight_rows + nonfinite_weight_rows + nonpositive_weight_rows
        if invalid_weight_rows:
            issues.append(DataIssue(
                code="WLS_WEIGHT_NOT_POSITIVE",
                severity="blocking",
                summary_zh=(
                    f"WLS 权重列 {weights_var} 有 {invalid_weight_rows} 行不是严格为正的有限数值"
                    f"（缺失 {missing_weight_rows} 行、非有限 {nonfinite_weight_rows} 行、非正 {nonpositive_weight_rows} 行）。"
                    "零权重会改变有效样本，系统不会静默将其当作排除授权。"
                ),
                evidence={
                    "weightsVar": weights_var,
                    "missingRows": missing_weight_rows,
                    "nonfiniteRows": nonfinite_weight_rows,
                    "nonpositiveRows": nonpositive_weight_rows,
                },
            ))
            repairs.append(_repair(
                method_id,
                "confirm_positive_wls_weights",
                "确认 WLS 权重与样本处理",
                "核对权重是否确为有来源依据的逆误差方差；请更正权重或明确选择其他方法。系统不会自动删除零权观测、补权重或切换估计量。",
                "measurement",
            ))

    cluster_var = arguments.get("clusterVar")
    if method_id in {"rdd_sharp", "rdd_fuzzy"} and isinstance(cluster_var, str) and cluster_var in frame.columns:
        cluster_ids = frame[cluster_var]
        missing_cluster_ids = int(cluster_ids.isna().sum())
        if missing_cluster_ids:
            issues.append(DataIssue(
                code="RDD_CLUSTER_ID_MISSING",
                severity="blocking",
                summary_zh=f"聚类标识列 {cluster_var} 有 {missing_cluster_ids} 行缺失；无法在不改变样本的情况下计算聚类稳健推断。",
                evidence={"clusterVar": cluster_var, "missingRows": missing_cluster_ids},
            ))
            repairs.append(_repair(
                method_id,
                "confirm_rdd_cluster_ids",
                "确认缺失聚类标识的处理",
                "请核对聚类标识来源，或明确如何处理缺失标识；系统不会静默删除观测或改用其他聚类层级。",
                "identification",
            ))
        elif int(cluster_ids.nunique()) < 2:
            issues.append(DataIssue(
                code="RDD_CLUSTER_COUNT_INSUFFICIENT",
                severity="blocking",
                summary_zh=f"聚类标识列 {cluster_var} 少于两个簇，无法计算聚类稳健推断。",
                evidence={"clusterVar": cluster_var, "clusterCount": int(cluster_ids.nunique())},
            ))
            repairs.append(_repair(
                method_id,
                "confirm_rdd_cluster_level",
                "确认有研究依据的聚类层级",
                "请提供有效的聚类标识或明确改用非聚类协方差；系统不会自行更换推断口径。",
                "identification",
            ))

    if method_id in {"rdd_sharp", "rdd_fuzzy"}:
        running_var = arguments.get("runningVar")
        cutoff = arguments.get("cutoff")
        if isinstance(running_var, str) and running_var in frame.columns and isinstance(cutoff, (int, float)) and np.isfinite(cutoff):
            running_values = pd.to_numeric(frame[running_var], errors="coerce").to_numpy(dtype=float, na_value=np.nan)
            finite_values = running_values[np.isfinite(running_values)]
            left_rows = int((finite_values < cutoff).sum())
            right_rows = int((finite_values > cutoff).sum())
            at_cutoff_rows = int((finite_values == cutoff).sum())
            if left_rows == 0 or right_rows == 0:
                issues.append(DataIssue(
                    code="RDD_CUTOFF_SUPPORT_INCOMPLETE",
                    severity="blocking",
                    summary_zh=f"运行变量“{running_var}”在 cutoff={cutoff} 的一侧没有有效观测，当前样本不具备断点两侧的基本支持。",
                    evidence={
                        "runningVar": running_var,
                        "cutoff": float(cutoff),
                        "leftRows": left_rows,
                        "rightRows": right_rows,
                        "atCutoffRows": at_cutoff_rows,
                    },
                ))
                repairs.append(_repair(
                    method_id,
                    "confirm_rdd_cutoff_support",
                    "确认断点阈值与样本范围",
                    "请核对 cutoff、运行变量和研究样本范围；系统不会根据数据分布猜测或移动阈值。",
                    "identification",
                ))

    if method_id in {"logit_regression", "probit_regression"}:
        dependent_name = arguments.get("dependentVar")
        regressors = [arguments.get("treatmentVar"), *(arguments.get("covariates") or [])]
        model_columns = list(dict.fromkeys(
            [dependent_name, *regressors]
            if isinstance(dependent_name, str)
            else regressors
        ))
        if (
            isinstance(dependent_name, str)
            and dependent_name in frame.columns
            and all(isinstance(name, str) and name in frame.columns for name in model_columns)
            and not any(name in invalid_numeric for name in model_columns)
        ):
            complete = frame[model_columns].dropna()
            observed = pd.to_numeric(complete[dependent_name], errors="coerce").to_numpy(dtype=float)
            unique = np.unique(observed[np.isfinite(observed)])
            binary_issue: DataIssue | None = None
            if observed.size == 0 or not np.isfinite(observed).all():
                binary_issue = DataIssue(
                    code="BINARY_OUTCOME_NO_USABLE_CASES",
                    severity="blocking",
                    summary_zh=f"二元模型因变量“{dependent_name}”在当前完整样本中没有可用的有限观测。",
                    evidence={"column": dependent_name, "completeCaseRows": int(len(complete))},
                )
            elif not np.isin(unique, [0.0, 1.0]).all():
                binary_issue = DataIssue(
                    code="BINARY_OUTCOME_NOT_01",
                    severity="blocking",
                    summary_zh=f"因变量“{dependent_name}”不是已验证的 0/1 二元变量；Logit/Probit 不能直接用于连续或多值结果。",
                    evidence={
                        "column": dependent_name,
                        "observedValueCount": int(unique.size),
                        "nonBinaryRows": int((~np.isin(observed, [0.0, 1.0])).sum()),
                    },
                )
            elif not np.array_equal(unique, np.array([0.0, 1.0])):
                binary_issue = DataIssue(
                    code="BINARY_OUTCOME_NO_VARIATION",
                    severity="blocking",
                    summary_zh=f"因变量“{dependent_name}”在当前完整样本中没有同时包含 0 和 1 两类。",
                    evidence={"column": dependent_name, "observedValues": unique.tolist()},
                )
            if binary_issue is not None:
                issues.append(binary_issue)
                repairs.append(_repair(
                    method_id,
                    "confirm_binary_outcome_encoding",
                    "确认二元结果的测量与编码",
                    "请核对结果列是否具有明确的 0/1 二元含义；连续结果需要由你确认阈值和派生变量规则，系统不会自动分箱、重编码或切换估计量。",
                    "identification",
                ))

    if method_id == "poisson_regression":
        dependent_name = arguments.get("dependentVar")
        if isinstance(dependent_name, str) and dependent_name in frame.columns and dependent_name not in invalid_numeric:
            observed = pd.to_numeric(frame[dependent_name], errors="coerce").dropna().to_numpy(dtype=float)
            poisson_issue: DataIssue | None = None
            if observed.size == 0 or not np.isfinite(observed).all():
                poisson_issue = DataIssue(
                    code="POISSON_OUTCOME_NO_USABLE_CASES",
                    severity="blocking",
                    summary_zh=f"Poisson/PPML 因变量“{dependent_name}”没有可用的有限观测。",
                    evidence={"column": dependent_name},
                )
            elif (observed < 0).any():
                poisson_issue = DataIssue(
                    code="POISSON_OUTCOME_NEGATIVE",
                    severity="blocking",
                    summary_zh=f"因变量“{dependent_name}”包含负值；Poisson/PPML 要求非负结果，不能自动平移、截断或取绝对值。",
                    evidence={"column": dependent_name, "negativeRows": int((observed < 0).sum())},
                )
            elif np.unique(observed).size < 2:
                poisson_issue = DataIssue(
                    code="POISSON_OUTCOME_NO_VARIATION",
                    severity="blocking",
                    summary_zh=f"因变量“{dependent_name}”没有非负结果变异，不能估计 Poisson/PPML。",
                    evidence={"column": dependent_name},
                )
            if poisson_issue is not None:
                issues.append(poisson_issue)
                repairs.append(_repair(
                    method_id,
                    "confirm_poisson_outcome_support",
                    "确认 Poisson/PPML 结果变量取值范围",
                    "请核对结果变量定义和单位；若确有负值，应由你确认是否适用其他方法。系统不会平移、截断、取绝对值或静默更换估计量。",
                    "identification",
                ))

    if method_id == "negbin_regression":
        dependent_name = arguments.get("dependentVar")
        if isinstance(dependent_name, str) and dependent_name in frame.columns and dependent_name not in invalid_numeric:
            observed = pd.to_numeric(frame[dependent_name], errors="coerce").dropna().to_numpy(dtype=float)
            integer_counts = np.equal(observed, np.round(observed))
            issue: DataIssue | None = None
            if observed.size == 0 or not np.isfinite(observed).all() or (observed < 0).any():
                issue = DataIssue(
                    code="COUNT_OUTCOME_INVALID_SUPPORT",
                    severity="blocking",
                    summary_zh=f"负二项回归要求因变量“{dependent_name}”是有效的非负计数；当前存在负值、非有限值或没有可用值。",
                    evidence={"column": dependent_name},
                )
            elif not integer_counts.all():
                issue = DataIssue(
                    code="COUNT_OUTCOME_NOT_INTEGER",
                    severity="blocking",
                    summary_zh=f"负二项回归要求因变量“{dependent_name}”是非负整数次数；当前含有非整数观测。连续非负结果不能按负二项计数模型估计。",
                    evidence={"column": dependent_name, "nonIntegerRows": int((~integer_counts).sum())},
                )
            elif np.unique(observed).size < 2:
                issue = DataIssue(
                    code="COUNT_OUTCOME_NO_VARIATION",
                    severity="blocking",
                    summary_zh=f"计数因变量“{dependent_name}”没有足够变异，不能估计负二项模型。",
                    evidence={"column": dependent_name},
                )
            elif np.isin(observed, [0, 1]).all():
                issue = DataIssue(
                    code="COUNT_OUTCOME_BINARY",
                    severity="blocking",
                    summary_zh=f"因变量“{dependent_name}”只有 0/1 取值，是二元结果而非过度离散计数结果。",
                    evidence={"column": dependent_name},
                )
            if issue is not None:
                issues.append(issue)
                repairs.append(_repair(
                    method_id,
                    "confirm_count_outcome_method",
                    "确认计数变量与估计方法",
                    "核对该列的测量含义和取值。若它本身是连续非负结果，请由你确认是否改用 Poisson/PPML；若本意是次数，先核对数据编码。系统不会舍入、截断、平移结果或静默切换方法。",
                    "identification",
                ))

    if method_id == "multinomial_logit":
        dependent_name = arguments.get("dependentVar")
        if isinstance(dependent_name, str) and dependent_name in frame.columns and dependent_name not in invalid_numeric:
            observed = pd.to_numeric(frame[dependent_name], errors="coerce").dropna().to_numpy(dtype=float)
            issue: DataIssue | None = None
            if observed.size == 0 or not np.isfinite(observed).all():
                issue = DataIssue(
                    code="MULTINOMIAL_OUTCOME_INVALID",
                    severity="blocking",
                    summary_zh=f"多项 Logit 因变量“{dependent_name}”没有可用的有限类别编码。",
                    evidence={"column": dependent_name},
                )
            elif not np.equal(observed, np.round(observed)).all():
                issue = DataIssue(
                    code="MULTINOMIAL_OUTCOME_NOT_CATEGORICAL",
                    severity="blocking",
                    summary_zh=f"多项 Logit 因变量“{dependent_name}”含连续或分数值；该方法要求离散整数类别编码，不能把连续值截断成类别。",
                    evidence={"column": dependent_name},
                )
            elif np.unique(observed).size < 2:
                issue = DataIssue(
                    code="MULTINOMIAL_OUTCOME_NO_VARIATION",
                    severity="blocking",
                    summary_zh=f"多项 Logit 因变量“{dependent_name}”没有类别变异。",
                    evidence={"column": dependent_name},
                )
            elif np.unique(observed).size > 20:
                issue = DataIssue(
                    code="MULTINOMIAL_TOO_MANY_CATEGORIES",
                    severity="blocking",
                    summary_zh=f"多项 Logit 因变量“{dependent_name}”有 {np.unique(observed).size} 类，超过当前方法支持的20类上限。",
                    evidence={"column": dependent_name, "categoryCount": int(np.unique(observed).size)},
                )
            if issue is not None:
                issues.append(issue)
                repairs.append(_repair(
                    method_id,
                    "confirm_multinomial_outcome_encoding",
                    "确认多项结果的类别定义",
                    "核对结果类别的离散编码与观测单位；连续或顺序结果需要相应模型，长格式备选项数据也不能直接当作一人一行的多项结果。系统不会截断、分箱或静默改用其他方法。",
                    "identification",
                ))

    if method_id == "did_static":
        group_name = arguments.get("groupVar")
        post_name = arguments.get("postVar")
        binary_columns: dict[str, bool] = {}
        for key, label, issue_code, repair_id in (
            ("groupVar", "处理组列", "DID_GROUP_NOT_BINARY", "confirm_static_did_group"),
            ("postVar", "政策前后列", "DID_POST_NOT_BINARY", "confirm_static_did_post"),
        ):
            name = arguments.get(key)
            if not isinstance(name, str) or name not in frame.columns:
                continue
            series = frame[name]
            missing_rows = int(series.isna().sum())
            observed = series.dropna().unique().tolist()
            valid_binary = (
                pd.api.types.is_numeric_dtype(series)
                and missing_rows == 0
                and len(observed) == 2
                and set(observed) == {0, 1}
            )
            binary_columns[key] = valid_binary
            if not valid_binary:
                detail = f"缺失 {missing_rows} 行、非缺失取值 {len(observed)} 种"
                issues.append(DataIssue(
                    code=issue_code,
                    severity="blocking",
                    summary_zh=f"传统两组两期 DID 的{label}“{name}”必须完整且只包含 0/1；当前{detail}。",
                    evidence={"column": name, "missingRows": missing_rows, "observedValueCount": len(observed)},
                ))
                if key == "groupVar":
                    post_context = (
                        f"当前传入的政策前后列为“{post_name}”；请同时确认它是否表示研究设计中的统一政策后时期。"
                        if isinstance(post_name, str) and post_name.strip()
                        else ""
                    )
                    description = (
                        f"请指定真实且完整的 0/1 处理组/对照组列；若“{name}”表示各单位首次处理时期，"
                        f"不要把 cohort 年份直接当作处理组。{post_context}传统 DID 还需要研究者确认统一的政策前/后列；"
                        "若处理时点分批，需由你决定是否改用交错 DID，系统不会自动切换。"
                    )
                else:
                    description = f"请指定由研究设计确认的共同政策前/后 0/1 列；逐行处理状态不一定等价于统一 post。"
                repairs.append(_repair(method_id, repair_id, f"确认{name}的研究定义", description, "identification"))

        if (
            isinstance(group_name, str)
            and isinstance(post_name, str)
            and group_name != post_name
            and group_name in frame.columns
            and post_name in frame.columns
            and binary_columns.get("groupVar") is True
            and binary_columns.get("postVar") is True
        ):
            cell_counts = {(group, post): 0 for group in (0, 1) for post in (0, 1)}
            for group, post in zip(frame[group_name].tolist(), frame[post_name].tolist()):
                cell_counts[(int(group), int(post))] += 1
            missing_cells = [[group, post] for (group, post), count in cell_counts.items() if count == 0]
            if missing_cells:
                rendered_cells = "、".join(f"处理组={group}/政策后={post}" for group, post in missing_cells)
                issues.append(DataIssue(
                    code="DID_TWO_BY_TWO_CELLS_INCOMPLETE",
                    severity="blocking",
                    summary_zh=f"传统两组两期 DID 缺少四格样本单元：{rendered_cells}。",
                    evidence={
                        "groupVar": group_name,
                        "postVar": post_name,
                        "missingCells": missing_cells,
                        "cellCounts": {f"{group}_{post}": count for (group, post), count in cell_counts.items()},
                    },
                ))
                repairs.append(_repair(
                    method_id,
                    "confirm_static_did_sample_cells",
                    "确认四格样本的时期和覆盖范围",
                    "请确认是否需要筛选政策前/后时期，以及相应处理组/对照组是否都有观测；系统不会自动删行或选择时期窗口。",
                    "identification",
                ))

    panel_methods = {"panel_fe_regression", "panel_random_effects", "did2s", "did_event_study_saturated"}
    entity = arguments.get("entityVar")
    time = arguments.get("timeVar")
    if method_id in panel_methods:
        missing_keys = [
            field for field, value in (("entityVar", entity), ("timeVar", time))
            if not isinstance(value, str) or not value.strip()
        ]
        if missing_keys:
            issues.append(DataIssue(
                code="PANEL_KEYS_REQUIRED",
                severity="blocking",
                summary_zh=f"当前面板方法还缺少明确的实体列或时间列：{'、'.join(missing_keys)}。系统不会按列名、类型或数据排序推断面板键。",
                evidence={"missingKeys": missing_keys},
            ))
            repairs.append(_repair(
                method_id,
                "confirm_panel_key_roles",
                "确认面板实体与时间列",
                "请从当前数据的真实字段中明确指定每个观测单位和时期；若数据并非面板，请先确认是否应改用其他方法。系统不会猜测或自动替换面板键。",
                "identification",
            ))
    if method_id in panel_methods and isinstance(entity, str) and isinstance(time, str) and entity in frame.columns and time in frame.columns:
        missing_entity_rows = int(frame[entity].isna().sum())
        missing_time_rows = int(frame[time].isna().sum())
        if missing_entity_rows or missing_time_rows:
            issues.append(DataIssue(
                code="DATA_PANEL_KEY_MISSING",
                severity="blocking",
                summary_zh=(
                    f"面板键 {entity}×{time} 存在缺失值"
                    f"（实体 {missing_entity_rows} 行、时间 {missing_time_rows} 行），不能静默丢弃这些观测。"
                ),
                evidence={
                    "entityVar": entity,
                    "timeVar": time,
                    "missingEntityRows": missing_entity_rows,
                    "missingTimeRows": missing_time_rows,
                },
            ))
            repairs.append(_repair(
                method_id,
                "confirm_panel_key_missing_values",
                "确认缺失面板键的处理",
                "请核对实体/时间标识来源，或明确是否排除含缺失键的观测；系统不会静默删除行，也不会把缺失键当作普通重复。",
                "identification",
            ))
        duplicate_rows = int(frame.duplicated(subset=[entity, time]).sum())
        if duplicate_rows > 0:
            issues.append(DataIssue(
                code="DATA_PANEL_KEY_NOT_UNIQUE",
                severity="blocking",
                summary_zh=f"{entity}×{time} 存在 {duplicate_rows} 行重复键，不能直接执行当前方法。",
                evidence={"entityVar": entity, "timeVar": time, "duplicateRows": duplicate_rows},
            ))
            repairs.append(_repair(method_id, "confirm_panel_key", "确认面板键处理", "确认组合实体、聚合或其它观测单位处理方式；不要直接删除重复行。", "identification"))

    if method_id == "did_event_study_saturated":
        cohort_var = arguments.get("cohortVar")
        treatment_var = arguments.get("treatmentVar")
        if all(isinstance(name, str) and name in frame.columns for name in (entity, time, cohort_var, treatment_var)):
            raw_cohort = frame[cohort_var]
            cohort = pd.to_numeric(raw_cohort, errors="coerce")
            missing_cohort = int(raw_cohort.isna().sum())
            sentinel = arguments.get("neverTreatedCohortValue")
            if missing_cohort and sentinel != 0:
                issues.append(DataIssue(
                    code="DATA_COHORT_MISSING",
                    severity="blocking",
                    summary_zh=f"首次处理时期列 {cohort_var} 有 {missing_cohort} 行缺失；事件研究需明确这些是否代表从未处理组，PyFixest 使用 cohort=0 表示从未处理。",
                    evidence={"cohortVar": cohort_var, "missingRows": missing_cohort},
                ))
                repairs.append(_repair(
                    method_id,
                    "confirm_never_treated_cohort_zero",
                    "确认缺失 cohort 的含义与编码",
                    f"若用户确认 {cohort_var} 缺失即从未处理，才可在估计副本中按0编码；原始数据保持不变。",
                    "identification",
                ))
            else:
                effective_cohort = cohort.fillna(0) if sentinel == 0 else cohort
                period = pd.to_numeric(frame[time], errors="coerce")
                treatment = pd.to_numeric(frame[treatment_var], errors="coerce")
                invalid_cohort = effective_cohort.isna() | ~np.isfinite(effective_cohort.to_numpy(dtype=float))
                fractional_cohort = not invalid_cohort.any() and not np.equal(
                    effective_cohort.to_numpy(dtype=float), np.floor(effective_cohort.to_numpy(dtype=float)),
                ).all()
                invalid_treatment = (
                    treatment.isna().any() or
                    not np.isfinite(treatment.to_numpy(dtype=float)).all() or
                    not set(treatment.dropna().unique()).issubset({0, 1})
                )
                if invalid_cohort.any() or fractional_cohort or (effective_cohort < 0).any():
                    issues.append(DataIssue(
                        code="DATA_COHORT_INVALID",
                        severity="blocking",
                        summary_zh=f"首次处理时期列 {cohort_var} 必须使用非负整数年份；只有经用户确认的从未处理缺失可映射到0。",
                        evidence={"cohortVar": cohort_var},
                    ))
                    repairs.append(_repair(method_id, "confirm_event_study_cohort_values", "核对首次处理时期编码", "提供各分析单位首次处理时期，或确认从未处理组的编码。", "identification"))
                elif invalid_treatment or period.isna().any() or not np.isfinite(period.to_numpy(dtype=float)).all():
                    issues.append(DataIssue(
                        code="DATA_TREATMENT_COHORT_MISMATCH",
                        severity="blocking",
                        summary_zh=f"处理列 {treatment_var}、cohort {cohort_var} 和时期 {time} 必须完整且使用可核验的数值编码。",
                        evidence={"treatmentVar": treatment_var, "cohortVar": cohort_var, "timeVar": time},
                    ))
                    repairs.append(_repair(method_id, "confirm_event_study_treatment_cohort", "核对处理与 cohort 关系", "确认处理指示、首次处理时期和观测时期逐行一致。", "identification"))
                else:
                    if not effective_cohort.eq(0).any():
                        issues.append(DataIssue(
                            code="DATA_NEVER_TREATED_GROUP_MISSING",
                            severity="blocking",
                            summary_zh="当前事件研究估计器要求 cohort=0 表示从未处理组，但数据中没有该组。",
                            evidence={"cohortVar": cohort_var},
                        ))
                        repairs.append(_repair(method_id, "confirm_never_treated_comparison", "确认未处理对照组", "确认是否存在有效的从未处理单位；方法不会把已处理单位改作对照组。", "identification"))
                    unit_cohort_count = effective_cohort.groupby(frame[entity], dropna=False).nunique(dropna=False)
                    expected_treatment = (effective_cohort.gt(0) & period.ge(effective_cohort)).astype(int)
                    if unit_cohort_count.gt(1).any() or not treatment.astype(int).eq(expected_treatment).all():
                        issues.append(DataIssue(
                            code="DATA_TREATMENT_COHORT_MISMATCH",
                            severity="blocking",
                            summary_zh=f"处理列 {treatment_var} 必须逐行符合“cohort>0 且 {time}>=cohort”；同一 {entity} 的 cohort 也必须保持不变。",
                            evidence={"treatmentVar": treatment_var, "cohortVar": cohort_var, "timeVar": time},
                        ))
                        repairs.append(_repair(method_id, "confirm_event_study_treatment_cohort", "核对处理与 cohort 关系", "确认处理标志的生成规则和从未处理组编码；系统不会重写处理变量。", "identification"))

    analysis_unit = arguments.get("analysisUnitVar")
    if method_id in {"psm_construction", "psm_visualize", "psm_matching", "psm_ipw", "psm_regression", "psm_double_robust"} and isinstance(analysis_unit, str) and analysis_unit in frame.columns:
        missing_units = int(frame[analysis_unit].isna().sum())
        duplicate_units = int(frame.loc[frame[analysis_unit].notna(), analysis_unit].duplicated().sum())
        if missing_units:
            issues.append(DataIssue(
                code="DATA_ANALYSIS_UNIT_MISSING",
                severity="blocking",
                summary_zh=f"分析单位列 {analysis_unit} 有 {missing_units} 行缺失，无法确认每条记录属于哪个独立单位。",
                evidence={"analysisUnitVar": analysis_unit, "missingRows": missing_units},
            ))
            repairs.append(_repair(
                method_id,
                "confirm_missing_analysis_units",
                "确认缺失分析单位标识的处理",
                "先核对标识来源；若不能可靠恢复，需由用户决定是否排除这些观测并重新检查样本。系统不会猜测标识或静默删行。",
                "identification",
            ))
        if duplicate_units:
            issues.append(DataIssue(
                code="DATA_ANALYSIS_UNIT_NOT_UNIQUE",
                severity="blocking",
                summary_zh=f"分析单位列 {analysis_unit} 有 {duplicate_units} 行重复观测；PSM 要求每个分析单位仅一行，不能把这些重复记录直接当作独立样本。",
                evidence={"analysisUnitVar": analysis_unit, "duplicateRows": duplicate_units},
            ))
            repairs.append(_repair(
                method_id,
                "confirm_psm_cross_section",
                "确认如何构造一行一个分析单位的数据",
                "请指定分析时期，或明确结果、处理状态和处理前协变量各自的时点/聚合规则，再生成并重新检查派生数据阶段。仅填写聚合参数不会自动改写当前数据。",
                "identification",
            ))

    design_names: list[str] = []
    treatment_name = arguments.get("treatmentVar")
    if isinstance(treatment_name, str) and treatment_name.strip():
        design_names.append(treatment_name)
    covariates = arguments.get("covariates")
    if isinstance(covariates, list):
        design_names.extend(name for name in covariates if isinstance(name, str) and name.strip())
    # Rank is a property of the model's right-hand-side design matrix. Never add the
    # outcome or WLS precision weights as regressors merely because they are numeric inputs.
    regressors = list(dict.fromkeys(name for name in design_names if name in frame.columns))
    if method_id in {"ols_regression", "panel_fe_regression", "panel_random_effects", "hdfe_regression", "robust_regression", "wls_regression", "quantile_regression"} and len(regressors) >= 2:
        numeric = frame[regressors].apply(pd.to_numeric, errors="coerce").dropna()
        if not numeric.empty and np.isfinite(numeric.to_numpy(dtype=float)).all():
            design = np.column_stack([np.ones(len(numeric)), numeric.to_numpy(dtype=float)])
            if int(np.linalg.matrix_rank(design)) < design.shape[1]:
                linear_dependency: dict[str, Any] | None = None
                for dependent_column in regressors:
                    right_columns = [name for name in regressors if name != dependent_column]
                    right = np.column_stack([
                        np.ones(len(numeric)),
                        numeric[right_columns].to_numpy(dtype=float),
                    ])
                    target = numeric[dependent_column].to_numpy(dtype=float)
                    coefficients, *_ = np.linalg.lstsq(right, target, rcond=None)
                    residual = target - right @ coefficients
                    max_abs_residual = float(np.max(np.abs(residual)))
                    tolerance = max(1e-12, float(np.max(np.abs(target))) * 1e-10)
                    if max_abs_residual > tolerance:
                        continue

                    terms: list[str] = []
                    intercept = float(coefficients[0])
                    if abs(intercept) > tolerance:
                        terms.append(f"{intercept:.6g}")
                    relation_terms: list[dict[str, Any]] = []
                    for column, coefficient in zip(right_columns, coefficients[1:]):
                        coefficient = float(coefficient)
                        if abs(coefficient) <= 1e-8:
                            continue
                        magnitude = abs(coefficient)
                        label = column if np.isclose(magnitude, 1.0, atol=1e-6) else f"{magnitude:.6g}×{column}"
                        if not terms and not relation_terms:
                            terms.append(("-" if coefficient < 0 else "") + label)
                        else:
                            terms.append((" - " if coefficient < 0 else " + ") + label)
                        relation_terms.append({"column": column, "coefficient": coefficient})
                    if not terms:
                        continue
                    linear_dependency = {
                        "dependentColumn": dependent_column,
                        "intercept": intercept,
                        "terms": relation_terms,
                        "maxAbsResidual": max_abs_residual,
                        "equation": f"{dependent_column} = {''.join(terms)}",
                    }
                    break
                relationship = (
                    f"可核验的样本内线性关系：{linear_dependency['equation']}（最大残差 {linear_dependency['maxAbsResidual']:.3g}）。"
                    if linear_dependency is not None
                    else "当前样本的解释变量存在完全线性依赖。"
                )
                issues.append(DataIssue(
                    code="DESIGN_MATRIX_RANK_DEFICIENT",
                    severity="blocking",
                    summary_zh=f"当前模型设计矩阵秩亏，无法唯一识别系数。{relationship}",
                    evidence={
                        "columns": regressors,
                        **({"linearDependency": linear_dependency} if linear_dependency is not None else {}),
                    },
                ))
                repairs.extend([
                    _repair(method_id, "rank_keep_core", "保留核心变量并移除共线控制变量", "会改变控制变量集合，必须确认研究含义。", "identification"),
                    _repair(method_id, "rank_change_design", "改用指数构造或贡献分析", "如果变量是同一指数构成项，不把恒等式当作回归关系。", "identification"),
                ])

    if not issues:
        return MethodPreflightResult(
            method_id=method_id,
            executable=True,
            status="ready",
            normalized_arguments=arguments,
            data_fingerprint=data_fingerprint,
        )
    status = "requires_user_decision" if any(item.requires_confirmation for item in repairs) else "repairable"
    return MethodPreflightResult(
        method_id=method_id,
        executable=False,
        status=status,
        normalized_arguments=arguments,
        data_fingerprint=data_fingerprint,
        issues=issues,
        repair_plan=repairs,
    )
