from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field


class DataIssue(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    code: str
    severity: Literal["info", "warning", "blocking"]
    summary_zh: str
    evidence: dict[str, Any] = Field(default_factory=dict)


class MethodCompatibility(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    method_id: str
    status: Literal["compatible", "repairable", "requires_semantic_input", "incompatible"]
    reasons_zh: list[str] = Field(default_factory=list)
    required_repairs: list[str] = Field(default_factory=list)


class DataDiagnosisReport(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    version: Literal[1] = 1
    dataset_id: str
    stage_id: str
    data_fingerprint: str
    rows: int = Field(ge=0)
    columns: list[str]
    issues: list[DataIssue] = Field(default_factory=list)
    panel_candidates: list[dict[str, Any]] = Field(default_factory=list)
    method_compatibility: list[MethodCompatibility] = Field(default_factory=list)
    recommended_method_ids: list[str] = Field(default_factory=list, max_length=3)


class RepairOption(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    repair_id: str
    label_zh: str
    description_zh: str
    affected_columns: list[str] = Field(default_factory=list)
    row_impact: dict[str, Any] = Field(default_factory=dict)
    semantic_impact: Literal["none", "measurement", "sample", "identification"]
    requires_confirmation: bool
    resulting_method_ids: list[str] = Field(default_factory=list)


class MethodPreflightResult(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    method_id: str
    executable: bool
    status: Literal["ready", "repairable", "requires_user_decision", "incompatible"]
    normalized_arguments: dict[str, Any]
    data_fingerprint: str
    issues: list[DataIssue] = Field(default_factory=list)
    repair_plan: list[RepairOption] = Field(default_factory=list)
