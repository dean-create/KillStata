from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Iterable, Literal, Sequence

import numpy as np
import pandas as pd
from scipy.stats.mstats import winsorize as scipy_winsorize
from scipy import stats as scipy_stats


Summary = dict[str, Any]
FillStrategy = Literal["constant", "mean", "median", "mode", "forward", "backward"]
OutlierMethod = Literal["iqr", "zscore"]


def _copy(df: pd.DataFrame) -> pd.DataFrame:
    return df.copy(deep=True)


def _json_safe(value: Any) -> Any:
    if isinstance(value, dict):
        return {str(key): _json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_json_safe(item) for item in value]
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, (np.bool_,)):
        return bool(value)
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    return value


def _ensure_columns(df: pd.DataFrame, columns: Sequence[str] | None) -> list[str]:
    if not columns:
        return list(df.columns)
    missing = [column for column in columns if column not in df.columns]
    if missing:
        raise ValueError(f"Columns not found: {missing}")
    return list(columns)


def _ensure_numeric(df: pd.DataFrame, columns: Sequence[str]) -> pd.DataFrame:
    numeric = _copy(df)
    for column in columns:
        numeric[column] = pd.to_numeric(numeric[column], errors="coerce")
    return numeric


def _operation_summary(
    *,
    operation: str,
    rows_before: int,
    rows_after: int,
    columns_before: int,
    columns_after: int,
    affected_columns: Sequence[str] | None = None,
    created_columns: Sequence[str] | None = None,
    warnings: Sequence[str] | None = None,
    extra: dict[str, Any] | None = None,
) -> Summary:
    return {
        "operation": operation,
        "rows_before": int(rows_before),
        "rows_after": int(rows_after),
        "rows_changed": int(rows_after - rows_before),
        "columns_before": int(columns_before),
        "columns_after": int(columns_after),
        "columns_changed": int(columns_after - columns_before),
        "affected_columns": list(affected_columns or []),
        "created_columns": list(created_columns or []),
        "warnings": list(warnings or []),
        **_json_safe(extra or {}),
    }


def get_column_info(df: pd.DataFrame) -> dict[str, list[str]]:
    column_info = {
        "Category": [],
        "Numeric": [],
        "Datetime": [],
        "Others": [],
    }
    for column in df.columns:
        dtype = str(df[column].dtype)
        if pd.api.types.is_numeric_dtype(df[column]):
            column_info["Numeric"].append(column)
        elif pd.api.types.is_datetime64_any_dtype(df[column]):
            column_info["Datetime"].append(column)
        elif dtype.startswith("object") or dtype.startswith("string") or pd.api.types.is_categorical_dtype(df[column]):
            column_info["Category"].append(column)
        else:
            column_info["Others"].append(column)

    if len(json.dumps(column_info, ensure_ascii=False)) > 2000:
        column_info["Numeric"] = column_info["Numeric"][:5] + ["Too many cols, omission here..."]
    return column_info


def coerce_dataframe_types(
    df: pd.DataFrame,
    *,
    numeric_threshold: float = 0.8,
    datetime_threshold: float = 0.8,
    skip_columns: Sequence[str] | None = None,
) -> tuple[pd.DataFrame, Summary]:
    working = _copy(df)
    skipped = set(skip_columns or [])
    converted_numeric: list[str] = []
    converted_datetime: list[str] = []

    for column in working.columns:
        if column in skipped or pd.api.types.is_numeric_dtype(working[column]) or pd.api.types.is_datetime64_any_dtype(working[column]):
            continue

        non_null = working[column].dropna()
        if non_null.empty:
            continue

        numeric_candidate = pd.to_numeric(non_null, errors="coerce")
        numeric_success = float(numeric_candidate.notna().mean())
        if numeric_success >= numeric_threshold:
            working[column] = pd.to_numeric(working[column], errors="coerce")
            converted_numeric.append(column)
            continue

        datetime_candidate = pd.to_datetime(non_null, errors="coerce")
        datetime_success = float(datetime_candidate.notna().mean())
        if datetime_success >= datetime_threshold:
            working[column] = pd.to_datetime(working[column], errors="coerce")
            converted_datetime.append(column)

    summary = _operation_summary(
        operation="coerce_dataframe_types",
        rows_before=len(df),
        rows_after=len(working),
        columns_before=len(df.columns),
        columns_after=len(working.columns),
        affected_columns=[*converted_numeric, *converted_datetime],
        extra={
            "converted_numeric": converted_numeric,
            "converted_datetime": converted_datetime,
        },
    )
    return working, summary


def profile_dataframe(df: pd.DataFrame, *, sample_rows: int = 5, max_distinct: int = 20) -> tuple[pd.DataFrame, Summary]:
    distinct_counts = {
        column: int(df[column].nunique(dropna=True))
        for column in df.columns
    }
    value_samples = {}
    for column in df.columns:
        uniques = df[column].dropna().astype(str).unique().tolist()
        value_samples[column] = uniques[:max_distinct]

    summary = {
        "operation": "profile_dataframe",
        "row_count": int(len(df)),
        "column_count": int(len(df.columns)),
        "column_info": get_column_info(df),
        "missing_share": {
            column: float(df[column].isna().mean())
            for column in df.columns
            if float(df[column].isna().mean()) > 0
        },
        "distinct_count": distinct_counts,
        "value_samples": value_samples,
        "sample_rows": df.head(sample_rows).replace({np.nan: None}).to_dict(orient="records"),
    }
    return _copy(df), _json_safe(summary)


def _find_duplicate_key_resolution(
    df: pd.DataFrame,
    *,
    entity_var: str,
    time_var: str,
) -> dict[str, Any] | None:
    """(entity_var, time_var) 有重复时，尝试用数据里已有的另一列把重复消掉。

    典型场景：同名实体分属不同上级层级（如"其他"这个地区名在北京、上海、西藏各出现一次），
    entity_var 本身不足以唯一标识观测单位，但数据里往往还带着能补全身份的那一列（省份）。
    这是纯本地、确定性的检查——加一列能不能让 duplicated().sum() 归零是可以直接算出来的
    事实，不该丢给模型或用户去猜"是不是同名实体重复"。只在候选列单独就能把重复完全消掉时
    才报告；消不掉说明不是这种情况，交回原有的"先核实是否为真实重复记录"路径。
    """
    candidates = [
        column
        for column in df.columns
        if column not in (entity_var, time_var)
        and not pd.api.types.is_numeric_dtype(df[column])
        and not pd.api.types.is_datetime64_any_dtype(df[column])
        and 1 < df[column].nunique(dropna=True) < len(df)
    ]
    for column in candidates:
        if int(df.duplicated(subset=[column, entity_var, time_var]).sum()) == 0:
            return {
                "resolving_column": column,
                "composite_entities": int(df[column].astype(str).str.cat(df[entity_var].astype(str), sep="_").nunique()),
            }
    return None


