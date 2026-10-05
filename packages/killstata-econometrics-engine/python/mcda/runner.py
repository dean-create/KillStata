#!/usr/bin/env python3
"""KillStata 综合评价（MCDA）受管 Python 后端。

协议：从 stdin 读取一个 JSON payload，stdout 只输出一行 JSON。首批方法仅有
`entropy_weight` 和 `topsis`；数据文件只允许 CSV/Parquet，完整分数表只写入
`scores.parquet`，避免把整张表直接塞回模型上下文。
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from killstata_econometrics_engine.diagnosis import content_fingerprint
from killstata_econometrics_engine.errors import EngineError


EPSILON = 1e-12
SUPPORTED_METHODS = {"entropy_weight", "topsis"}


def load_frame(data_path: str) -> pd.DataFrame:
    suffix = Path(data_path).suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(data_path)
    if suffix == ".parquet":
        return pd.read_parquet(data_path)
    raise ValueError(f"MCDA 只支持 CSV 或 Parquet 数据，收到：{suffix or '未知格式'}")


def json_safe(value: Any) -> Any:
    """递归剔除 NumPy 标量和非 JSON 的 NaN/Infinity。"""
    if isinstance(value, np.generic):
        value = value.item()
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, (str, int, bool)) or value is None:
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(key): json_safe(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(item) for item in value]
    return str(value)


def require_string_list(payload: dict[str, Any], key: str, *, minimum: int = 1) -> list[str]:
    value = payload.get(key)
    if not isinstance(value, list) or len(value) < minimum or not all(isinstance(item, str) and item for item in value):
        raise ValueError(f"{key} 必须是至少 {minimum} 个非空列名组成的数组")
    if len(set(value)) != len(value):
        raise ValueError(f"{key} 不允许重复列名")
    return value


def parse_indicators(payload: dict[str, Any]) -> tuple[list[str], list[str]]:
    raw = payload.get("indicators")
    if not isinstance(raw, list) or len(raw) < 2:
        raise ValueError("indicators 至少需要 2 个指标")

    columns: list[str] = []
    directions: list[str] = []
    for indicator in raw:
        if not isinstance(indicator, dict):
            raise ValueError("indicators 的每项必须是 {column, direction}")
        column = indicator.get("column")
        direction = indicator.get("direction")
        if not isinstance(column, str) or not column:
            raise ValueError("每个指标都必须提供非空 column")
        if direction not in {"benefit", "cost"}:
            raise ValueError(f"指标 {column} 的 direction 必须是 benefit 或 cost")
        columns.append(column)
        directions.append(direction)
    if len(set(columns)) != len(columns):
        raise ValueError("indicators 不允许重复指标列")
    return columns, directions


def validate_roles(
    frame: pd.DataFrame,
    id_columns: list[str],
    indicator_columns: list[str],
    scope: str,
    group_columns: list[str],
) -> None:
    required = [*id_columns, *indicator_columns, *group_columns]
    missing = [column for column in required if column not in frame.columns]
    if missing:
        raise ValueError(f"数据中找不到列：{', '.join(missing)}")

    if frame.columns.duplicated().any():
        duplicates = frame.columns[frame.columns.duplicated()].tolist()
        raise ValueError(f"数据中存在重复列名：{', '.join(map(str, duplicates))}")

    id_set = set(id_columns)
    indicator_set = set(indicator_columns)
    group_set = set(group_columns)
    if id_set & indicator_set or id_set & group_set or indicator_set & group_set:
        raise ValueError("ID、指标与分组列不能重叠")
    if scope == "by_group" and not group_columns:
        raise ValueError("scope=by_group 时必须提供 groupColumns")
    if scope == "global" and group_columns:
        raise ValueError("scope=global 时不得提供 groupColumns")


def prepare_frame(
    payload: dict[str, Any],
    frame: pd.DataFrame | None = None,
) -> tuple[pd.DataFrame, list[str], list[str], list[str], str, list[str]]:
    method = payload.get("method")
    if method not in SUPPORTED_METHODS:
        raise ValueError(f"不支持的方法：{method}")
    data_path = payload.get("dataPath")
    if not isinstance(data_path, str) or not data_path:
        raise ValueError("dataPath 必须是非空字符串")

    id_columns = require_string_list(payload, "idColumns")
    indicator_columns, directions = parse_indicators(payload)
    scope = payload.get("scope", "global")
    if scope not in {"global", "by_group"}:
        raise ValueError("scope 必须是 global 或 by_group")
    if scope == "by_group":
        group_columns = require_string_list(payload, "groupColumns", minimum=1)
    else:
        if payload.get("groupColumns") is not None:
            raise ValueError("scope=global 时不得提供 groupColumns")
        group_columns = []

    frame = frame if frame is not None else load_frame(data_path)
    validate_roles(frame, id_columns, indicator_columns, scope, group_columns)

    if frame[id_columns].isna().any().any():
        raise ValueError("ID 列不允许缺失值")
    # 全局评价要求 ID 全表唯一；分组评价中同一对象跨年/跨组重复是正常面板结构，
    # 只需保证同一组内 ID 唯一，不能把分组键同时伪装成 ID。
    uniqueness_key = [*group_columns, *id_columns] if scope == "by_group" else id_columns
    if frame.duplicated(subset=uniqueness_key).any():
        raise ValueError("ID 列组合在评价范围内存在重复，无法安全回写综合评价结果")
    if group_columns and frame[group_columns].isna().any().any():
        raise ValueError("分组列不允许缺失值")

    values = frame[indicator_columns]
    if values.isna().any().any():
        raise ValueError("指标列含缺失值；MCDA 首版固定拒绝缺失值，请先完成数据清洗")
    numeric = values.apply(pd.to_numeric, errors="coerce")
    invalid_numeric = [
        column
        for column in indicator_columns
        if numeric[column].isna().any() and not values[column].isna().any()
    ]
    if invalid_numeric:
        raise ValueError(f"指标必须为数值型：{', '.join(invalid_numeric)}")
    if not np.isfinite(numeric.to_numpy(dtype=float)).all():
        raise ValueError("指标列包含非有限值（Infinity/-Infinity），请先清洗数据")

    frame = frame.copy()
    frame.loc[:, indicator_columns] = numeric
    return frame, id_columns, indicator_columns, directions, scope, group_columns


def orient_indicators(values: np.ndarray, directions: list[str], columns: list[str]) -> np.ndarray:
    minima = values.min(axis=0)
    maxima = values.max(axis=0)
    spans = maxima - minima
    constants = [columns[index] for index, span in enumerate(spans) if not np.isfinite(span) or span <= EPSILON]
    if constants:
        raise ValueError(f"存在常数指标，无法参与综合评价：{', '.join(constants)}")

    oriented = np.empty_like(values, dtype=float)
    for index, direction in enumerate(directions):
        if direction == "benefit":
            oriented[:, index] = (values[:, index] - minima[index]) / spans[index]
        else:
            oriented[:, index] = (maxima[index] - values[:, index]) / spans[index]
    if not np.isfinite(oriented).all():
        raise ValueError("指标正向化后出现非有限值，拒绝生成结果")
    return oriented


def entropy_weights(oriented: np.ndarray, columns: list[str]) -> np.ndarray:
    column_sums = oriented.sum(axis=0)
    empty = [columns[index] for index, total in enumerate(column_sums) if not np.isfinite(total) or total <= EPSILON]
    if empty:
        raise ValueError(f"熵权计算病态：正向化后指标总量为 0：{', '.join(empty)}")

    probabilities = oriented / column_sums
    # np.where 会同时计算两个分支，直接写 p * log(p) 会在 p=0 时向 stderr
    # 泄漏 RuntimeWarning；Harness 会收集 stderr，因此仅对正概率位置取对数。
    log_terms = np.zeros_like(probabilities)
    positive = probabilities > 0.0
    log_terms[positive] = probabilities[positive] * np.log(probabilities[positive])
    entropy = -log_terms.sum(axis=0) / math.log(float(len(oriented)))
    divergence = 1.0 - entropy
    total_divergence = float(divergence.sum())
    if not np.isfinite(divergence).all() or total_divergence <= EPSILON:
        raise ValueError("熵权计算病态：指标差异总量为 0，无法确定有效权重")
    weights = divergence / total_divergence
    if not np.isfinite(weights).all() or (weights < -EPSILON).any() or abs(float(weights.sum()) - 1.0) > EPSILON:
        raise ValueError("熵权计算产生病态权重，拒绝输出结果")
    return weights


def manual_weights(raw: Any, columns: list[str]) -> np.ndarray:
    if not isinstance(raw, dict):
        raise ValueError("weightSource=manual 时必须提供 manualWeights")
    actual = set(raw)
    expected = set(columns)
    if actual != expected:
        missing = sorted(expected - actual)
        extra = sorted(actual - expected)
        details: list[str] = []
        if missing:
            details.append(f"缺少 {', '.join(missing)}")
        if extra:
            details.append(f"多出 {', '.join(extra)}")
        raise ValueError(f"manualWeights 必须与指标一一对应（{'；'.join(details)}）")
    values = [raw[column] for column in columns]
    if any(isinstance(value, bool) or not isinstance(value, (int, float)) for value in values):
        raise ValueError("manualWeights 必须全部是 JSON 数值，不能是布尔值或字符串")
    weights = np.asarray(values, dtype=float)
    if not np.isfinite(weights).all():
        raise ValueError("manualWeights 不允许非有限值")
    if (weights < 0).any():
        raise ValueError("manualWeights 不允许负数")
    if abs(float(weights.sum()) - 1.0) > EPSILON:
        raise ValueError("manualWeights 的和必须为 1")
    if float(weights.sum()) <= EPSILON:
        raise ValueError("manualWeights 不能全为 0")
    return weights


def select_topsis_weights(payload: dict[str, Any], oriented: np.ndarray, columns: list[str]) -> tuple[str, np.ndarray]:
    source = payload.get("weightSource")
    if source is None:
        raise ValueError("TOPSIS 必须明确提供 weightSource，不能默认等权")
    if source == "equal":
        return source, np.full(len(columns), 1.0 / len(columns), dtype=float)
    if source == "entropy":
        return source, entropy_weights(oriented, columns)
    if source == "manual":
        return source, manual_weights(payload.get("manualWeights"), columns)
    raise ValueError("weightSource 必须是 equal、manual 或 entropy")


def topsis_score(oriented: np.ndarray, weights: np.ndarray) -> np.ndarray:
    norms = np.sqrt(np.square(oriented).sum(axis=0))
    if not np.isfinite(norms).all() or (norms <= EPSILON).any():
        raise ValueError("TOPSIS 标准化病态：存在零范数指标")
    weighted = (oriented / norms) * weights
    positive_ideal = weighted.max(axis=0)
    negative_ideal = weighted.min(axis=0)
    positive_distance = np.sqrt(np.square(weighted - positive_ideal).sum(axis=1))
    negative_distance = np.sqrt(np.square(weighted - negative_ideal).sum(axis=1))
    denominator = positive_distance + negative_distance
    if not np.isfinite(denominator).all() or (denominator <= EPSILON).any():
        raise ValueError("TOPSIS 正负理想距离同时为 0，无法排序")
    score = negative_distance / denominator
    if not np.isfinite(score).all() or (score < -EPSILON).any() or (score > 1.0 + EPSILON).any():
        raise ValueError("TOPSIS 得分超出 [0, 1] 或非有限，拒绝输出结果")
    return np.clip(score, 0.0, 1.0)


def group_label(group_columns: list[str], key: Any) -> str:
    values = key if isinstance(key, tuple) else (key,)
    return " | ".join(f"{column}={value}" for column, value in zip(group_columns, values, strict=True))


def weights_payload(columns: list[str], weights: np.ndarray) -> list[dict[str, Any]]:
    return [{"column": column, "weight": float(weights[index])} for index, column in enumerate(columns)]


def score_partition(
    part: pd.DataFrame,
    method: str,
    indicator_columns: list[str],
    directions: list[str],
    payload: dict[str, Any],
) -> tuple[np.ndarray, np.ndarray, str, list[dict[str, Any]]]:
    if len(part) < 3:
        raise ValueError("每个综合评价范围至少需要 3 行数据")
    oriented = orient_indicators(part[indicator_columns].to_numpy(dtype=float), directions, indicator_columns)
    if method == "entropy_weight":
        source = "entropy"
        weights = entropy_weights(oriented, indicator_columns)
        score = oriented @ weights
    else:
        source, weights = select_topsis_weights(payload, oriented, indicator_columns)
        score = topsis_score(oriented, weights)
    if not np.isfinite(score).all():
        raise ValueError("综合得分出现非有限值，拒绝输出结果")
    rank = pd.Series(score, index=part.index).rank(method="min", ascending=False).astype("int64").to_numpy()
    return score, rank, source, weights_payload(indicator_columns, weights)


def build_result(payload: dict[str, Any]) -> dict[str, Any]:
    data_path = payload.get("dataPath")
    expected_fingerprint = payload.get("expectedDataFingerprint")
    if not isinstance(data_path, str) or not data_path:
        raise ValueError("dataPath 必须是非空字符串")
    frame = load_frame(data_path)
    actual_fingerprint = content_fingerprint(frame)
    if not isinstance(expected_fingerprint, str) or expected_fingerprint != actual_fingerprint:
        raise EngineError(
            "DATA_FINGERPRINT_MISMATCH",
            "综合评价输入数据与当前诊断指纹不一致；尚未计算或写出结果。请重新诊断当前数据阶段后再继续。",
            method_id="composite_evaluation",
            field="expectedDataFingerprint",
            details={
                "expected_data_fingerprint": expected_fingerprint,
                "actual_data_fingerprint": actual_fingerprint,
            },
        )
    frame, id_columns, indicator_columns, directions, scope, group_columns = prepare_frame(payload, frame)
    method = str(payload["method"])
    score_column = f"ks_{method}_score"
    rank_column = f"ks_{method}_rank"
    collisions = [column for column in (score_column, rank_column) if column in frame.columns]
    if collisions:
        raise ValueError(f"输出列已存在，拒绝覆盖原数据：{', '.join(collisions)}")

    scores = pd.Series(index=frame.index, dtype=float)
    ranks = pd.Series(index=frame.index, dtype="int64")
    diagnostics: list[dict[str, Any]] = []
    group_weights: dict[str, list[dict[str, Any]]] = {}
    source_used: str | None = None

    if scope == "global":
        score, rank, source_used, weights = score_partition(frame, method, indicator_columns, directions, payload)
        scores.loc[frame.index] = score
        ranks.loc[frame.index] = rank
        diagnostics.append({"scope": "global", "rows": int(len(frame))})
    else:
        grouped = frame.groupby(group_columns, sort=False, dropna=False)
        for key, part in grouped:
            score, rank, source, weights = score_partition(part, method, indicator_columns, directions, payload)
            if source_used is None:
                source_used = source
            elif source != source_used:
                raise ValueError("分组间权重来源不一致，拒绝输出结果")
            label = group_label(group_columns, key)
            scores.loc[part.index] = score
            ranks.loc[part.index] = rank
            group_weights[label] = weights
            diagnostics.append({"scope": label, "rows": int(len(part))})

    if scores.isna().any() or ranks.isna().any():
        raise ValueError("综合评价未覆盖全部行，拒绝输出结果")
    frame[score_column] = scores.astype(float)
    frame[rank_column] = ranks.astype("int64")

    if scope == "global":
        weights_for_result = weights
    else:
        weights_for_result = []
    summary_columns = [*id_columns, score_column, rank_column]
    if scope == "global":
        order = frame.sort_values([score_column, *id_columns], ascending=[False, *([True] * len(id_columns))], kind="stable")
        top = order.loc[:, summary_columns].head(5).to_dict(orient="records")
        bottom = order.loc[:, summary_columns].tail(5).sort_values(
            [score_column, *id_columns], ascending=[True, *([True] * len(id_columns))], kind="stable"
        ).to_dict(orient="records")
        top_by_group = None
    else:
        top = []
        bottom = []
        top_by_group = {}
        for key, part in frame.groupby(group_columns, sort=False, dropna=False):
            label = group_label(group_columns, key)
            order = part.sort_values([score_column, *id_columns], ascending=[False, *([True] * len(id_columns))], kind="stable")
            top_by_group[label] = order.loc[:, summary_columns].head(5).to_dict(orient="records")

    output_dir_raw = payload.get("outputDir")
    if not isinstance(output_dir_raw, str) or not output_dir_raw:
        raise ValueError("outputDir 必须是非空字符串")
    output_dir = Path(output_dir_raw)
    output_dir.mkdir(parents=True, exist_ok=True)
    scores_path = output_dir / "scores.parquet"
    weights_path = output_dir / "weights.csv"
    result_path = output_dir / "results.json"
    frame.to_parquet(scores_path, index=False)

    weight_rows: list[dict[str, Any]] = []
    if scope == "global":
        weight_rows.extend(weights_for_result)
    else:
        for label, group_weights_for_label in group_weights.items():
            weight_rows.extend({"scope": label, **entry} for entry in group_weights_for_label)
    pd.DataFrame(weight_rows).to_csv(weights_path, index=False, encoding="utf-8")

    result = {
        "success": True,
        "protocolVersion": 1,
        "method": method,
        "backend": "numpy-pandas",
        "rowsInput": int(len(frame)),
        "rowsUsed": int(len(frame)),
        "scope": scope,
        "groupCount": 1 if scope == "global" else len(diagnostics),
        "weightSource": source_used,
        "weights": weights_for_result,
        "groupWeights": group_weights if scope == "by_group" else None,
        "scoreColumn": score_column,
        "rankColumn": rank_column,
        "diagnostics": diagnostics,
        "top": top,
        "bottom": bottom,
        "topByGroup": top_by_group,
        "warnings": [],
        "scoresPath": str(scores_path),
        "weightsPath": str(weights_path),
        "resultPath": str(result_path),
    }
    with result_path.open("w", encoding="utf-8") as handle:
        json.dump(json_safe(result), handle, ensure_ascii=False, allow_nan=False, indent=2)
    return json_safe(result)


def main() -> None:
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
        if not isinstance(payload, dict):
            raise ValueError("输入必须是 JSON object")
        result = build_result(payload)
    except Exception as exc:  # noqa: BLE001 -- process boundary must return structured failure.
        result = {"success": False, "message": str(exc)}
    print(json.dumps(json_safe(result), ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
