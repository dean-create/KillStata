"""统一工具描述协议。

Python 只负责领域能力的契约与执行描述；TypeScript Harness 读取这个对象，
再叠加自己的 workflow/permission admission，但不得重写 input/output schema。
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict


ToolEffect = Literal["read_only", "writes_state", "writes_files", "external"]


class ToolPermission(TypedDict):
    effect: ToolEffect
    destructive: bool
    parallel_safe: bool
    requires_confirmation: bool


class UnifiedToolDescriptor(TypedDict):
    tool_id: str
    name: str
    description: str
    input_schema: dict[str, Any]
    accepted_input_aliases: list[str]
    output_schema: dict[str, Any]
    permission: ToolPermission
    category: Literal["system", "filesystem", "data", "diagnostic", "estimator", "extension"]
    executor: Literal["python"]


def _permission_for(spec: Any) -> ToolPermission:
    if spec.family == "diagnostic":
        effect: ToolEffect = "read_only"
        parallel_safe = True
    elif spec.family == "data":
        effect = "writes_state"
        parallel_safe = False
    elif spec.family in {"estimator", "extension"}:
        effect = "writes_files"
        parallel_safe = False
    else:
        effect = "read_only"
        parallel_safe = True
    return {
        "effect": effect,
        "destructive": False,
        "parallel_safe": parallel_safe,
        # 是否需要用户确认属于 TS admission；Python 不得自行放宽权限。
        "requires_confirmation": False,
    }


def descriptor_for(spec: Any) -> UnifiedToolDescriptor:
    category = spec.family
    if category not in {"system", "filesystem", "data", "diagnostic", "estimator", "extension"}:
        category = "system"
    description = spec.description_zh
    boundaries = []
    if spec.use_when_zh:
        boundaries.append(f"适用：{spec.use_when_zh}")
    if spec.do_not_use_when_zh:
        boundaries.append(f"不适用：{spec.do_not_use_when_zh}")
    if boundaries:
        description = f"{description}\n" + "\n".join(boundaries)
    return {
        "tool_id": spec.method_id,
        "name": spec.aliases[0] if spec.aliases else spec.method_id,
        "description": description,
        "input_schema": spec.input_schema,
        "accepted_input_aliases": list(getattr(spec.input_model, "accepted_input_aliases", ())),
        "output_schema": spec.output_schema,
        "permission": _permission_for(spec),
        "category": category,
        "executor": "python",
    }