def build_quality_report(
    df: pd.DataFrame,
    *,
    entity_var: str | None = None,
    time_var: str | None = None,
    outlier_method: OutlierMethod = "zscore",
    outlier_threshold: float = 3.5,
) -> tuple[pd.DataFrame, Summary]:
    warnings: list[str] = []
    blocking_errors: list[str] = []
    suggested_repairs: list[str] = []

    usable_observation_count = int(df.dropna(how="all").shape[0])
    if len(df) == 0:
        blocking_errors.append("数据集没有观测行，当前没有任何计量方法可以执行")
    elif usable_observation_count == 0:
        blocking_errors.append("数据集的所有观测均为空，当前没有可用观测")

    missing_share = {
        column: round(float(df[column].isna().mean()), 6)
        for column in df.columns
        if float(df[column].isna().mean()) > 0
    }
    high_missing = [column for column, share in missing_share.items() if share >= 0.2]
    # 高缺失列不直接定性为"数据质量警告"：缺失率高可能是研究设计使然（如政策实施年份
    # time 对未处理组缺失 100%），也可能是真实问题，QA 无从区分；且大多数缺失列根本不
    # 进入用户请求的回归（2026-08-08 用户反馈"time 列缺失与任何计量方法无关，觉得 QA
    # 太严格"）。改为把缺失率作为说明性信息（中文 notes）交给模型，由模型根据本次
    # 分析目标判断哪些列缺失需要处理（该列是否进入回归、缺失会不会影响样本量/推断）。
    notes: list[str] = []
    for column in high_missing:
        notes.append(
            f"列 '{column}' 缺失 {missing_share[column] * 100:.1f}%。"
            "该列是否会影响本次分析由你（模型）根据回归目标判断：若该列不进入本次回归，"
            "此信息仅供参考；若进入回归，缺失会减少有效样本，需评估是否补全/剔除。"
        )

    duplicate_rows = 0
    duplicate_resolution: dict[str, Any] | None = None
    panel_balance = None
    if entity_var and time_var:
        missing_keys = [column for column in [entity_var, time_var] if column not in df.columns]
        if missing_keys:
            blocking_errors.append(f"Panel identifiers not found: {missing_keys}")
        else:
            duplicate_rows = int(df.duplicated(subset=[entity_var, time_var]).sum())
            if duplicate_rows > 0:
                duplicate_resolution = _find_duplicate_key_resolution(df, entity_var=entity_var, time_var=time_var)
                if duplicate_resolution:
                    # 已验证：这不是真实重复，是 entity_var 缺了一层身份信息。给出可直接
                    # 执行的修复（具体列名 + 组合后的唯一实体数），不要求模型/用户自行判断。
                    blocking_errors.append(
                        f"Found {duplicate_rows} duplicate entity-time rows under '{entity_var}'x'{time_var}'. "
                        f"Verified: combining '{entity_var}' with column '{duplicate_resolution['resolving_column']}' "
                        f"resolves all duplicates (yields {duplicate_resolution['composite_entities']} unique entities, "
                        "0 duplicates). This is not a true duplicate-record issue."
                    )
                    suggested_repairs.append(
                        f"Use data_preprocess combine_columns to merge '{duplicate_resolution['resolving_column']}' "
                        f"and '{entity_var}' into a composite entity column, then rerun QA with that column as entityVar."
                    )
                else:
                    blocking_errors.append(f"Found {duplicate_rows} duplicate entity-time rows")
                    suggested_repairs.append("Deduplicate panel keys before regression")
            _, panel_balance = panel_balance_check(df, entity_var=entity_var, time_var=time_var)
            if panel_balance["is_balanced"] is False:
                # 面板不平衡是描述性事实不是质量问题（真实面板几乎都不完全平衡，FE 仍然有效）。
                # 降级为说明性 notes 交给模型判断是否需要向用户说明，不 inflate status。
                notes.append(
                    f"面板不完全平衡：实体数 {panel_balance.get('entity_count')}，"
                    f"期数 {panel_balance.get('time_count')}，"
                    f"实体观测期数范围 {panel_balance.get('min_periods_per_entity')}-{panel_balance.get('max_periods_per_entity')}。"
                    "多数真实面板都不完全平衡，固定效应估计仍有效；是否向用户说明由你判断。"
                )

    numeric_columns = df.select_dtypes(include=["number"]).columns.tolist()
    if not numeric_columns:
        warnings.append("Dataset has no numeric columns")

    _, outlier_summary = detect_outliers(
        df,
        columns=numeric_columns,
        method=outlier_method,
        threshold=outlier_threshold,
    )
    flagged_outlier_columns = [
        item["column"]
        for item in outlier_summary["flagged_columns"]
        if item["flagged_rows"] > 0
    ]
    if flagged_outlier_columns:
        warnings.append(
            f"检测到潜在异常值（|z|>{outlier_threshold}）的列：{flagged_outlier_columns}。"
            "这是提示不是阻断：若这些列进入回归，需评估极端值对估计的影响（如是否缩尾/取对数）；"
            "若未纳入本次规格，只能说明它们未参与本次估计，遗漏变量影响未被本次模型评估。"
        )

    status = "pass"
    if warnings:
        status = "warn"
    if blocking_errors:
        status = "block"

    report = {
        "operation": "build_quality_report",
        "status": status,
        "warnings": warnings,
        "blocking_errors": blocking_errors,
        "suggested_repairs": suggested_repairs,
        "row_count": int(len(df)),
        "column_count": int(len(df.columns)),
        "usable_observation_count": usable_observation_count,
        "numeric_columns": numeric_columns,
        "missing_share": missing_share,
        "duplicate_entity_time_rows": duplicate_rows,
        "duplicate_key_resolution": duplicate_resolution,
        "panel_balance": panel_balance,
        "outliers": outlier_summary,
        "notes": notes,
    }
    return _copy(df), _json_safe(report)


def drop_missing_rows(df: pd.DataFrame, *, columns: Sequence[str] | None = None) -> tuple[pd.DataFrame, Summary]:
    working = _copy(df)
    target_columns = _ensure_columns(working, columns) if columns else None
    before = len(working)
    working = working.dropna(subset=target_columns)
    summary = _operation_summary(
        operation="drop_missing_rows",
        rows_before=before,
        rows_after=len(working),
        columns_before=len(df.columns),
        columns_after=len(working.columns),
        affected_columns=target_columns,
    )
    return working, summary


