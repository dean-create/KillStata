from __future__ import annotations

from dataclasses import dataclass
import json
from typing import Any, Iterable, Literal, Sequence

import numpy as np
import pandas as pd
from scipy.stats.mstats import winsorize as scipy_winsorize


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

    missing_share = {
        column: round(float(df[column].isna().mean()), 6)
        for column in df.columns
        if float(df[column].isna().mean()) > 0
    }
    high_missing = [column for column, share in missing_share.items() if share >= 0.2]
    if high_missing:
        warnings.append(f"Columns with >=20% missing values: {high_missing}")
        suggested_repairs.append("Impute or drop high-missing columns before estimation")

    duplicate_rows = 0
    panel_balance = None
    if entity_var and time_var:
        missing_keys = [column for column in [entity_var, time_var] if column not in df.columns]
        if missing_keys:
            blocking_errors.append(f"Panel identifiers not found: {missing_keys}")
        else:
            duplicate_rows = int(df.duplicated(subset=[entity_var, time_var]).sum())
            if duplicate_rows > 0:
                blocking_errors.append(f"Found {duplicate_rows} duplicate entity-time rows")
                suggested_repairs.append("Deduplicate panel keys before regression")
            _, panel_balance = panel_balance_check(df, entity_var=entity_var, time_var=time_var)
            if panel_balance["is_balanced"] is False:
                warnings.append("Panel is unbalanced")

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
        warnings.append(f"Potential outliers detected in: {flagged_outlier_columns}")

    status = "pass"
    if warnings:
        status = "warn"
    if blocking_errors:
        status = "fail"

    report = {
        "operation": "build_quality_report",
        "status": status,
        "warnings": warnings,
        "blocking_errors": blocking_errors,
        "suggested_repairs": suggested_repairs,
        "row_count": int(len(df)),
        "column_count": int(len(df.columns)),
        "numeric_columns": numeric_columns,
        "missing_share": missing_share,
        "duplicate_entity_time_rows": duplicate_rows,
        "panel_balance": panel_balance,
        "outliers": outlier_summary,
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
) -> tuple[pd.DataFrame, Summary]:
    working = _copy(df)
    target_columns = _ensure_columns(working, columns)
    missing_before = {column: int(working[column].isna().sum()) for column in target_columns}

    for column in target_columns:
        if strategy == "mean":
            fill_value = pd.to_numeric(working[column], errors="coerce").mean()
        elif strategy == "median":
            fill_value = pd.to_numeric(working[column], errors="coerce").median()
        elif strategy == "mode":
            mode = working[column].mode(dropna=True)
            fill_value = mode.iloc[0] if not mode.empty else value
        elif strategy == "forward":
            working[column] = working[column].ffill()
            continue
        elif strategy == "backward":
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
) -> tuple[pd.DataFrame, Summary]:
    strategy: FillStrategy = "forward" if direction == "forward" else "backward"
    return fill_missing_values(df, columns=columns, strategy=strategy)


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
) -> tuple[pd.DataFrame, Summary]:
    working = _ensure_numeric(_copy(df), _ensure_columns(df, columns))
    created_columns: list[str] = []
    for column in columns:
        target = f"{prefix}{column}"
        working[target] = np.log(working[column] + offset)
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
        std = float(working[column].std())
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


def winsorize_columns(
    df: pd.DataFrame,
    *,
    columns: Sequence[str],
    lower: float = 0.01,
    upper: float = 0.01,
) -> tuple[pd.DataFrame, Summary]:
    working = _ensure_numeric(_copy(df), _ensure_columns(df, columns))
    for column in columns:
        numeric = working[column].to_numpy(dtype=float)
        working[column] = np.asarray(scipy_winsorize(numeric, limits=[lower, upper]), dtype=float)
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
            std = float(series.std())
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
]
