"""数据入口的轻量执行适配。

数据集 ID、阶段 ID、源文件快照和用户可见产物由 TypeScript Harness 管理；本文件只
负责表格读取、画像、质量检查和受控导出，不创建会话状态，也不调用模型。
"""

from __future__ import annotations

import csv
import json
import sys
from pathlib import Path
from typing import Any

import pandas as pd

CORE_DIR = Path(__file__).resolve().parents[1] / "econometrics"
if str(CORE_DIR) not in sys.path:
    sys.path.insert(0, str(CORE_DIR))

from data_preprocess import build_data_readiness, build_quality_report, correlation_matrix, describe_dataset  # noqa: E402
from killstata_econometrics_engine.diagnosis import diagnose_dataframe  # noqa: E402


def _load(path: Path) -> pd.DataFrame:
    suffix = path.suffix.lower()
    if suffix in {".xlsx", ".xls"}:
        return pd.read_excel(path)
    if suffix == ".csv":
        return pd.read_csv(path)
    if suffix == ".dta":
        return pd.read_stata(path)
    if suffix in {".parquet", ".pq"}:
        return pd.read_parquet(path)
    raise ValueError(f"不支持的数据文件格式：{path.suffix or '无扩展名'}。")


def _read_import_csv(path: Path) -> tuple[pd.DataFrame, str]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        sample = handle.read(64 * 1024)
    try:
        delimiter = csv.Sniffer().sniff(sample, delimiters=",;\t|").delimiter
    except csv.Error:
        delimiter = ","
    return pd.read_csv(path, sep=delimiter, dtype=object, keep_default_na=False), delimiter


def _load_for_import(path: Path, request: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, Any], dict[str, Any] | None]:
    """导入阶段统一经过规范化 schema；后续阶段读取已规范化文件即可。"""
    from data_schema import normalize_for_canonical

    suffix = path.suffix.lower()
    source_format = suffix[1:] if suffix else ""
    policy = request.get("sheetPolicy") if isinstance(request.get("sheetPolicy"), dict) else {"mode": "first_sheet"}
    sheet_info = None
    csv_delimiter = None
    if suffix in {".xlsx", ".xls"}:
        with pd.ExcelFile(path) as workbook:
            names = [str(name) for name in workbook.sheet_names]
            if not names:
                raise ValueError("Excel 工作簿没有可读取的工作表。")
            mode = policy.get("mode") or "first_sheet"
            if mode == "named_sheet":
                selected = policy.get("sheetName")
                if not isinstance(selected, str) or selected not in names:
                    requested = str(selected or "（未指定）")
                    raise ValueError(
                        f"Excel 工作表“{requested}”不存在。可用工作表：{'、'.join(names)}。"
                    )
            elif mode == "first_sheet":
                selected = names[0]
            else:
                raise ValueError("Excel 工作表选择方式必须是 first_sheet 或 named_sheet。")
            header_row = policy.get("headerRow")
            frame = pd.read_excel(
                workbook,
                sheet_name=selected,
                header=header_row if header_row is not None else 0,
                dtype=object,
                keep_default_na=False,
            )
            sheet_info = {"names": names, "selected": selected}
    elif suffix == ".csv":
        frame, csv_delimiter = _read_import_csv(path)
    else:
        frame = _load(path)
    normalized, receipt = normalize_for_canonical(
        frame,
        source_path=str(path),
        source_format=source_format,
        sheet_policy=policy,
    )
    if csv_delimiter is not None:
        receipt["delimiter"] = csv_delimiter
    return normalized, receipt, sheet_info


def _json_value(value: Any) -> Any:
    if hasattr(value, "item"):
        return value.item()
    if isinstance(value, dict):
        return {str(key): _json_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_value(item) for item in value]
    return value