def fill_missing_values(
    df: pd.DataFrame,
    *,
    columns: Sequence[str] | None = None,
    strategy: FillStrategy = "constant",
    value: Any = 0,
    group_by: Sequence[str] | None = None,
) -> tuple[pd.DataFrame, Summary]:
    working = _copy(df)
    target_columns = _ensure_columns(working, columns)
    missing_before = {column: int(working[column].isna().sum()) for column in target_columns}
    # 面板数据的前向/后向填充必须按个体分组，否则 pandas 的全表 ffill/bfill 会把上一个个体
    # 末期的值填进下一个个体首期，造成跨个体数值污染且不报错。有 group_by 时组内填充。
    group_columns = [column for column in (group_by or []) if column in working.columns]

    for column in target_columns:
        if strategy == "mean":
            numeric = pd.to_numeric(working[column], errors="coerce")
            if numeric.dropna().empty:
                raise ValueError(f"Cannot mean-impute all missing column: {column}")
            fill_value = numeric.mean()
        elif strategy == "median":
            numeric = pd.to_numeric(working[column], errors="coerce")
            if numeric.dropna().empty:
                raise ValueError(f"Cannot median-impute all missing column: {column}")
            fill_value = numeric.median()
        elif strategy == "mode":
            mode = working[column].mode(dropna=True)
            fill_value = mode.iloc[0] if not mode.empty else value
        elif strategy == "forward":
            if group_columns:
                working[column] = working.groupby(group_columns, dropna=False)[column].ffill()
            else:
                working[column] = working[column].ffill()
            continue
        elif strategy == "backward":
            if group_columns:
                working[column] = working.groupby(group_columns, dropna=False)[column].bfill()
            else:
                working[column] = working[column].bfill()
            continue
        else:
            fill_value = value
        working[column] = working[column].fillna(fill_value)

    missing_after = {column: int(working[column].isna().sum()) for column in target_columns}
    summary = _operation_summary(
        operation="fill_missing_values",
        rows_before=len(df),
        rows_after=len(working),
        columns_before=len(df.columns),
        columns_after=len(working.columns),
        affected_columns=target_columns,
        extra={
            "strategy": strategy,
            "missing_before": missing_before,
            "missing_after": missing_after,
        },
    )
    return working, summary


def fill_missing_constant(df: pd.DataFrame, *, columns: Sequence[str] | None = None, value: Any = 0) -> tuple[pd.DataFrame, Summary]:
    return fill_missing_values(df, columns=columns, strategy="constant", value=value)


def fill_missing_statistics(
    df: pd.DataFrame,
    *,
    columns: Sequence[str] | None = None,
    strategy: Literal["mean", "median", "mode"] = "mean",
) -> tuple[pd.DataFrame, Summary]:
    return fill_missing_values(df, columns=columns, strategy=strategy)


def forward_backward_fill(
    df: pd.DataFrame,
    *,
    columns: Sequence[str] | None = None,
    direction: Literal["forward", "backward"] = "forward",
    group_by: Sequence[str] | None = None,
) -> tuple[pd.DataFrame, Summary]:
    strategy: FillStrategy = "forward" if direction == "forward" else "backward"
    return fill_missing_values(df, columns=columns, strategy=strategy, group_by=group_by)


def linear_interpolate(
    df: pd.DataFrame,
    *,
    columns: Sequence[str],
    time_var: str | None = None,
) -> tuple[pd.DataFrame, Summary]:
    return interpolate_by_group(df, columns=columns, time_var=time_var, group_by=None)


def interpolate_by_group(
    df: pd.DataFrame,
    *,
    columns: Sequence[str],
    time_var: str | None,
    group_by: Sequence[str] | None = None,
) -> tuple[pd.DataFrame, Summary]:
    working = _copy(df)
    target_columns = _ensure_columns(working, columns)
    sort_columns = list(group_by or [])
    if time_var:
        if time_var not in working.columns:
            raise ValueError(f"time_var not found: {time_var}")
        sort_columns.append(time_var)
    if sort_columns:
        working = working.sort_values(sort_columns)

    numeric = _ensure_numeric(working, target_columns)
    for column in target_columns:
        if group_by:
            working[column] = (
                numeric.groupby(list(group_by), dropna=False)[column]
                .transform(lambda series: series.interpolate(method="linear", limit_direction="both"))
            )
        else:
            working[column] = numeric[column].interpolate(method="linear", limit_direction="both")

    summary = _operation_summary(
        operation="interpolate_by_group",
        rows_before=len(df),
        rows_after=len(working),
        columns_before=len(df.columns),
        columns_after=len(working.columns),
        affected_columns=target_columns,
        extra={
            "time_var": time_var,
            "group_by": list(group_by or []),
        },
    )
    return working, summary


def group_linear_interpolate(
    df: pd.DataFrame,
    *,
    columns: Sequence[str],
    time_var: str,
    group_by: Sequence[str],
) -> tuple[pd.DataFrame, Summary]:
    return interpolate_by_group(df, columns=columns, time_var=time_var, group_by=group_by)


def regression_impute(
    df: pd.DataFrame,
    *,
    columns: Sequence[str],
    predictors: Sequence[str],
) -> tuple[pd.DataFrame, Summary]:
    working = _copy(df)
    target_columns = _ensure_columns(working, columns)
    predictor_columns = _ensure_columns(working, predictors)
    warnings: list[str] = []

    for column in target_columns:
        frame = working[[column, *predictor_columns]].copy()
        for key in frame.columns:
            frame[key] = pd.to_numeric(frame[key], errors="coerce")
        train = frame.dropna()
        if train.empty:
            raise ValueError(f"Regression imputation has no complete training rows for {column}")

        x_train = train[predictor_columns].to_numpy(dtype=float)
        y_train = train[column].to_numpy(dtype=float)
        x_train = np.column_stack([np.ones(len(x_train)), x_train])
        beta = np.linalg.pinv(x_train.T @ x_train) @ (x_train.T @ y_train)

        missing_mask = frame[column].isna() & frame[predictor_columns].notna().all(axis=1)
        if missing_mask.any():
            x_pred = frame.loc[missing_mask, predictor_columns].to_numpy(dtype=float)
            x_pred = np.column_stack([np.ones(len(x_pred)), x_pred])
            working.loc[missing_mask, column] = x_pred @ beta

    warnings.append("Regression imputation modifies missingness patterns; review audit artifacts before estimation.")
    summary = _operation_summary(
        operation="regression_impute",
        rows_before=len(df),
        rows_after=len(working),
        columns_before=len(df.columns),
        columns_after=len(working.columns),
        affected_columns=target_columns,
        warnings=warnings,
        extra={"predictors": predictor_columns},
    )
    return working, summary


def log_transform_columns(
    df: pd.DataFrame,
    *,
    columns: Sequence[str],
    offset: float = 1.0,
    prefix: str = "log_",
    suffix: str | None = None,
) -> tuple[pd.DataFrame, Summary]:
    working = _ensure_numeric(_copy(df), _ensure_columns(df, columns))
    created_columns: list[str] = []
    for column in columns:
        target = f"{column}{suffix}" if suffix is not None else f"{prefix}{column}"
        shifted = working[column] + offset
        if shifted.dropna().empty or not np.isfinite(shifted.dropna().to_numpy(dtype=float)).all() or (shifted.dropna() <= 0).any():
            raise ValueError(f"Log transform requires finite positive values after offset for column: {column}")
        working[target] = np.log(shifted)
        created_columns.append(target)
    summary = _operation_summary(
        operation="log_transform_columns",
        rows_before=len(df),
        rows_after=len(working),
        columns_before=len(df.columns),
        columns_after=len(working.columns),
        affected_columns=columns,
        created_columns=created_columns,
        extra={"offset": offset},
    )
    return working, summary


