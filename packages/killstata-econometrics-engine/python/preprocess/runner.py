#!/usr/bin/env python3
"""数据预处理受管进程入口。

stdin/stdout 是唯一协议边界：输入一条 JSON，输出一条 JSON。算法核心放在
``python/econometrics/data_preprocess.py``，本文件只负责严格参数校验、方法分派、
文件 I/O 和面向 Harness 的小型结构化结果。
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

CORE_DIR = Path(os.environ.get("KILLSTATA_PREPROCESS_CORE_DIR", Path(__file__).resolve().parents[1] / "econometrics"))
sys.path.insert(0, str(CORE_DIR))
from data_preprocess import (  # noqa: E402
    _operation_summary,
    detect_iqr_outliers,
    detect_zscore_outliers,
    drop_missing_rows,
    fill_missing_constant,
    fill_missing_statistics,
    forward_backward_fill,
    knn_impute_columns,
    linear_interpolate as data_preprocess_linear_interpolate,
    group_linear_interpolate,
    create_relative_time as data_preprocess_create_relative_time,
    log_transform_columns,
    power_transform_columns,
    regression_impute,
    safe_get_dummies,
    scale_columns,
    standardize_columns,
    trim_columns,
    winsorize_columns,
)
from data_preprocess import build_data_readiness  # noqa: E402


MUTATING_METHODS = {
    "listwise_deletion",
    "mean_impute",
    "median_impute",
    "knn_impute",
    "winsorize",
    "trim",
    "zscore_standardize",
    "minmax_scale",
    "robust_scale",
    "log_transform",
    "boxcox_transform",
    "yeojohnson_transform",
    # 从 data_import preprocess action 迁入
    "fill_constant",
    "forward_fill",
    "backward_fill",
    "linear_interpolate",
    "group_linear_interpolate",
    "regression_impute",
    "create_dummies",
    "combine_columns",
    "filter",
    "create_column",
    "create_relative_time",
    "coerce_numeric",
}
DETECTION_METHODS = {"zscore_detect", "iqr_detect"}
METHODS = MUTATING_METHODS | DETECTION_METHODS


class PreprocessError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def fail(code: str, message: str) -> None:
    print(json.dumps({"success": False, "error_code": code, "error": message}, ensure_ascii=False, allow_nan=False))


def read_payload() -> dict[str, Any]:
    raw = sys.stdin.read()
    if not raw.strip():
        raise PreprocessError("INVALID_JSON", "No input received on stdin")
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise PreprocessError("INVALID_JSON", f"Invalid JSON input: {exc.msg}") from exc
    if not isinstance(payload, dict):
        raise PreprocessError("INVALID_JSON", "Input payload must be an object")
    return payload


def read_table(path_text: str) -> pd.DataFrame:
    path = Path(path_text)
    if not path.is_file():
        raise PreprocessError("INPUT_NOT_FOUND", "Input data file does not exist")
    suffix = path.suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(path)
    if suffix in {".xlsx", ".xls"}:
        return pd.read_excel(path)
    if suffix == ".parquet":
        return pd.read_parquet(path)
    if suffix == ".dta":
        return pd.read_stata(path)
    raise PreprocessError("UNSUPPORTED_FORMAT", f"Unsupported input format: {suffix or 'unknown'}")


def write_table(frame: pd.DataFrame, path_text: str) -> None:
    path = Path(path_text)
    if path.suffix.lower() != ".parquet":
        raise PreprocessError("INVALID_OUTPUT_PATH", "Preprocess output must use the parquet format")
    path.parent.mkdir(parents=True, exist_ok=True)
    frame.to_parquet(path, index=False)


def require_columns(frame: pd.DataFrame, columns: Any) -> list[str]:
    if not isinstance(columns, list) or not columns or not all(isinstance(column, str) and column.strip() for column in columns):
        raise PreprocessError("INVALID_COLUMNS", "columns must be a non-empty array of column names")
    if len(set(columns)) != len(columns):
        raise PreprocessError("INVALID_COLUMNS", "columns must not contain duplicates")
    missing = [column for column in columns if column not in frame.columns]
    if missing:
        raise PreprocessError("COLUMN_NOT_FOUND", f"Columns not found: {', '.join(missing)}")
    return columns


def numeric_series(frame: pd.DataFrame, column: str, *, allow_missing: bool = True) -> pd.Series:
    series = pd.to_numeric(frame[column], errors="coerce")
    finite = series.dropna()
    if finite.empty:
        raise PreprocessError("ALL_MISSING", f"Column {column} has no finite numeric values")
    if not np.isfinite(finite.to_numpy(dtype=float)).all():
        raise PreprocessError("NON_FINITE_VALUE", f"Column {column} contains infinity")
    if not allow_missing and series.isna().any():
        raise PreprocessError("MISSING_VALUE", f"Column {column} contains missing values")
    return series


def options_object(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise PreprocessError("INVALID_OPTIONS", "options must be an object")
    return value


def only_options(options: dict[str, Any], allowed: set[str]) -> None:
    extra = sorted(set(options) - allowed)
    if extra:
        raise PreprocessError("INVALID_OPTIONS", f"Unsupported options: {', '.join(extra)}")


def coerce_filter_value(series: pd.Series, value: Any) -> Any:
    """让模型传入的数字字符串能够与真实数值列进行等值比较。"""
    if pd.api.types.is_bool_dtype(series) or not pd.api.types.is_numeric_dtype(series) or not isinstance(value, str):
        return value
    parsed = pd.to_numeric(value.strip(), errors="coerce")
    return value if pd.isna(parsed) else parsed.item()


def fraction(options: dict[str, Any], name: str, default: float) -> float:
    value = options.get(name, default)
    if not isinstance(value, (int, float)) or isinstance(value, bool) or not np.isfinite(value) or value < 0 or value >= 1:
        raise PreprocessError("INVALID_OPTIONS", f"{name} must be a finite fraction in [0, 1)")
    return float(value)


def suffix(options: dict[str, Any], default: str) -> str:
    value = options.get("suffix", default)
    if not isinstance(value, str) or not value or len(value) > 32:
        raise PreprocessError("INVALID_OPTIONS", "suffix must be a non-empty string with at most 32 characters")
    return value


def ensure_new_columns(frame: pd.DataFrame, columns: list[str], name_suffix: str) -> None:
    collisions = [f"{column}{name_suffix}" for column in columns if f"{column}{name_suffix}" in frame.columns]
    if collisions:
        raise PreprocessError("COLUMN_COLLISION", f"Output columns already exist: {', '.join(collisions)}")


def count_changed_cells(before: pd.DataFrame, after: pd.DataFrame, columns: list[str]) -> int:
    changed = 0
    for column in columns:
        if column not in before.columns or column not in after.columns:
            continue
        left = before[column]
        right = after[column]
        unequal = ~(left.eq(right) | (left.isna() & right.isna()))
        changed += int(unequal.sum())
    return changed


def dispatch(method: str, frame: pd.DataFrame, columns: list[str], options: dict[str, Any]) -> tuple[pd.DataFrame | None, dict[str, Any], bool]:
    if method == "listwise_deletion":
        only_options(options, set())
        output, summary = drop_missing_rows(frame, columns=columns)
        return output, summary, True

    if method == "coerce_numeric":
        only_options(options, {"missing_tokens"})
        raw_tokens = options.get("missing_tokens", [])
        if not isinstance(raw_tokens, list) or any(not isinstance(token, str) for token in raw_tokens):
            raise PreprocessError("INVALID_OPTIONS", "missing_tokens 必须是字符串数组")
        missing_tokens = [token.strip() for token in raw_tokens]
        if any(not token for token in missing_tokens) or len(set(missing_tokens)) != len(missing_tokens):
            raise PreprocessError("INVALID_OPTIONS", "missing_tokens 不能包含空白或重复标记")

        output = frame.copy()
        converted_numeric: list[str] = []
        missing_tokens_converted: dict[str, int] = {}
        for column in columns:
            source = frame[column]
            if pd.api.types.is_numeric_dtype(source) and not pd.api.types.is_bool_dtype(source):
                missing_tokens_converted[column] = 0
                continue
            text = source.astype("string").str.strip()
            explicit_missing = text.isin(missing_tokens)
            blank_missing = text.isna() | text.eq("")
            missing = explicit_missing | blank_missing
            numeric = pd.to_numeric(text.mask(missing), errors="coerce")
            invalid = ~missing & numeric.isna()
            if invalid.any():
                examples = [str(value)[:40] for value in text.loc[invalid].drop_duplicates().head(5).tolist()]
                raise PreprocessError(
                    "INVALID_NUMERIC_VALUE",
                    f"列“{column}”含未声明且无法解析的非缺失文本：{examples}。请核对 missing_tokens；未创建新阶段。",
                )
            finite = numeric.dropna()
            if finite.empty:
                raise PreprocessError("ALL_MISSING", f"列“{column}”转换后没有可用数值；未创建新阶段")
            if not np.isfinite(finite.to_numpy(dtype=float)).all():
                raise PreprocessError("NON_FINITE_VALUE", f"列“{column}”转换后含非有限数值；未创建新阶段")
            output[column] = numeric
            converted_numeric.append(column)
            missing_tokens_converted[column] = int(explicit_missing.sum())

        if not converted_numeric:
            raise PreprocessError("ALREADY_NUMERIC", "所选列已经是数值型；没有必要创建新的数据阶段")
        summary = _operation_summary(
            operation=method,
            rows_before=len(frame),
            rows_after=len(output),
            columns_before=len(frame.columns),
            columns_after=len(output.columns),
            affected_columns=converted_numeric,
            extra={
                "converted_numeric": converted_numeric,
                "missing_tokens_applied": missing_tokens,
                "missing_tokens_converted": missing_tokens_converted,
                "rows_retained": len(output),
            },
        )
        return output, summary, True

    if method in {"mean_impute", "median_impute"}:
        only_options(options, set())
        strategy = "mean" if method == "mean_impute" else "median"
        output, summary = fill_missing_statistics(frame, columns=columns, strategy=strategy)
        return output, summary, True

    if method == "knn_impute":
        only_options(options, {"k"})
        k = options.get("k", 5)
        if not isinstance(k, int) or isinstance(k, bool) or k < 1:
            raise PreprocessError("INVALID_OPTIONS", "k must be a positive integer")
        for column in columns:
            numeric_series(frame, column)
        if k > len(frame):
            raise PreprocessError("INVALID_OPTIONS", "k cannot exceed the number of rows")
        try:
            output, summary = knn_impute_columns(frame, columns=columns, k=k)
        except ValueError as exc:
            raise PreprocessError("INVALID_INPUT", str(exc)) from exc
        return output, summary, True

    if method == "zscore_detect":
        only_options(options, {"threshold"})
        threshold = options.get("threshold", 3.0)
        if not isinstance(threshold, (int, float)) or isinstance(threshold, bool) or not np.isfinite(threshold) or threshold <= 0:
            raise PreprocessError("INVALID_OPTIONS", "threshold must be a positive finite number")
        try:
            return None, {"detected": detect_zscore_outliers(frame, columns=columns, threshold=float(threshold))}, False
        except ValueError as exc:
            raise PreprocessError("ZERO_VARIANCE", str(exc)) from exc

    if method == "iqr_detect":
        only_options(options, {"factor"})
        factor = options.get("factor", 1.5)
        if not isinstance(factor, (int, float)) or isinstance(factor, bool) or not np.isfinite(factor) or factor <= 0:
            raise PreprocessError("INVALID_OPTIONS", "factor must be a positive finite number")
        try:
            return None, {"detected": detect_iqr_outliers(frame, columns=columns, factor=float(factor))}, False
        except ValueError as exc:
            raise PreprocessError("ZERO_VARIANCE", str(exc)) from exc

    if method == "winsorize":
        only_options(options, {"lower", "upper"})
        lower, upper = fraction(options, "lower", 0.01), fraction(options, "upper", 0.01)
        if lower + upper >= 1:
            raise PreprocessError("INVALID_OPTIONS", "lower + upper must be smaller than 1")
        for column in columns:
            numeric_series(frame, column)
        output, summary = winsorize_columns(frame, columns=columns, lower=lower, upper=upper)
        return output, summary, True

    if method == "trim":
        only_options(options, {"lower", "upper"})
        lower, upper = fraction(options, "lower", 0.01), fraction(options, "upper", 0.01)
        if lower + upper >= 1:
            raise PreprocessError("INVALID_OPTIONS", "lower + upper must be smaller than 1")
        try:
            output, summary = trim_columns(frame, columns=columns, lower=lower, upper=upper)
        except ValueError as exc:
            raise PreprocessError("INVALID_INPUT", str(exc)) from exc
        return output, summary, True

    if method == "zscore_standardize":
        only_options(options, {"suffix"})
        name_suffix = suffix(options, "_z")
        ensure_new_columns(frame, columns, name_suffix)
        output, summary = standardize_columns(frame, columns=columns, suffix=name_suffix)
        return output, summary, True

    if method == "minmax_scale":
        only_options(options, {"suffix", "feature_range"})
        name_suffix = suffix(options, "_mm")
        ensure_new_columns(frame, columns, name_suffix)
        feature_range = options.get("feature_range", [0.0, 1.0])
        if (
            not isinstance(feature_range, list)
            or len(feature_range) != 2
            or not all(isinstance(value, (int, float)) and not isinstance(value, bool) and np.isfinite(value) for value in feature_range)
            or feature_range[0] >= feature_range[1]
        ):
            raise PreprocessError("INVALID_OPTIONS", "feature_range must contain two finite ascending values")
        try:
            output, summary = scale_columns(frame, columns=columns, method="minmax", suffix=name_suffix, feature_range=(float(feature_range[0]), float(feature_range[1])))
        except ValueError as exc:
            raise PreprocessError("INVALID_INPUT", str(exc)) from exc
        return output, summary, True

    if method == "robust_scale":
        only_options(options, {"suffix"})
        name_suffix = suffix(options, "_rs")
        ensure_new_columns(frame, columns, name_suffix)
        try:
            output, summary = scale_columns(frame, columns=columns, method="robust", suffix=name_suffix)
        except ValueError as exc:
            raise PreprocessError("INVALID_INPUT", str(exc)) from exc
        return output, summary, True

    if method == "log_transform":
        only_options(options, {"offset", "suffix"})
        offset = options.get("offset", 1.0)
        if not isinstance(offset, (int, float)) or isinstance(offset, bool) or not np.isfinite(offset):
            raise PreprocessError("INVALID_OPTIONS", "offset must be a finite number")
        name_suffix = suffix(options, "_ln")
        ensure_new_columns(frame, columns, name_suffix)
        try:
            output, summary = log_transform_columns(frame, columns=columns, offset=float(offset), suffix=name_suffix)
        except ValueError as exc:
            raise PreprocessError("INVALID_DOMAIN", str(exc)) from exc
        summary["new_columns"] = [f"{column}{name_suffix}" for column in columns]
        summary["offset"] = float(offset)
        return output, summary, True

    if method == "boxcox_transform":
        only_options(options, {"suffix", "shift"})
        name_suffix = suffix(options, "_bc")
        ensure_new_columns(frame, columns, name_suffix)
        shift = options.get("shift", 0.0)
        if not isinstance(shift, (int, float)) or isinstance(shift, bool) or not np.isfinite(shift):
            raise PreprocessError("INVALID_OPTIONS", "shift must be a finite number")
        try:
            output, summary = power_transform_columns(frame, columns=columns, method="boxcox", suffix=name_suffix, shift=float(shift))
        except ValueError as exc:
            raise PreprocessError("INVALID_DOMAIN", str(exc)) from exc
        return output, summary, True

    if method == "yeojohnson_transform":
        only_options(options, {"suffix"})
        name_suffix = suffix(options, "_yj")
        ensure_new_columns(frame, columns, name_suffix)
        try:
            output, summary = power_transform_columns(frame, columns=columns, method="yeojohnson", suffix=name_suffix)
        except ValueError as exc:
            raise PreprocessError("INVALID_INPUT", str(exc)) from exc
        return output, summary, True

    # ── 从 data_import preprocess action 迁入的方法 ──

    if method == "fill_constant":
        only_options(options, {"value"})
        value = options.get("value", 0)
        output, summary = fill_missing_constant(frame, columns=columns, value=value)
        return output, summary, True

    if method in ("forward_fill", "backward_fill"):
        only_options(options, {"group_by", "entity_var"})
        group_by = options.get("group_by") or (options.get("entity_var") and [options["entity_var"]]) or None
        direction = "forward" if method == "forward_fill" else "backward"
        output, summary = forward_backward_fill(frame, columns=columns, direction=direction, group_by=group_by or None)
        return output, summary, True

    if method == "linear_interpolate":
        only_options(options, {"time_var"})
        time_var = options.get("time_var")
        if not time_var or time_var not in frame.columns:
            raise PreprocessError("INVALID_OPTIONS", "linear_interpolate requires time_var")
        try:
            output, summary = data_preprocess_linear_interpolate(frame, columns=columns, time_var=time_var)
        except ValueError as exc:
            raise PreprocessError("INVALID_INPUT", str(exc)) from exc
        return output, summary, True

    if method == "group_linear_interpolate":
        only_options(options, {"time_var", "entity_var"})
        time_var = options.get("time_var")
        entity_var = options.get("entity_var")
        if not time_var or time_var not in frame.columns:
            raise PreprocessError("INVALID_OPTIONS", "group_linear_interpolate requires time_var")
        if not entity_var or entity_var not in frame.columns:
            raise PreprocessError("INVALID_OPTIONS", "group_linear_interpolate requires entity_var")
        try:
            output, summary = group_linear_interpolate(frame, columns=columns, time_var=time_var, group_by=[entity_var])
        except ValueError as exc:
            raise PreprocessError("INVALID_INPUT", str(exc)) from exc
        return output, summary, True

    if method == "regression_impute":
        only_options(options, {"predictors"})
        predictors = options.get("predictors", [])
        if not isinstance(predictors, list) or not predictors:
            raise PreprocessError("INVALID_OPTIONS", "regression_impute requires a non-empty predictors list")
        missing = [col for col in predictors if col not in frame.columns]
        if missing:
            raise PreprocessError("INVALID_OPTIONS", f"Predictors not found: {', '.join(missing)}")
        try:
            output, summary = regression_impute(frame, columns=columns, predictors=predictors)
        except ValueError as exc:
            raise PreprocessError("INVALID_INPUT", str(exc)) from exc
        return output, summary, True

    if method == "create_dummies":
        only_options(options, {"drop_first"})
        drop_first = options.get("drop_first", True)
        if not isinstance(drop_first, bool):
            raise PreprocessError("INVALID_OPTIONS", "drop_first must be a boolean")
        try:
            output, summary = safe_get_dummies(frame, columns=columns, drop_first=drop_first)
        except ValueError as exc:
            raise PreprocessError("INVALID_INPUT", str(exc)) from exc
        output_cols = [col for col in output.columns if col not in frame.columns]
        summary["new_columns"] = output_cols
        return output, summary, True

    if method == "combine_columns":
        only_options(options, {"output_column", "separator"})
        output_column = options.get("output_column", "")
        separator = options.get("separator", "_")
        if not isinstance(output_column, str) or not output_column.strip():
            raise PreprocessError("INVALID_OPTIONS", "combine_columns requires a non-empty output_column")
        if output_column in frame.columns:
            raise PreprocessError("COLUMN_COLLISION", f"Output column already exists: {output_column}")
        if len(columns) < 2:
            raise PreprocessError("INVALID_COLUMNS", "combine_columns needs at least two source columns")
        components = frame[columns]
        if components.isna().any(axis=None):
            raise PreprocessError("INVALID_INPUT", "Source columns contain missing values")
        string_cols = components.astype("string")
        for col_idx in range(len(columns)):
            if string_cols.iloc[:, col_idx].str.strip().eq("").any():
                raise PreprocessError("INVALID_INPUT", "Source columns contain empty values")
        combined = string_cols.agg(separator.join, axis=1)
        combinations = int(components.drop_duplicates().shape[0])
        distinct = int(combined.nunique(dropna=False))
        if distinct != combinations:
            raise PreprocessError("INVALID_INPUT", "Separator produced identifier collisions")
        output = frame.copy()
        output[output_column] = combined
        summary = _operation_summary(
            operation="combine_columns",
            rows_before=len(frame), rows_after=len(output),
            columns_before=len(frame.columns), columns_after=len(output.columns),
            affected_columns=columns,
            extra={"output_column": output_column, "separator": separator},
        )
        summary["new_columns"] = [output_column]
        return output, summary, True

    if method == "filter":
        only_options(options, {"rules"})
        rules = options.get("rules", [])
        if not isinstance(rules, list) or not rules:
            raise PreprocessError("INVALID_OPTIONS", "filter requires a non-empty rules list")
        working = frame.copy()
        for rule in rules:
            column = rule.get("column")
            if not isinstance(column, str) or column not in working.columns:
                raise PreprocessError("INVALID_OPTIONS", f"筛选列不存在或无效：{column}")
            operator = rule.get("operator")
            value = rule.get("value")
            values = rule.get("values")
            case_sensitive = bool(rule.get("caseSensitive", False))
            series = working[column]
            if operator in ("in", "not_in"):
                if not isinstance(values, list) or not values:
                    raise PreprocessError("INVALID_OPTIONS", f"{operator} 必须提供非空 values 列表")
                if value is not None:
                    raise PreprocessError("INVALID_OPTIONS", f"{operator} 不能同时提供 value")
            else:
                if value is None:
                    raise PreprocessError("INVALID_OPTIONS", f"{operator} 必须提供 value")
                if values is not None:
                    raise PreprocessError("INVALID_OPTIONS", f"{operator} 不能提供 values")
            if operator in ("contains", "not_contains") and not isinstance(value, str):
                raise PreprocessError("INVALID_OPTIONS", f"{operator} 的 value 必须是字符串")
            comparison_values = values if operator in ("in", "not_in") else [value]
            numeric_column = pd.api.types.is_numeric_dtype(series) and not pd.api.types.is_bool_dtype(series)
            if operator in ("eq", "neq", "in", "not_in") and numeric_column and any(
                isinstance(item, bool) for item in comparison_values
            ):
                raise PreprocessError("INVALID_OPTIONS", f"不能用布尔值筛选数值列“{column}”")
            value = coerce_filter_value(series, value)
            if operator in ("in", "not_in") and isinstance(values, list):
                values = [coerce_filter_value(series, item) for item in values]
            if operator == "in":
                working = working[series.isin(values)]
            elif operator == "not_in":
                working = working[~series.isin(values)]
            elif operator == "eq":
                working = working[series == value]
            elif operator == "neq":
                working = working[series != value]
            elif operator in ("gt", "gte", "lt", "lte"):
                if isinstance(value, bool):
                    raise PreprocessError("INVALID_OPTIONS", f"筛选值必须是数值，不能用布尔值执行 {operator}")
                try:
                    num_val = float(value)
                except (TypeError, ValueError):
                    raise PreprocessError("INVALID_OPTIONS", f"筛选值必须是数值，才能使用 {operator} 运算符")
                numeric_s = pd.to_numeric(series, errors="coerce")
                if numeric_s.isna().all() and series.notna().any():
                    raise PreprocessError("INVALID_INPUT", f"列“{column}”不是数值型，不能使用 {operator} 运算符筛选")
                if (series.notna() & numeric_s.isna()).any():
                    raise PreprocessError("INVALID_INPUT", f"列“{column}”含有无法转为数值的非缺失值，请先确认处理规则")
                if operator == "gt":
                    working = working[numeric_s > num_val]
                elif operator == "gte":
                    working = working[numeric_s >= num_val]
                elif operator == "lt":
                    working = working[numeric_s < num_val]
                elif operator == "lte":
                    working = working[numeric_s <= num_val]
            elif operator == "contains":
                str_series = series.astype("string").str.strip()
                pattern = str(value).strip()
                working = working[str_series.str.contains(pattern, na=False, case=case_sensitive, regex=False)]
            elif operator == "not_contains":
                str_series = series.astype("string").str.strip()
                pattern = str(value).strip()
                working = working[~str_series.str.contains(pattern, na=False, case=case_sensitive, regex=False)]
            else:
                raise PreprocessError("INVALID_OPTIONS", f"筛选运算符不受支持：{operator}")
        output = working.copy()
        summary = _operation_summary(
            operation="filter",
            rows_before=len(frame), rows_after=len(output),
            columns_before=len(frame.columns), columns_after=len(output.columns),
            affected_columns=columns,
            extra={"rules_count": len(rules), "rules": rules},
        )
        return output, summary, True

    if method == "create_column":
        # 条件列创建：根据 columns[0] <operator> right_value/right_column 生成 0/1 指示列。
        # 典型用途：post = year >= time ? 1 : 0（DID 政策后哑变量）。
        only_options(options, {"output_column", "operator", "right_value", "right_column"})
        output_column = options.get("output_column", "")
        operator = options.get("operator", "")
        right_value = options.get("right_value")
        right_column = options.get("right_column")
        if not isinstance(output_column, str) or not output_column.strip():
            raise PreprocessError("INVALID_OPTIONS", "create_column requires a non-empty output_column")
        if output_column in frame.columns:
            raise PreprocessError("COLUMN_COLLISION", f"Output column already exists: {output_column}")
        valid_ops = {"eq", "neq", "gt", "gte", "lt", "lte"}
        if not isinstance(operator, str) or operator not in valid_ops:
            raise PreprocessError("INVALID_OPTIONS", f"create_column requires operator in {valid_ops}")
        if len(columns) < 1:
            raise PreprocessError("INVALID_COLUMNS", "create_column needs at least one source column (left side)")
        left_col = columns[0]
        if left_col not in frame.columns:
            raise PreprocessError("INVALID_COLUMNS", f"Left column not found: {left_col}")
        # 右侧：常量值或另一列
        if right_column is not None:
            if not isinstance(right_column, str) or right_column not in frame.columns:
                raise PreprocessError("INVALID_COLUMNS", f"Right column not found: {right_column}")
            right_series = pd.to_numeric(frame[right_column], errors="coerce")
            # 右侧列若全为非数值但原列有值，说明类型不匹配，拒绝静默全 0
            if right_series.isna().all() and frame[right_column].notna().any():
                raise PreprocessError("INVALID_INPUT", f"Column '{right_column}' is not numeric for create_column comparison")
        elif right_value is not None:
            right_series = pd.to_numeric(pd.Series([right_value] * len(frame)), errors="coerce")
            if right_series.isna().all() and str(right_value).strip() != "":
                raise PreprocessError("INVALID_INPUT", f"Right value '{right_value}' is not numeric for create_column comparison")
        else:
            raise PreprocessError("INVALID_OPTIONS", "create_column requires either right_value or right_column")
        left_series = pd.to_numeric(frame[left_col], errors="coerce")
        if left_series.isna().all() and frame[left_col].notna().any():
            raise PreprocessError("INVALID_INPUT", f"Column '{left_col}' is not numeric")
        ops_map = {"eq": left_series.eq, "neq": left_series.ne, "gt": left_series.gt,
                    "gte": left_series.ge, "lt": left_series.lt, "lte": left_series.le}
        # 比较结果含 NaN（任一侧有缺失值）时填 0（视为不满足条件），再转 int
        result = ops_map[operator](right_series).fillna(False).astype(int)
        output = frame.copy()
        output[output_column] = result
        summary = _operation_summary(
            operation="create_column",
            rows_before=len(frame), rows_after=len(output),
            columns_before=len(frame.columns), columns_after=len(output.columns),
            affected_columns=columns,
            extra={"output_column": output_column, "operator": operator,
                   "right_column": right_column, "right_value": right_value,
                   "true_count": int(result.sum()), "false_count": int(len(result) - result.sum())},
        )
        summary["new_columns"] = [output_column]
        return output, summary, True

    if method == "create_relative_time":
        only_options(options, {"entity_var", "time_var", "cohort_var", "treatment_var", "output_column"})
        required = ("entity_var", "time_var", "cohort_var", "treatment_var", "output_column")
        missing = [name for name in required if not isinstance(options.get(name), str) or not options[name].strip()]
        if missing:
            raise PreprocessError("INVALID_OPTIONS", f"create_relative_time 缺少必填 options：{', '.join(missing)}")
        try:
            output, summary = data_preprocess_create_relative_time(
                frame,
                entity_var=options["entity_var"],
                time_var=options["time_var"],
                cohort_var=options["cohort_var"],
                treatment_var=options["treatment_var"],
                output_column=options["output_column"],
            )
        except ValueError as exc:
            message = str(exc)
            code = "COLUMN_COLLISION" if "拒绝覆盖" in message else "INVALID_INPUT"
            raise PreprocessError(code, message) from exc
        return output, summary, True

    raise PreprocessError("UNKNOWN_METHOD", f"Unknown preprocessing method: {method}")


def execute(payload: dict[str, Any]) -> dict[str, Any]:
    method = payload.get("method")
    if not isinstance(method, str) or method not in METHODS:
        raise PreprocessError("UNKNOWN_METHOD", "method must name a supported preprocessing method")
    data_path = payload.get("dataPath")
    output_path = payload.get("outputPath")
    if not isinstance(data_path, str) or not data_path:
        raise PreprocessError("INVALID_INPUT_PATH", "dataPath is required")
    if method in MUTATING_METHODS and (not isinstance(output_path, str) or not output_path):
        raise PreprocessError("INVALID_OUTPUT_PATH", "outputPath is required for a mutating method")
    frame = read_table(data_path)
    # filter 用 rules 里的 column 而非顶层 columns，传空列表跳过 require_columns 校验
    columns = require_columns(frame, payload.get("columns")) if method not in {"filter", "create_relative_time"} else []
    options = options_object(payload.get("options"))
    output, details, mutates = dispatch(method, frame, columns, options)

    result: dict[str, Any] = {
        "success": True,
        "method": method,
        "mutation": mutates,
        "rows_before": int(len(frame)),
        "rows_after": int(len(output)) if output is not None else int(len(frame)),
        "columns_before": int(len(frame.columns)),
        "columns_after": int(len(output.columns)) if output is not None else int(len(frame.columns)),
        **details,
    }
    if output is not None:
        result["changed_cells"] = count_changed_cells(frame, output, columns)
        result["new_columns"] = [column for column in output.columns if column not in frame.columns]
        result["dropped_columns"] = [column for column in frame.columns if column not in output.columns]
        write_table(output, output_path)
        result["output_path"] = output_path
        try:
            result["readiness"] = build_data_readiness(output)
        except Exception:
            result["readiness_error"] = "READINESS_REBUILD_FAILED"
    return result


def main() -> None:
    try:
        payload = read_payload()
        result = execute(payload)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False))
    except PreprocessError as exc:
        fail(exc.code, str(exc))
    except ValueError as exc:
        fail("INVALID_INPUT", str(exc))
    except Exception:
        # Harness 与模型只得到稳定错误分类，不泄露 Python 路径或 traceback；完整 stderr
        # 仍由受管进程保存给本地诊断。
        fail("BACKEND_FAILURE", "Data preprocessing backend failed")




if __name__ == "__main__":
    main()
