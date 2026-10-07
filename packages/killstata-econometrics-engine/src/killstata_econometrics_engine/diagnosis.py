from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path
from typing import Any

import pandas as pd

CORE_DIR = Path(__file__).resolve().parents[2] / "python" / "econometrics"
if str(CORE_DIR) not in sys.path:
    sys.path.insert(0, str(CORE_DIR))

from data_preprocess import build_data_readiness, build_quality_report  # noqa: E402

from .readiness_models import DataDiagnosisReport, DataIssue, MethodCompatibility


def content_fingerprint(frame: pd.DataFrame) -> str:
    schema = json.dumps(
        {"columns": [str(column) for column in frame.columns], "dtypes": [str(dtype) for dtype in frame.dtypes]},
        ensure_ascii=False,
        separators=(",", ":"),
    ).encode("utf-8")
    row_hashes = pd.util.hash_pandas_object(frame, index=False, categorize=True)
    digest = hashlib.sha256(schema)
    digest.update(row_hashes.to_numpy(dtype="uint64").astype(">u8", copy=False).tobytes())
    return f"sha256:{digest.hexdigest()}"


def _issues(quality: dict[str, Any], readiness: dict[str, Any]) -> list[DataIssue]:
    issues: list[DataIssue] = []
    unusable_data = int(readiness.get("usableObservationCount", 0)) == 0
    for message in quality.get("blocking_errors", []):
        issues.append(DataIssue(
            code="DATA_NO_USABLE_OBSERVATIONS" if unusable_data else "QUALITY_BLOCKED",
            severity="blocking",
            summary_zh=str(message),
        ))
    for message in quality.get("warnings", []):
        issues.append(DataIssue(code="QUALITY_WARNING", severity="warning", summary_zh=str(message)))
    for dependency in readiness.get("exactLinearDependencies", [])[:4]:
        issues.append(DataIssue(
            code="EXACT_LINEAR_DEPENDENCY",
            severity="warning",
            summary_zh=f"检测到完全线性依赖：{dependency.get('relation', '未提供关系')}。",
            evidence={"columns": dependency.get("columns", [])},
        ))
    return issues


def _compatibility(readiness: dict[str, Any], issues: list[DataIssue]) -> list[MethodCompatibility]:
    no_usable_data = next(
        (issue for issue in issues if issue.code == "DATA_NO_USABLE_OBSERVATIONS"),
        None,
    )
    result: list[MethodCompatibility] = []
    for candidate in readiness.get("candidateMethods", []):
        method_id = str(candidate.get("methodID", ""))
        status = candidate.get("status")
        if not method_id:
            continue
        if no_usable_data:
            compatibility = "incompatible"
            reason = no_usable_data.summary_zh
        elif status == "candidate":
            compatibility = "compatible"
            reason = str(candidate.get("reason", "当前数据结构未提供详细原因。"))
        elif status == "needs_roles":
            compatibility = "requires_semantic_input"
            reason = str(candidate.get("reason", "当前数据结构未提供详细原因。"))
        else:
            compatibility = "incompatible"
            reason = str(candidate.get("reason", "当前数据结构未提供详细原因。"))
        result.append(MethodCompatibility(
            method_id=method_id,
            status=compatibility,
            reasons_zh=[reason],
            required_repairs=[] if no_usable_data else [str(item) for item in candidate.get("repairSuggestions", [])],
        ))
    return result


def diagnose_dataframe(
    frame: pd.DataFrame,
    *,
    dataset_id: str,
    stage_id: str,
) -> DataDiagnosisReport:
    """生成只读、可序列化的数据诊断；不填补、不删行、不改变输入 frame。"""
    snapshot = frame.copy(deep=True)
    readiness = build_data_readiness(snapshot)
    _, quality = build_quality_report(snapshot)
    issues = _issues(quality, readiness)
    compatibility = _compatibility(readiness, issues)
    recommended = [
        item.method_id
        for item in compatibility
        if item.status == "compatible"
    ][:3]
    return DataDiagnosisReport(
        dataset_id=dataset_id,
        stage_id=stage_id,
        data_fingerprint=content_fingerprint(snapshot),
        rows=int(len(snapshot)),
        columns=[str(column) for column in snapshot.columns],
        issues=issues,
        panel_candidates=list(readiness.get("panelCandidates", [])),
        method_compatibility=compatibility,
        recommended_method_ids=recommended,
    )