def log_transform(df: pd.DataFrame, *, columns: Sequence[str], offset: float = 1.0) -> tuple[pd.DataFrame, Summary]:
    return log_transform_columns(df, columns=columns, offset=offset)


def standardize_columns(
    df: pd.DataFrame,
    *,
    columns: Sequence[str],
    suffix: str = "_std",
) -> tuple[pd.DataFrame, Summary]:
    working = _ensure_numeric(_copy(df), _ensure_columns(df, columns))
    created_columns: list[str] = []
    for column in columns:
        std = float(working[column].std(ddof=0))
        if std == 0 or np.isnan(std):
            raise ValueError(f"Cannot standardize zero-variance column: {column}")
        target = f"{column}{suffix}"
        working[target] = (working[column] - working[column].mean()) / std
        created_columns.append(target)
    summary = _operation_summary(
        operation="standardize_columns",
        rows_before=len(df),
        rows_after=len(working),
        columns_before=len(df.columns),
        columns_after=len(working.columns),
        affected_columns=columns,
        created_columns=created_columns,
    )
    return working, summary


def standardize(df: pd.DataFrame, *, columns: Sequence[str]) -> tuple[pd.DataFrame, Summary]:
    return standardize_columns(df, columns=columns)


def detect_zscore_outliers(
    df: pd.DataFrame,
    *,
    columns: Sequence[str],
    threshold: float = 3.0,
) -> dict[str, dict[str, Any]]:
    """Return bounded, original-row-index Z-score diagnostics without mutating data."""
    working = _ensure_numeric(_copy(df), _ensure_columns(df, columns))
    result: dict[str, dict[str, Any]] = {}
    for column in columns:
        series = working[column]
        finite = series.dropna()
        if finite.empty or not np.isfinite(finite.to_numpy(dtype=float)).all():
            raise ValueError(f"Z-score detection requires finite numeric values for column: {column}")
        scale = float(finite.std(ddof=0))
        if scale == 0:
            raise ValueError(f"Cannot compute z-score for zero-variance column: {column}")
        # mask deliberately retains the original frame index; a dropna-sized mask would mislabel rows.
        mask = ((series - float(finite.mean())) / scale).abs() > threshold
        indices = working.index[mask.fillna(False)].tolist()
        result[column] = {"count": int(mask.fillna(False).sum()), "sample_indices": [int(index) for index in indices[:20]]}
    return result


def detect_iqr_outliers(
    df: pd.DataFrame,
    *,
    columns: Sequence[str],
    factor: float = 1.5,
) -> dict[str, dict[str, Any]]:
    """Return bounded, original-row-index IQR diagnostics without mutating data."""
    working = _ensure_numeric(_copy(df), _ensure_columns(df, columns))
    result: dict[str, dict[str, Any]] = {}
    for column in columns:
        series = working[column]
        finite = series.dropna()
        if finite.empty or not np.isfinite(finite.to_numpy(dtype=float)).all():
            raise ValueError(f"IQR detection requires finite numeric values for column: {column}")
        q1, q3 = float(finite.quantile(0.25)), float(finite.quantile(0.75))
        iqr = q3 - q1
        if iqr == 0:
            raise ValueError(f"Cannot compute IQR outliers for zero-variance column: {column}")
        lower, upper = q1 - factor * iqr, q3 + factor * iqr
        mask = (series < lower) | (series > upper)
        indices = working.index[mask.fillna(False)].tolist()
        result[column] = {
            "count": int(mask.fillna(False).sum()),
            "lower_bound": lower,
            "upper_bound": upper,
            "sample_indices": [int(index) for index in indices[:20]],
        }
    return result


def winsorize_columns(
    df: pd.DataFrame,
    *,
    columns: Sequence[str],
    lower: float = 0.01,
    upper: float = 0.01,
) -> tuple[pd.DataFrame, Summary]:
    working = _ensure_numeric(_copy(df), _ensure_columns(df, columns))
    for column in columns:
        # scipy 对含 NaN 的普通 ndarray 会把掩码压缩，若整体写回会错位到原行。
        # 只处理原本有数值的行，缺失位置与行顺序必须保持不变。
        valid = working[column].notna()
        numeric = working.loc[valid, column].to_numpy(dtype=float)
        working.loc[valid, column] = np.asarray(scipy_winsorize(numeric, limits=[lower, upper]), dtype=float)
    summary = _operation_summary(
        operation="winsorize_columns",
        rows_before=len(df),
        rows_after=len(working),
        columns_before=len(df.columns),
        columns_after=len(working.columns),
        affected_columns=columns,
        extra={"lower": lower, "upper": upper},
    )
    return working, summary


def winsorize(df: pd.DataFrame, *, columns: Sequence[str], lower: float = 0.01, upper: float = 0.01) -> tuple[pd.DataFrame, Summary]:
    return winsorize_columns(df, columns=columns, lower=lower, upper=upper)


def trim_columns(df: pd.DataFrame, *, columns: Sequence[str], lower: float, upper: float) -> tuple[pd.DataFrame, Summary]:
    """Remove observations outside any selected column's explicit two-sided quantile interval."""
    working = _ensure_numeric(_copy(df), _ensure_columns(df, columns))
    keep = pd.Series(True, index=working.index)
    for column in columns:
        finite = working[column].dropna()
        if finite.empty or not np.isfinite(finite.to_numpy(dtype=float)).all():
            raise ValueError(f"Trim requires finite numeric values for column: {column}")
        keep &= working[column].between(finite.quantile(lower), finite.quantile(1 - upper), inclusive="both")
    output = working.loc[keep.fillna(False)].copy()
    return output, _operation_summary(
        operation="trim_columns", rows_before=len(df), rows_after=len(output), columns_before=len(df.columns), columns_after=len(output.columns),
        affected_columns=columns, extra={"rows_dropped": int(len(df) - len(output)), "lower": lower, "upper": upper},
    )


def knn_impute_columns(df: pd.DataFrame, *, columns: Sequence[str], k: int) -> tuple[pd.DataFrame, Summary]:
    from sklearn.impute import KNNImputer
    working = _ensure_numeric(_copy(df), _ensure_columns(df, columns))
    if k < 1 or k > len(working):
        raise ValueError("KNN k must be between 1 and the number of rows")
    if any(working[column].dropna().empty for column in columns):
        raise ValueError("KNN cannot impute an all-missing column")
    before = {column: int(working[column].isna().sum()) for column in columns}
    working[list(columns)] = KNNImputer(n_neighbors=k).fit_transform(working[list(columns)])
    return working, _operation_summary(
        operation="knn_impute_columns", rows_before=len(df), rows_after=len(working), columns_before=len(df.columns), columns_after=len(working.columns),
        affected_columns=columns, extra={"k": k, "missing_before": before, "missing_after": {column: int(working[column].isna().sum()) for column in columns}},
    )


