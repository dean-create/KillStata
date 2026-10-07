from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field


class CapabilityResult(BaseModel):
    """所有 Python 能力共享的结果 envelope；方法 payload 由具体 handler 填充。"""

    model_config = ConfigDict(extra="forbid", strict=True)

    success: bool
    method_id: str
    schema_version: int = Field(ge=1)
    payload: dict[str, Any] = Field(default_factory=dict)
    diagnostics: dict[str, Any] = Field(default_factory=dict)
    artifacts: list[dict[str, Any]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
