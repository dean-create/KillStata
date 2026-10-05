from __future__ import annotations

from dataclasses import dataclass, field as dataclass_field
from typing import Any


_REPAIR_HINTS = {
    "INVALID_ARGUMENT": "只修改报错字段，并按 describe 返回的 Schema 核对字段名、类型和枚举值。",
    "DATA_FILE_NOT_FOUND": "核对当前数据阶段和受控输入文件，不要猜测新的路径。",
    "DATA_COLUMN_MISSING": "使用当前数据阶段的真实列名；若存在可能的替代列，先向用户确认变量角色。",
    "DATA_PANEL_KEY_NOT_UNIQUE": "先核验实体变量与时间变量，必要时经用户确认构造复合实体键，再重新检查。",
    "DATA_NO_USABLE_ROWS": "检查缺失值处理和变量角色，不要为了得到结果静默删除样本。",
    "DESIGN_MATRIX_RANK_DEFICIENT": "检查完全共线变量，向用户说明冲突并确认保留或移除方案。",
    "DEPENDENCY_MISSING": "先运行health检查并补齐引擎依赖，再重试失败阶段。",
    "METHOD_INPUT_INVALID": "依据错误字段核对数据前提和方法参数，只重试修正后的调用。",
    "METHOD_EXECUTION_FAILED": "先查看结构化错误和诊断，再决定修复当前参数、数据或研究设计。",
    "PREFLIGHT_BLOCKED": "依据前置诊断中的字段、证据和确认要求修正规格；研究含义变化前先询问用户，不要直接重跑执行器。",
    "DATA_FINGERPRINT_MISMATCH": "当前数据内容已不同于准备规格时的快照；刷新数据诊断并重新准备规格后再执行。",
}


@dataclass
class EngineError(Exception):
    """所有引擎错误的结构化表示；协议层只把它转成 JSON，不打印 traceback 到 stdout。"""

    code: str
    message_zh: str
    retryable: bool = False
    method_id: str | None = None
    field: str | None = None
    details: dict[str, Any] = dataclass_field(default_factory=dict)

    def __post_init__(self) -> None:
        super().__init__(self.message_zh)

    def as_dict(self) -> dict[str, Any]:
        message = self.message_zh
        if "修复建议：" not in message:
            hint = self.details.get("repair_hint_zh") or _REPAIR_HINTS.get(self.code)
            if hint:
                message = f"{message}\n修复建议：{hint}"
        return {
            "code": self.code,
            "message_zh": message,
            "retryable": self.retryable,
            "method_id": self.method_id,
            "field": self.field,
            "details": self.details,
        }


def classify_exception(error: Exception, *, method_id: str | None = None) -> EngineError:
    if isinstance(error, EngineError):
        if method_id and error.method_id is None:
            error.method_id = method_id
        return error
    if isinstance(error, ModuleNotFoundError):
        return EngineError(
            "DEPENDENCY_MISSING",
            f"当前方法缺少 Python 依赖：{error.name or '未知依赖'}。请先运行引擎 health 检查。",
            method_id=method_id,
            details={"dependency": error.name},
        )
    if isinstance(error, (FileNotFoundError, NotADirectoryError)):
        return EngineError("DATA_FILE_NOT_FOUND", "找不到计量分析输入文件，请核对当前数据阶段。", method_id=method_id)
    message = str(error)
    if "不唯一" in message and ("面板" in message or "索引" in message):
        return EngineError(
            "DATA_PANEL_KEY_NOT_UNIQUE",
            f"{message}。请先核验实体变量与时间变量，必要时构造复合实体键后重新检查。",
            method_id=method_id,
        )
    if "找不到变量" in message or "不存在的变量" in message or "missing" in message.lower():
        return EngineError("DATA_COLUMN_MISSING", f"{message}。请使用当前数据阶段真实列名，或先确认变量替换。", method_id=method_id)
    if "没有可用样本" in message or "删除缺失值后" in message:
        return EngineError("DATA_NO_USABLE_ROWS", f"{message}。请检查缺失值处理和变量角色。", method_id=method_id)
    if "设计矩阵" in message or "秩亏" in message or "full column rank" in message:
        return EngineError("DESIGN_MATRIX_RANK_DEFICIENT", f"{message}。请检查完全共线变量并确认保留方案。", method_id=method_id)
    if isinstance(error, (ValueError, TypeError, KeyError)):
        return EngineError("METHOD_INPUT_INVALID", message or "方法参数或数据不符合要求。", method_id=method_id)
    return EngineError("METHOD_EXECUTION_FAILED", str(error) or "计量方法执行失败。", method_id=method_id)