def scale_columns(df: pd.DataFrame, *, columns: Sequence[str], method: Literal["minmax", "robust"], suffix: str, feature_range: tuple[float, float] = (0.0, 1.0)) -> tuple[pd.DataFrame, Summary]:
    from sklearn.preprocessing import MinMaxScaler, RobustScaler
    working = _ensure_numeric(_copy(df), _ensure_columns(df, columns))
    if any(working[column].isna().any() or not np.isfinite(working[column].dropna().to_numpy(dtype=float)).all() for column in columns):
        raise ValueError("Scaling requires complete finite numeric columns")
    if any(f"{column}{suffix}" in working.columns for column in columns):
        raise ValueError("Scaled output column already exists")
    scaler = MinMaxScaler(feature_range=feature_range) if method == "minmax" else RobustScaler()
    values = scaler.fit_transform(working[list(columns)])
    created = []
    for index, column in enumerate(columns):
        target = f"{column}{suffix}"
        working[target] = values[:, index]
        created.append(target)
    return working, _operation_summary(operation=f"{method}_scale_columns", rows_before=len(df), rows_after=len(working), columns_before=len(df.columns), columns_after=len(working.columns), affected_columns=columns, created_columns=created)


def power_transform_columns(df: pd.DataFrame, *, columns: Sequence[str], method: Literal["boxcox", "yeojohnson"], suffix: str, shift: float = 0.0) -> tuple[pd.DataFrame, Summary]:
    working = _ensure_numeric(_copy(df), _ensure_columns(df, columns))
    if any(f"{column}{suffix}" in working.columns for column in columns):
        raise ValueError("Power-transform output column already exists")
    created: list[str] = []
    lambdas: dict[str, float] = {}
    for column in columns:
        values = working[column].dropna().to_numpy(dtype=float)
        if len(values) != len(working) or not np.isfinite(values).all():
            raise ValueError("Power transform requires complete finite numeric columns")
        target = f"{column}{suffix}"
        if method == "boxcox":
            shifted = values + shift
            if (shifted <= 0).any():
                raise ValueError(f"Box-Cox requires positive values after explicit shift: {column}")
            transformed, lam = scipy_stats.boxcox(shifted)
        else:
            transformed, lam = scipy_stats.yeojohnson(values)
        working[target] = transformed
        created.append(target)
        lambdas[column] = float(lam)
    return working, _operation_summary(operation=f"{method}_transform_columns", rows_before=len(df), rows_after=len(working), columns_before=len(df.columns), columns_after=len(working.columns), affected_columns=columns, created_columns=created, extra={"lambda": lambdas, "shift": shift if method == "boxcox" else None})


def safe_get_dummies(
    df: pd.DataFrame,
    *,
    columns: Sequence[str],
    drop_first: bool = True,
    dtype: str | type = "int64",
) -> tuple[pd.DataFrame, Summary]:
    working = _copy(df)
    target_columns = _ensure_columns(working, columns)
    created_columns: list[str] = []
    for column in target_columns:
        dummies = pd.get_dummies(working[column], prefix=column, drop_first=drop_first, dtype=dtype)
        created_columns.extend(dummies.columns.tolist())
        working = pd.concat([working, dummies], axis=1)
    summary = _operation_summary(
        operation="safe_get_dummies",
        rows_before=len(df),
        rows_after=len(working),
        columns_before=len(df.columns),
        columns_after=len(working.columns),
        affected_columns=target_columns,
        created_columns=created_columns,
        extra={"drop_first": drop_first},
    )
    return working, summary


def create_dummies(df: pd.DataFrame, *, columns: Sequence[str], drop_first: bool = True) -> tuple[pd.DataFrame, Summary]:
    return safe_get_dummies(df, columns=columns, drop_first=drop_first)


def create_ratio_features(
    df: pd.DataFrame,
    *,
    specs: Sequence[dict[str, str]],
) -> tuple[pd.DataFrame, Summary]:
    working = _ensure_numeric(_copy(df), [item["numerator"] for item in specs] + [item["denominator"] for item in specs])
    created_columns: list[str] = []
    for spec in specs:
        numerator = spec["numerator"]
        denominator = spec["denominator"]
        target = spec.get("name") or f"{numerator}_over_{denominator}"
        denom = working[denominator].replace({0: np.nan})
        working[target] = working[numerator] / denom
        created_columns.append(target)
    summary = _operation_summary(
        operation="create_ratio_features",
        rows_before=len(df),
        rows_after=len(working),
        columns_before=len(df.columns),
        columns_after=len(working.columns),
        affected_columns=[],
        created_columns=created_columns,
    )
    return working, summary


def create_interaction_features(
    df: pd.DataFrame,
    *,
    specs: Sequence[dict[str, str]],
) -> tuple[pd.DataFrame, Summary]:
    working = _ensure_numeric(_copy(df), [item["left"] for item in specs] + [item["right"] for item in specs])
    created_columns: list[str] = []
    for spec in specs:
        left = spec["left"]
        right = spec["right"]
        target = spec.get("name") or f"{left}_x_{right}"
        working[target] = working[left] * working[right]
        created_columns.append(target)
    summary = _operation_summary(
        operation="create_interaction_features",
        rows_before=len(df),
        rows_after=len(working),
        columns_before=len(df.columns),
        columns_after=len(working.columns),
        created_columns=created_columns,
    )
    return working, summary


def _shift_features(
    df: pd.DataFrame,
    *,
    specs: Sequence[dict[str, Any]],
    direction: Literal["lag", "lead"],
) -> tuple[pd.DataFrame, Summary]:
    working = _copy(df)
    created_columns: list[str] = []
    for spec in specs:
        column = spec["column"]
        periods = int(spec.get("periods", 1))
        group_by = list(spec.get("group_by") or [])
        time_var = spec.get("time_var")
        target = spec.get("name") or f"{column}_{direction}{periods}"

        if column not in working.columns:
            raise ValueError(f"Column not found: {column}")
        ordered = working
        if time_var:
            if time_var not in ordered.columns:
                raise ValueError(f"time_var not found: {time_var}")
            sort_columns = [*group_by, time_var] if group_by else [time_var]
            ordered = ordered.sort_values(sort_columns).copy()

        shift_periods = periods if direction == "lag" else -periods
        if group_by:
            ordered[target] = ordered.groupby(group_by, dropna=False)[column].shift(shift_periods)
        else:
            ordered[target] = ordered[column].shift(shift_periods)
        working = ordered
        created_columns.append(target)

    summary = _operation_summary(
        operation=f"create_{direction}_features",
        rows_before=len(df),
        rows_after=len(working),
        columns_before=len(df.columns),
        columns_after=len(working.columns),
        created_columns=created_columns,
    )
    return working, summary


def create_lag_features(df: pd.DataFrame, *, specs: Sequence[dict[str, Any]]) -> tuple[pd.DataFrame, Summary]:
    return _shift_features(df, specs=specs, direction="lag")