def _write_json(path: Path, value: Any) -> None:
    path.write_text(json.dumps(_json_value(value), ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")


def _profile(frame: pd.DataFrame) -> dict[str, Any]:
    columns: list[dict[str, Any]] = []
    for name in frame.columns:
        series = frame[name]
        numeric = pd.to_numeric(series, errors="coerce")
        columns.append({
            "name": str(name),
            "dtype": str(series.dtype),
            "missing": int(series.isna().sum()),
            "unique": int(series.nunique(dropna=True)),
            "numeric": bool(numeric.notna().sum() == series.notna().sum()),
            "min": numeric.min() if numeric.notna().any() else None,
            "max": numeric.max() if numeric.notna().any() else None,
        })
    return {
        "rows": int(len(frame)),
        "columns": int(len(frame.columns)),
        "variables": [str(name) for name in frame.columns],
        "schema": columns,
        "duplicate_rows": int(frame.duplicated().sum()),
    }


def _selected_columns(frame: pd.DataFrame, requested: Any) -> list[str]:
    if requested is None or requested == []:
        return [str(column) for column in frame.columns]
    if not isinstance(requested, list) or any(not isinstance(column, str) or not column.strip() for column in requested):
        raise ValueError("variables 必须是非空字符串数组")
    selected = list(dict.fromkeys(requested))
    missing = [column for column in selected if column not in frame.columns]
    if missing:
        raise ValueError(f"variables 中包含不存在的变量：{'、'.join(missing)}。")
    return selected


def _write_result(output: Path, result: dict[str, Any]) -> None:
    result_path = output / "results.json"
    _write_json(result_path, result)
    result.setdefault("resultPath", str(result_path))


def _requested_output(request: dict[str, Any], output: Path, suffix: str) -> Path:
    requested = request.get("outputPath")
    if isinstance(requested, str) and requested.strip():
        return Path(requested).with_suffix(suffix)
    return output / f"{str(request.get('action') or 'data')}{suffix}"


def _quality(frame: pd.DataFrame, request: dict[str, Any]) -> dict[str, Any]:
    _, report = build_quality_report(
        frame,
        entity_var=request.get("entityVar") if isinstance(request.get("entityVar"), str) else None,
        time_var=request.get("timeVar") if isinstance(request.get("timeVar"), str) else None,
    )
    return report


def execute(request: dict[str, Any]) -> dict[str, Any]:
    action = str(request.get("action") or "")
    source = Path(str(request.get("dataPath") or ""))
    output = Path(str(request.get("outputDir") or ""))
    if action == "healthcheck":
        return {"success": True, "action": action, "status": "ready", "engine": "pandas", "message": "数据分析依赖可用。"}
    if not source.is_file():
        raise ValueError(f"找不到输入数据文件：{source}。")
    output.mkdir(parents=True, exist_ok=True)
    receipt: dict[str, Any] = {}
    sheet_info: dict[str, Any] | None = None
    if action == "import":
        frame, receipt, sheet_info = _load_for_import(source, request)
    else:
        frame = _load(source)
    summary = _profile(frame)
    selected = _selected_columns(frame, request.get("variables"))
    result: dict[str, Any] = {
        "success": True,
        "action": action,
        "input_path": str(source),
        "rows_before": summary["rows"],
        "rows_after": summary["rows"],
        "columns_before": summary["columns"],
        "columns_after": summary["columns"],
        "variables": selected,
        **summary,
    }
    if action == "import":
        if sheet_info is not None:
            result["sheet_info"] = sheet_info
        result["readiness"] = build_data_readiness(frame)
        _, quality = build_quality_report(frame)
        result["autoQa"] = {
            "status": quality["status"],
            "warnings": quality["warnings"],
            "blockingErrors": quality["blocking_errors"],
            "suggestedRepairs": quality["suggested_repairs"],
        }
    if action in {"import", "profile", "validate"}:
        diagnosis = diagnose_dataframe(
            frame,
            dataset_id=str(request.get("datasetId") or "pending-dataset"),
            stage_id=str(request.get("stageId") or "pending-stage"),
        )
        result["diagnosis"] = diagnosis.model_dump(mode="json")
    if receipt:
        result["receipt"] = receipt
        result["schema_normalization"] = receipt
    if action == "import":
        data_path = Path(str(request.get("outputPath") or (output / "data.parquet")))
        schema_path = output / "schema.json"
        frame.to_parquet(data_path, index=False)
        result["dataPath"] = str(data_path)
        result["schemaPath"] = str(schema_path)
        # 与既有 Harness 的 importReceipt 契约保持一致：规范化记录位于 normalization，
        # schema 是兼容的列摘要；字段名变化会让旧 stage 无法复核标识列是否被保留。
        _write_json(schema_path, {"schema": summary["schema"], "normalization": receipt, "receipt": receipt})
        result["output_path"] = str(data_path)
        result["outputPath"] = str(data_path)
        result["dataPath"] = str(data_path)
        result["schemaPath"] = str(schema_path)
        _write_result(output, result)
    elif action == "frequency":
        group_by = request.get("groupBy")
        if group_by is None:
            group_by = []
        if not isinstance(group_by, list) or len(group_by) > 2 or any(not isinstance(item, str) for item in group_by):
            raise ValueError("frequency 的 groupBy 最多支持两列，且必须是字符串数组。")
        missing = [item for item in group_by if item not in frame.columns]
        if missing:
            raise ValueError(f"groupBy 中包含不存在的变量：{'、'.join(missing)}。")
        targets = list(dict.fromkeys([*group_by, *selected]))
        max_distinct = max(2, min(int(request.get("maxDistinct") or 20), 100))
        distributions: dict[str, list[dict[str, Any]]] = {}
        distribution_meta: dict[str, dict[str, Any]] = {}
        for column in targets:
            counts = frame[column].astype("string").fillna("<缺失>").value_counts(dropna=False)
            distributions[column] = [
                {"value": str(value), "count": int(count), "share": round(float(count / max(len(frame), 1)), 6)}
                for value, count in counts.head(max_distinct).items()
            ]
            non_missing = frame[column].dropna()
            numeric = pd.to_numeric(non_missing, errors="coerce")
            meta: dict[str, Any] = {
                "distinct_count": int(non_missing.nunique(dropna=True)),
                "numeric": bool(len(non_missing) > 0 and numeric.notna().all()),
            }
            if meta["numeric"]:
                meta["min"] = float(numeric.min())
                meta["max"] = float(numeric.max())
            distribution_meta[column] = meta
        cross_tab: list[dict[str, Any]] = []
        if group_by:
            counts = frame[group_by].astype("string").fillna("<缺失>").value_counts(dropna=False)
            for key, count in counts.head(max_distinct * max_distinct).items():
                values = list(key) if isinstance(key, tuple) else [key]
                cross_tab.append({"values": [str(value) for value in values], "count": int(count), "share": round(float(count / max(len(frame), 1)), 6)})
        result.update({"variables": targets, "group_by": group_by, "distributions": distributions, "distribution_meta": distribution_meta, "cross_tab": cross_tab, "max_distinct": max_distinct, "output_path": str(output / "results.json")})
        _write_result(output, result)
    elif action == "correlation":
        requested_method = request.get("options", {}).get("method", "pearson") if isinstance(request.get("options"), dict) else "pearson"
        if requested_method not in {"pearson", "spearman", "kendall"}:
            raise ValueError("correlation 的 method 必须是 pearson、spearman 或 kendall。")
        correlation, correlation_summary = correlation_matrix(frame, columns=selected, method=requested_method)
        csv_path = _requested_output(request, output, ".csv")
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        correlation.to_csv(csv_path, encoding="utf-8-sig")
        result.update({"correlation": correlation.to_dict(), "variables": correlation_summary["variables"], "method": requested_method, "output_path": str(csv_path)})
        _write_result(output, result)
    elif action == "profile":
        profile_frame, profile_summary = describe_dataset(frame, columns=selected)
        csv_path = _requested_output(request, output, ".csv")
        csv_path.parent.mkdir(parents=True, exist_ok=True)
        profile_frame.to_csv(csv_path, index=False, encoding="utf-8-sig")
        result.update({"profile": profile_frame.to_dict("records"), "variables": profile_summary["variables"], "readiness": build_data_readiness(frame), "output_path": str(csv_path)})
        _write_result(output, result)
    elif action == "validate":
        quality = _quality(frame, request)
        result.update({
            "status": quality["status"],
            "warnings": quality["warnings"],
            "blocking_errors": quality["blocking_errors"],
            "suggested_repairs": quality["suggested_repairs"],
            "notes": quality.get("notes", []),
            "readiness": build_data_readiness(frame),
            "autoQa": {
                "status": quality["status"],
                "warnings": quality["warnings"],
                "blockingErrors": quality["blocking_errors"],
                "suggestedRepairs": quality["suggested_repairs"],
            },
        })
        validation_path = Path(str(request.get("outputPath") or (output / "validate.json")))
        validation_path.parent.mkdir(parents=True, exist_ok=True)
        result["output_path"] = str(validation_path)
        _write_json(validation_path, result)
        _write_result(output, result)
    elif action == "export":
        target = Path(str(request.get("outputPath") or (output / "data.xlsx")))
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.suffix.lower() == ".csv":
            frame.to_csv(target, index=False)
        elif target.suffix.lower() in {".parquet", ".pq"}:
            frame.to_parquet(target, index=False)
        else:
            frame.to_excel(target, index=False)
        result["resultPath"] = str(target)
        result["output_path"] = str(target)
        _write_result(output, result)
    elif action == "rollback":
        target = Path(str(request.get("outputPath") or (output / "data.parquet")))
        frame.to_parquet(target, index=False)
        result["output_path"] = str(target)
        result["dataPath"] = str(target)
        _write_result(output, result)
    return _json_value(result)


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.read() or "{}")
        print(json.dumps(execute(request), ensure_ascii=False))
    except Exception as error:
        print(json.dumps({"success": False, "message": str(error)}, ensure_ascii=False))
        raise SystemExit(1)