def create_lead_features(df: pd.DataFrame, *, specs: Sequence[dict[str, Any]]) -> tuple[pd.DataFrame, Summary]:
    return _shift_features(df, specs=specs, direction="lead")


def detect_outliers(
    df: pd.DataFrame,
    *,
    columns: Sequence[str] | None = None,
    method: OutlierMethod = "zscore",
    threshold: float = 3.5,
) -> tuple[pd.DataFrame, Summary]:
    target_columns = _ensure_columns(df, columns) if columns else df.select_dtypes(include=["number"]).columns.tolist()
    working = _ensure_numeric(_copy(df), target_columns)
    flagged_columns = []

    for column in target_columns:
        series = working[column].dropna()
        if series.empty:
            flagged_columns.append({"column": column, "flagged_rows": 0})
            continue
        if method == "iqr":
            q1 = float(series.quantile(0.25))
            q3 = float(series.quantile(0.75))
            iqr = q3 - q1
            lower_bound = q1 - threshold * iqr
            upper_bound = q3 + threshold * iqr
            flagged = working[column].between(lower_bound, upper_bound, inclusive="both") == False
        else:
            raw_std = series.std()
            # 单行或全缺失后只剩一条观测时，pandas nullable dtype 会给出 pd.NA。
            # 这不代表导入失败，只是该列没有可定义的离群值尺度。
            if pd.isna(raw_std):
                flagged = pd.Series(False, index=working.index)
            else:
                std = float(raw_std)
                if std == 0 or np.isnan(std):
                    flagged = pd.Series(False, index=working.index)
                else:
                    z_scores = ((working[column] - float(series.mean())) / std).abs()
                    flagged = z_scores > threshold
        flagged_columns.append(
            {
                "column": column,
                "flagged_rows": int(flagged.fillna(False).sum()),
            }
        )

    summary = {
        "operation": "detect_outliers",
        "method": method,
        "threshold": threshold,
        "flagged_columns": flagged_columns,
    }
    return _copy(df), _json_safe(summary)


def describe_dataset(
    df: pd.DataFrame,
    *,
    columns: Sequence[str] | None = None,
) -> tuple[pd.DataFrame, Summary]:
    target_columns = _ensure_columns(df, columns) if columns else list(df.columns)
    summary_frame = df[target_columns].describe(include="all").transpose().reset_index().rename(columns={"index": "variable"})
    summary_frame["dtype"] = summary_frame["variable"].map(lambda column: str(df[column].dtype))
    summary_frame["missing_count"] = summary_frame["variable"].map(lambda column: int(df[column].isna().sum()))
    summary_frame["missing_share"] = summary_frame["variable"].map(lambda column: round(float(df[column].isna().mean()), 6))
    summary = {
        "operation": "describe_dataset",
        "variables": target_columns,
        "row_count": int(len(df)),
        "column_count": int(len(target_columns)),
    }
    return summary_frame, _json_safe(summary)


def correlation_matrix(
    df: pd.DataFrame,
    *,
    columns: Sequence[str] | None = None,
    method: Literal["pearson", "spearman", "kendall"] = "pearson",
) -> tuple[pd.DataFrame, Summary]:
    target_columns = _ensure_columns(df, columns) if columns else df.select_dtypes(include=["number"]).columns.tolist()
    numeric = _ensure_numeric(df[target_columns], target_columns)
    corr = numeric.corr(method=method)
    summary = {
        "operation": "correlation_matrix",
        "method": method,
        "variables": target_columns,
    }
    return corr, _json_safe(summary)


def panel_balance_check(
    df: pd.DataFrame,
    *,
    entity_var: str,
    time_var: str,
) -> tuple[pd.DataFrame, Summary]:
    if entity_var not in df.columns or time_var not in df.columns:
        missing = [column for column in [entity_var, time_var] if column not in df.columns]
        raise ValueError(f"Panel identifiers not found: {missing}")

    coverage = (
        df.groupby(entity_var)[time_var]
        .nunique(dropna=True)
        .reset_index(name="observed_periods")
        .sort_values("observed_periods", ascending=False)
    )
    all_periods = int(df[time_var].nunique(dropna=True))
    coverage["missing_periods"] = all_periods - coverage["observed_periods"]
    is_balanced = bool((coverage["observed_periods"] == all_periods).all())
    summary = {
        "operation": "panel_balance_check",
        "entity_var": entity_var,
        "time_var": time_var,
        "entity_count": int(df[entity_var].nunique(dropna=True)),
        "time_count": all_periods,
        "is_balanced": is_balanced,
        "min_periods_per_entity": int(coverage["observed_periods"].min()) if not coverage.empty else 0,
        "max_periods_per_entity": int(coverage["observed_periods"].max()) if not coverage.empty else 0,
    }
    return coverage, _json_safe(summary)


def create_relative_time(
    df: pd.DataFrame,
    *,
    entity_var: str,
    time_var: str,
    cohort_var: str,
    treatment_var: str,
    output_column: str,
) -> tuple[pd.DataFrame, Summary]:
    """Create DID2S event time after explicit design confirmation, using -inf for untreated units."""
    columns = (entity_var, time_var, cohort_var, treatment_var)
    missing_columns = [column for column in columns if column not in df.columns]
    if missing_columns:
        raise ValueError(f"相对时期构造缺少真实列：{'、'.join(missing_columns)}")
    if output_column in df.columns:
        raise ValueError(f"relative-time 输出列已存在：{output_column}；拒绝覆盖已有数据")
    if df.empty:
        raise ValueError("相对时期构造没有可用观测")

    entity = df[entity_var]
    if entity.isna().any() or (pd.api.types.is_string_dtype(entity) and entity.str.strip().eq("").any()):
        raise ValueError(f"分析单位列 {entity_var} 含缺失或空标识")

    time = pd.to_numeric(df[time_var], errors="coerce")
    if time.isna().any() or not np.isfinite(time.to_numpy(dtype=float)).all():
        raise ValueError(f"时期列 {time_var} 必须是完整、有限的数值列")
    raw_cohort = df[cohort_var]
    cohort = pd.to_numeric(raw_cohort, errors="coerce")
    invalid_cohort = raw_cohort.notna() & cohort.isna()
    if invalid_cohort.any() or not np.isfinite(cohort.dropna().to_numpy(dtype=float)).all():
        raise ValueError(f"首次处理时期列 {cohort_var} 必须是数值或缺失的 cohort 列")
    treatment = pd.to_numeric(df[treatment_var], errors="coerce")
    if treatment.isna().any() or not np.isfinite(treatment.to_numpy(dtype=float)).all() or not set(treatment.unique()).issubset({0, 1}):
        raise ValueError(f"处理标志列 {treatment_var} 必须是无缺失的 0/1 数值列")

    panel = pd.DataFrame({
        "unit": entity.to_numpy(),
        "period": time.to_numpy(dtype=float),
        "cohort": cohort.to_numpy(dtype=float),
        "treatment": treatment.to_numpy(dtype=int),
    })
    if panel.duplicated(subset=["unit", "period"]).any():
        raise ValueError(f"{entity_var}×{time_var} 存在重复键；拒绝生成相对时期")
    cohort_counts = panel.groupby("unit", dropna=False)["cohort"].nunique(dropna=False)
    if cohort_counts.gt(1).any():
        raise ValueError(f"首次处理时期列 {cohort_var} 在同一分析单位内不恒定")

    expected_treatment = (cohort.notna() & time.ge(cohort)).astype(int)
    if not treatment.astype(int).eq(expected_treatment).all():
        raise ValueError(f"处理标志列 {treatment_var} 与首次处理时期 {cohort_var} 和时期 {time_var} 不一致")
    observed_treatment = panel.groupby("unit", dropna=False)["treatment"].transform("max").astype(bool)
    cohort_present = cohort.groupby(entity, dropna=False).transform(lambda values: values.notna().all())
    if not observed_treatment.eq(cohort_present).all():
        raise ValueError(f"处理标志列 {treatment_var} 未观察到 cohort {cohort_var} 指定的处理时点")

    time_float = pd.Series(time, index=df.index, dtype="float64")
    cohort_float = pd.Series(cohort, index=df.index, dtype="float64")
    relative_time = (time_float - cohort_float).where(cohort_float.notna(), -np.inf)
    output = df.copy(deep=True)
    output[output_column] = relative_time.astype(float)
    summary = _operation_summary(
        operation="create_relative_time",
        rows_before=len(df),
        rows_after=len(output),
        columns_before=len(df.columns),
        columns_after=len(output.columns),
        affected_columns=columns,
        created_columns=[output_column],
    )
    return output, summary


# ---------------------------------------------------------------------------
# 数据就绪事实（data readiness）
#
# 这份实现此前内嵌在 `tool/data-import/index.ts` 的 Python 模板字符串里，只有
# data_import 能用。data_preprocess 创建新 stage（如 combine_columns 生成复合
# 实体键）后没有任何 readiness 写入点，导致面板门禁永远拿不到新键的唯一性证据，
# 模型无论重跑多少次 profile/validate 都推不动（2026-08-28 did.xlsx 真实会话）。
#
# 搬到共享核心模块后由两个 runner 共用同一份实现，不复制第二份避免语义漂移。
# ---------------------------------------------------------------------------

def build_data_readiness(df):
    """上传后一次性生成结构事实；不改数据，不替用户决定研究规格。"""
    import itertools
    import re
    from datetime import datetime, timezone

    columns = []
    numeric_columns = []
    entity_candidates = []
    time_candidates = []
    row_count = int(len(df))
    usable_observation_count = int(df.dropna(how="all").shape[0])

    for name in df.columns:
        series = df[name]
        values = series.dropna()
        is_numeric = bool(pd.api.types.is_numeric_dtype(series))
        is_datetime = bool(pd.api.types.is_datetime64_any_dtype(series))
        unique_count = int(series.nunique(dropna=True))
        binary = False
        integer_like = False
        nonnegative = None
        if is_numeric and len(values) > 0:
            numeric_values = pd.to_numeric(values, errors="coerce").to_numpy(dtype=float)
            finite = numeric_values[np.isfinite(numeric_values)]
            binary = bool(len(finite) > 0 and set(np.unique(finite).tolist()).issubset({0.0, 1.0}))
            integer_like = bool(len(finite) > 0 and np.all(np.isclose(finite, np.round(finite))))
            nonnegative = bool(len(finite) > 0 and np.all(finite >= 0))
            if unique_count > 1:
                numeric_columns.append(str(name))
        column_type = "numeric" if is_numeric else "datetime" if is_datetime else "categorical" if (
            pd.api.types.is_object_dtype(series) or pd.api.types.is_string_dtype(series) or pd.api.types.is_categorical_dtype(series)
        ) else "other"
        columns.append({
            "name": str(name),
            "type": column_type,
            "missingCount": int(series.isna().sum()),
            "uniqueCount": unique_count,
            "constant": bool(unique_count <= 1),
            "binary": binary,
            "integerLike": integer_like,
            "nonnegative": nonnegative,
        })

        normalized = str(name).strip().lower()
        if unique_count > 1 and unique_count < row_count and not re.search(r"year|time|date|period|年份|年份|时间|日期|时期", normalized):
            if column_type in {"categorical", "numeric"} and re.search(r"id|code|province|city|county|region|district|state|省|市|区|县|地区|实体|个体|复合|企业|公司|编号|代码", normalized):
                entity_candidates.append(str(name))
        if unique_count > 1 and re.search(r"^t$|year|time|date|month|quarter|period|年份|时间|日期|时期|季度|月份", normalized):
            time_candidates.append(str(name))

    # 名称线索只是候选，不是识别结论。优先使用有明确时间列的组合，最多保留12项。
    panel_candidates = []
    for time_name in time_candidates[:4]:
        for entity_name in entity_candidates[:8]:
            duplicate_rows = int(df.duplicated(subset=[entity_name, time_name]).sum())
            entity_missing_count = int(df[entity_name].isna().sum())
            time_missing_count = int(df[time_name].isna().sum())
            panel_candidates.append({
                "entityVars": [entity_name],
                "timeVar": time_name,
                "duplicateRows": duplicate_rows,
                "entityCount": int(df[entity_name].nunique(dropna=True)),
                "timeCount": int(df[time_name].nunique(dropna=True)),
                "unique": duplicate_rows == 0 and entity_missing_count == 0 and time_missing_count == 0,
                "suggestedAction": (
                    "use_as_is" if duplicate_rows == 0 and entity_missing_count == 0 and time_missing_count == 0
                    else "resolve_missing" if entity_missing_count > 0 or time_missing_count > 0
                    else "aggregate"
                ),
                "entityMissingCount": entity_missing_count,
                "timeMissingCount": time_missing_count,
            })
        if len(panel_candidates) >= 12:
            break
    # 复合实体键搜索与上面的单实体列搜索相互独立，必须写成外层循环的兄弟节点，
    # 只跑一次。此前它被误缩进在 `for time_name in time_candidates[:4]:` 内部，
    # 于是对每个外层 time_name（此处的 time_name 已被内层同名循环变量遮蔽、
    # 从未被用到）都完整重跑一遍相同的复合键搜索，产生 len(time_candidates) 份
    # 一模一样的重复候选，挤占 12 条候选上限里本可以呈现给模型的其他真实组合。
    for left, right in itertools.combinations(entity_candidates[:8], 2):
        for time_name in time_candidates[:4]:
            combined = df[[left, right, time_name]].copy()
            duplicate_rows = int(combined.duplicated(subset=[left, right, time_name]).sum())
            entity_missing_count = int(combined[[left, right]].isna().any(axis=1).sum())
            time_missing_count = int(combined[time_name].isna().sum())
            if duplicate_rows == 0:
                panel_candidates.append({
                    "entityVars": [left, right],
                    "timeVar": time_name,
                    "duplicateRows": 0,
                    "entityCount": int(combined[[left, right]].drop_duplicates().shape[0]),
                    "timeCount": int(combined[time_name].nunique(dropna=True)),
                    "unique": entity_missing_count == 0 and time_missing_count == 0,
                    "suggestedAction": (
                        "combine_columns"
                        if entity_missing_count == 0 and time_missing_count == 0
                        else "resolve_missing"
                    ),
                    "entityMissingCount": entity_missing_count,
                    "timeMissingCount": time_missing_count,
                })
                # 已找到能消除重复的时间列，这一对实体组合不用再试其余候选；
                # 但若当前时间列没能消除重复，必须继续试下一个候选（此前 break 写在
                # if 外，无条件只试 time_candidates[0]，后面的候选永远碰不到，
                # readiness 会漏报本可行的 combine_columns 修复方案）。
                break
        if len(panel_candidates) >= 12:
            break

    exact_dependencies = []
    if len(numeric_columns) >= 2:
        numeric_frame = df[numeric_columns].apply(pd.to_numeric, errors="coerce").dropna()
        if len(numeric_frame) > len(numeric_columns):
            matrix = numeric_frame.to_numpy(dtype=float)
            if np.isfinite(matrix).all():
                singular_values = np.linalg.svd(matrix, compute_uv=False)
                rank = int(np.linalg.matrix_rank(matrix))
                tolerance = max(matrix.shape) * np.finfo(float).eps * max(float(singular_values[0]), 1.0) * 100
                null_count = len(numeric_columns) - rank
                if null_count > 0:
                    _, singular, vh = np.linalg.svd(matrix, full_matrices=False)
                    for offset in range(1, min(null_count, 4) + 1):
                        if float(singular[-offset]) > tolerance:
                            continue
                        vector = vh[-offset]
                        scale = float(np.max(np.abs(vector)))
                        if scale <= 0:
                            continue
                        vector = vector / scale
                        support = [index for index, value in enumerate(vector) if abs(float(value)) > 1e-6]
                        if len(support) < 2:
                            continue
                        pivot_index = support[0]
                        pivot = float(vector[pivot_index])
                        terms = []
                        for index in support[1:]:
                            coefficient = -float(vector[index]) / pivot
                            if abs(coefficient) < 1e-6:
                                continue
                            magnitude = "" if abs(abs(coefficient) - 1.0) < 1e-6 else f"{abs(coefficient):.6g}×"
                            sign = "+" if coefficient > 0 else "-"
                            terms.append((sign, f"{magnitude}{numeric_columns[index]}"))
                        if not terms:
                            continue
                        relation = f"{numeric_columns[pivot_index]} = "
                        relation += " ".join(
                            (term if index == 0 and sign == "+" else f"{sign} {term}")
                            for index, (sign, term) in enumerate(terms)
                        )
                        exact_dependencies.append({
                            "columns": [numeric_columns[index] for index in support],
                            "relation": relation,
                            "rank": rank,
                            "designColumns": len(numeric_columns),
                        })

    structural_columns = set(entity_candidates + time_candidates)
    varying_numeric = [item for item in columns if item["type"] == "numeric" and not item["constant"]]
    binary_columns = [item for item in varying_numeric if item["binary"]]
    nonnegative_outcomes = [
        item for item in varying_numeric
        if item["name"] not in structural_columns and item["nonnegative"] and not item["binary"]
    ]
    count_columns = [item for item in nonnegative_outcomes if item["integerLike"]]
    candidate_methods = []
    if len(varying_numeric) >= 2:
        for method_name, reason in [
            ("ols_regression", "存在至少两个有变化的数值列"),
            ("quantile_regression", "存在有变化的连续数值列，可比较条件分布效应"),
            ("robust_regression", "存在有变化的连续数值列，可做异常值敏感性分析"),
        ]:
            candidate_methods.append({"methodID": method_name, "status": "candidate", "reason": reason, "repairSuggestions": []})
    if any(item["unique"] for item in panel_candidates):
        candidate_methods.append({"methodID": "panel_fe_regression", "status": "candidate", "reason": "存在唯一的个体×时间键候选", "repairSuggestions": []})
        candidate_methods.append({"methodID": "panel_random_effects", "status": "candidate", "reason": "存在唯一的个体×时间键候选", "repairSuggestions": []})
    if binary_columns:
        candidate_methods.extend({"methodID": method_name, "status": "candidate", "reason": "存在0/1二元数值列", "repairSuggestions": []} for method_name in ["logit_regression", "probit_regression"])
    if nonnegative_outcomes:
        candidate_methods.append({
            "methodID": "poisson_regression",
            "status": "candidate",
            "reason": "存在非负数值结果候选；Poisson 也可按 PPML 处理连续非负结果，具体因变量仍须用户指定",
            "repairSuggestions": [],
        })
    if count_columns:
        candidate_methods.append({
            "methodID": "negbin_regression",
            "status": "needs_roles",
            "reason": "存在非负整数列；需用户确认它是计数结果，并结合过度离散判断是否用负二项回归",
            "repairSuggestions": ["确认因变量确为计数，且研究设计需要负二项回归"],
        })
    for method_name in ["did_static", "did2s", "did_event_study_saturated", "psm_matching", "psm_ipw", "psm_regression", "psm_double_robust", "iv_2sls", "rdd_sharp", "rdd_fuzzy"]:
        candidate_methods.append({"methodID": method_name, "status": "needs_roles", "reason": "需要用户确认研究设计与识别变量", "repairSuggestions": ["先确认方法所需的处理、时间、工具变量或断点变量"]})

    warnings = [f"检测到完全线性依赖：{item['relation']}" for item in exact_dependencies]
    return {
        "version": 1,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "rowCount": row_count,
        "columnCount": int(len(df.columns)),
        "usableObservationCount": usable_observation_count,
        "columns": columns,
        "panelCandidates": panel_candidates[:12],
        "exactLinearDependencies": exact_dependencies[:4],
        "candidateMethods": candidate_methods,
        "warnings": warnings,
    }


__all__ = [
    "get_column_info",
    "coerce_dataframe_types",
    "profile_dataframe",
    "build_quality_report",
    "drop_missing_rows",
    "fill_missing_values",
    "fill_missing_constant",
    "fill_missing_statistics",
    "forward_backward_fill",
    "linear_interpolate",
    "interpolate_by_group",
    "group_linear_interpolate",
    "regression_impute",
    "log_transform_columns",
    "log_transform",
    "standardize_columns",
    "standardize",
    "winsorize_columns",
    "winsorize",
    "safe_get_dummies",
    "create_dummies",
    "create_ratio_features",
    "create_interaction_features",
    "create_lag_features",
    "create_lead_features",
    "detect_outliers",
    "describe_dataset",
    "correlation_matrix",
    "panel_balance_check",
    "create_relative_time",
    "build_data_readiness",
]
