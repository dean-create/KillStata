from __future__ import annotations

import json
import math
import os
import platform
import shutil
import sys
import tempfile
from collections.abc import Callable, Iterator
from contextlib import contextmanager, nullcontext
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from .errors import EngineError, classify_exception
from .preflight import preflight_method
from .result_models import CapabilityResult
from .registry import REGISTRY_VERSION, describe_method, get_method, method_catalog, search_methods

PROTOCOL_VERSION = 2
SUPPORTED_PROTOCOL_VERSIONS = {1, PROTOCOL_VERSION}


@contextmanager
def _execution_snapshot(data_path: str) -> Iterator[str]:
    """Copy one stable source-file version for preflight and the estimator to share."""
    source = Path(data_path)
    try:
        if not source.is_file():
            raise EngineError("DATA_FILE_NOT_FOUND", "当前数据阶段文件不存在，未创建执行快照。", field="data_path")
        temporary_directory = tempfile.TemporaryDirectory(prefix="killstata-execution-snapshot-")
    except EngineError:
        raise
    except OSError as error:
        raise EngineError(
            "DATA_SNAPSHOT_FAILED",
            "无法创建本次执行用的数据快照；估计器没有运行。请检查数据文件读取权限和可用磁盘空间。",
            field="data_path",
            details={"io_error": str(error)},
        ) from error

    with temporary_directory as directory:
        snapshot = Path(directory) / f"input{source.suffix}"
        try:
            with source.open("rb") as source_file, snapshot.open("xb") as snapshot_file:
                before = os.fstat(source_file.fileno())
                shutil.copyfileobj(source_file, snapshot_file)
                snapshot_file.flush()
                after = os.fstat(source_file.fileno())
        except OSError as error:
            raise EngineError(
                "DATA_SNAPSHOT_FAILED",
                "无法创建本次执行用的数据快照；估计器没有运行。请检查数据文件读取权限和可用磁盘空间。",
                field="data_path",
                details={"io_error": str(error)},
            ) from error
        before_state = (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
        after_state = (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
        if before_state != after_state:
            raise EngineError(
                "DATA_SNAPSHOT_UNSTABLE",
                "当前数据文件在创建执行快照时发生变化；估计器没有运行。请等待数据写入完成，再刷新诊断并重新准备规格。",
                field="data_path",
            )
        yield str(snapshot)


def _success(request_id: str, result: dict[str, Any], protocol_version: int = PROTOCOL_VERSION) -> dict[str, Any]:
    return {"protocol_version": protocol_version, "request_id": request_id, "type": "result", "ok": True, "result": result}


def _failure(request_id: str, error: EngineError, protocol_version: int = PROTOCOL_VERSION) -> dict[str, Any]:
    return {"protocol_version": protocol_version, "request_id": request_id, "type": "error", "ok": False, "error": error.as_dict()}


def _json_safe(value: Any) -> Any:
    """递归清理协议帧中的非 JSON 值，避免错误响应导致 JSONL 进程崩溃。"""
    if isinstance(value, BaseException):
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {key: _json_safe(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [_json_safe(item) for item in value]
    return value


def _validation_error_message(path: str, issue: dict[str, Any]) -> str:
    """把 Pydantic 的机器错误转成模型和用户都能执行下一步的中文提示。"""
    error_type = issue.get("type")
    value = issue.get("input")
    if error_type == "missing":
        return f"缺少必填参数：{path}。"
    if error_type == "extra_forbidden":
        return f"参数包含未定义字段：{path}。请按 describe 返回的 Schema 删除该字段，不要猜测方法参数。"
    if error_type in {"string_type", "string_sub_type"}:
        return f"参数 {path} 类型错误，应为字符串。"
    if error_type in {"list_type", "list_sub_type"}:
        return f"参数 {path} 类型错误，应为数组。"
    if error_type in {"dict_type", "dict_sub_type"}:
        return f"参数 {path} 类型错误，应为对象。"
    if error_type in {"bool_type", "bool_parsing"}:
        return f"参数 {path} 类型错误，应为布尔值 true 或 false。"
    if error_type in {"int_type", "int_parsing"}:
        return f"参数 {path} 类型错误，应为整数。"
    if error_type in {"float_type", "float_parsing"}:
        return f"参数 {path} 类型错误，应为数字。"
    if error_type in {"literal_error", "enum"}:
        expected = issue.get("ctx", {}).get("expected")
        if isinstance(expected, str):
            expected = expected.replace("'", "").replace(", ", "、").replace(" or ", "、")
        return f"参数 {path} 取值不受支持：{value!r}。允许值为：{expected or '请以 describe 返回的枚举为准'}。"
    if error_type == "string_too_short":
        minimum = issue.get("ctx", {}).get("min_length")
        return f"参数 {path} 长度不足，至少需要 {minimum} 个字符。"
    if error_type == "too_short":
        minimum = issue.get("ctx", {}).get("min_length")
        return f"参数 {path} 项数不足，至少需要 {minimum} 项。"
    if error_type == "too_long":
        maximum = issue.get("ctx", {}).get("max_length")
        return f"参数 {path} 最多允许 {maximum} 项。"
    return f"参数 {path} 不符合方法 Schema：{issue.get('msg', '请核对字段、类型和取值')}。"


def _validate_arguments(
    method_id: str,
    arguments: dict[str, Any],
    runtime: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """分离不可信模型参数与 Harness 注入字段，再由 Registry Pydantic 统一校验。"""
    spec = get_method(method_id)
    runtime_fields = set(spec.runtime_injected_fields)
    model_runtime_fields = set(arguments) & runtime_fields
    if model_runtime_fields:
        field = sorted(model_runtime_fields)[0]
        raise EngineError(
            "INVALID_ARGUMENT",
            f"arguments 不得包含由 Harness 注入的 runtime 字段：{field}。",
            method_id=method_id,
            field=field,
        )
    runtime = runtime or {}
    unexpected_runtime_fields = set(runtime) - runtime_fields
    if unexpected_runtime_fields:
        field = sorted(unexpected_runtime_fields)[0]
        raise EngineError(
            "INVALID_ARGUMENT",
            f"Harness runtime 包含方法未声明的字段：{field}。",
            method_id=method_id,
            field=field,
        )
    validation_arguments = {**arguments, **runtime}
    try:
        validated = spec.input_model.model_validate(validation_arguments)
    except ValidationError as error:
        issue = error.errors()[0]
        path = ".".join(str(part) for part in issue.get("loc", ())) or "arguments"
        field = path.split(".", 1)[0]
        raise EngineError(
            "INVALID_ARGUMENT",
            _validation_error_message(path, issue),
            method_id=method_id,
            field=field,
            details={"validation_errors": error.errors()},
        ) from error
    # 默认值进入执行 payload，None 不进入，避免给旧 runner 注入无意义字段。
    return validated.model_dump(exclude_none=True)


def handle_request(
    request: dict[str, Any],
    emit_progress: Callable[[dict[str, Any]], None] | None = None,
) -> dict[str, Any]:
    request_id = str(request.get("request_id", ""))
    requested_version = request.get("protocol_version")
    protocol_version = (
        requested_version
        if isinstance(requested_version, int) and not isinstance(requested_version, bool) and requested_version in SUPPORTED_PROTOCOL_VERSIONS
        else PROTOCOL_VERSION
    )
    if not request_id:
        return _failure("", EngineError("INVALID_REQUEST", "请求缺少 request_id。"), protocol_version)
    if requested_version not in SUPPORTED_PROTOCOL_VERSIONS:
        return _failure(request_id, EngineError("PROTOCOL_VERSION_UNSUPPORTED", f"不支持的引擎协议版本：{request.get('protocol_version')}。"), protocol_version)
    operation = request.get("operation")
    payload = request.get("payload")
    if not isinstance(payload, dict):
        return _failure(request_id, EngineError("INVALID_REQUEST", "payload 必须是 JSON 对象。"), protocol_version)
    try:
        if operation == "health":
            return _success(request_id, {
                "protocol_version": protocol_version,
                "registry_version": REGISTRY_VERSION,
                "python_version": platform.python_version(),
                "engine": "killstata-econometrics-engine",
                "method_count": len(method_catalog()),
            }, protocol_version)
        if operation == "catalog":
            return _success(request_id, {"registry_version": REGISTRY_VERSION, "methods": method_catalog()}, protocol_version)
        if operation == "search":
            query = payload.get("query")
            if not isinstance(query, str):
                raise EngineError("INVALID_ARGUMENT", "search 的 query 必须是字符串。", field="query")
            limit = payload.get("limit", 3)
            if not isinstance(limit, int) or isinstance(limit, bool):
                raise EngineError("INVALID_ARGUMENT", "search 的 limit 必须是整数。", field="limit")
            matches = search_methods(query, limit)
            return _success(request_id, {
                "registry_version": REGISTRY_VERSION,
                "methods": [describe_method(item["method_id"]) for item in matches],
            }, protocol_version)
        if operation == "describe":
            method_id = payload.get("method_id")
            if not isinstance(method_id, str) or not method_id.strip():
                raise EngineError("INVALID_ARGUMENT", "describe 的 method_id 不能为空。", field="method_id")
            return _success(request_id, describe_method(method_id.strip()), protocol_version)
        if operation == "validate":
            method_id = payload.get("method_id")
            if not isinstance(method_id, str) or not method_id.strip():
                raise EngineError("INVALID_ARGUMENT", "validate 的 method_id 不能为空。", field="method_id")
            arguments = payload.get("arguments")
            if not isinstance(arguments, dict):
                raise EngineError("INVALID_ARGUMENT", "validate 的 arguments 必须是 JSON 对象。", method_id=method_id, field="arguments")
            runtime = payload.get("runtime", {})
            if not isinstance(runtime, dict):
                raise EngineError("INVALID_ARGUMENT", "validate 的 runtime 必须是 JSON 对象。", method_id=method_id, field="runtime")
            normalized = _validate_arguments(method_id.strip(), arguments, runtime)
            spec = get_method(method_id.strip())
            return _success(request_id, {
                "registry_version": REGISTRY_VERSION,
                "method_id": method_id.strip(),
                "arguments": {key: value for key, value in normalized.items() if key not in spec.runtime_injected_fields},
            }, protocol_version)
        if operation == "preflight":
            method_id = payload.get("method_id")
            if not isinstance(method_id, str) or not method_id.strip():
                raise EngineError("INVALID_ARGUMENT", "preflight 的 method_id 不能为空。", field="method_id")
            arguments = payload.get("arguments")
            if not isinstance(arguments, dict):
                raise EngineError("INVALID_ARGUMENT", "preflight 的 arguments 必须是 JSON 对象。", method_id=method_id, field="arguments")
            runtime = payload.get("runtime", {})
            if not isinstance(runtime, dict):
                raise EngineError("INVALID_ARGUMENT", "preflight 的 runtime 必须是 JSON 对象。", method_id=method_id, field="runtime")
            normalized = _validate_arguments(method_id.strip(), arguments, runtime)
            data_path = payload.get("data_path")
            if not isinstance(data_path, str) or not data_path.strip():
                raise EngineError("INVALID_ARGUMENT", "preflight 的 data_path 必须是非空字符串。", method_id=method_id, field="data_path")
            result = preflight_method(method_id.strip(), data_path, normalized)
            result_payload = result.model_dump(mode="json")
            spec = get_method(method_id.strip())
            result_payload["normalized_arguments"] = {
                key: value for key, value in normalized.items() if key not in spec.runtime_injected_fields
            }
            return _success(request_id, result_payload, protocol_version)
        if operation == "execute":
            method_id = payload.get("method_id")
            if not isinstance(method_id, str) or not method_id.strip():
                raise EngineError("INVALID_ARGUMENT", "execute 的 method_id 不能为空。", field="method_id")
            spec = get_method(method_id.strip())
            arguments = payload.get("arguments")
            if not isinstance(arguments, dict):
                raise EngineError("INVALID_ARGUMENT", "execute 的 arguments 必须是 JSON 对象。", method_id=method_id, field="arguments")
            runtime = payload.get("runtime", {})
            if not isinstance(runtime, dict):
                raise EngineError("INVALID_ARGUMENT", "execute 的 runtime 必须是 JSON 对象。", method_id=method_id, field="runtime")
            arguments = _validate_arguments(method_id, arguments, runtime)
            data_path = payload.get("data_path")
            output_dir = payload.get("output_dir")
            if not isinstance(data_path, str) or not data_path.strip():
                raise EngineError("INVALID_ARGUMENT", "execute 的 data_path 必须是非空字符串。", method_id=method_id, field="data_path")
            if not isinstance(output_dir, str) or not output_dir.strip():
                raise EngineError("INVALID_ARGUMENT", "execute 的 output_dir 必须是非空字符串。", method_id=method_id, field="output_dir")
            expected_fingerprint = payload.get("expected_data_fingerprint")
            if expected_fingerprint is not None and (
                not isinstance(expected_fingerprint, str) or
                not expected_fingerprint.startswith("sha256:") or
                len(expected_fingerprint) != 71 or
                any(char not in "0123456789abcdef" for char in expected_fingerprint[7:])
            ):
                raise EngineError(
                    "INVALID_ARGUMENT",
                    "execute 的 expected_data_fingerprint 必须是有效的 SHA-256 数据指纹。",
                    method_id=method_id,
                    field="expected_data_fingerprint",
                )
            uses_method_preflight = spec.family in {"estimator", "diagnostic"}
            snapshot_scope = _execution_snapshot(data_path) if uses_method_preflight else nullcontext(data_path)
            with snapshot_scope as execution_data_path:
                if uses_method_preflight:
                    execution_preflight = preflight_method(method_id.strip(), execution_data_path, arguments)
                    if expected_fingerprint is not None and execution_preflight.data_fingerprint != expected_fingerprint:
                        raise EngineError(
                            "DATA_FINGERPRINT_MISMATCH",
                            "执行阶段快照的数据内容与 PreparedSpec 绑定的指纹不同；本次没有调用计量方法。",
                            method_id=method_id,
                            details={
                                "expected_data_fingerprint": expected_fingerprint,
                                "actual_data_fingerprint": execution_preflight.data_fingerprint,
                            },
                        )
                    if not execution_preflight.executable:
                        summaries = [
                            issue.summary_zh
                            for issue in execution_preflight.issues[:5]
                            if issue.summary_zh
                        ]
                        primary_issue = next(
                            (issue for issue in execution_preflight.issues if issue.severity == "blocking"),
                            execution_preflight.issues[0] if execution_preflight.issues else None,
                        )
                        error_code = primary_issue.code if primary_issue is not None else "PREFLIGHT_BLOCKED"
                        raise EngineError(
                            error_code,
                            "估计器执行前的 Python preflight 未通过；本次没有调用计量方法。" +
                            ("原因：" + "；".join(summaries) if summaries else ""),
                            method_id=method_id,
                            details={"preflight": execution_preflight.model_dump(mode="json")},
                        )
                execution_payload = {
                    "data_path": execution_data_path,
                    "output_dir": output_dir,
                    "arguments": arguments,
                }
                if emit_progress is not None:
                    emit_progress({"label_zh": f"正在执行 {method_id}", "status": "running"})
                # 方法依赖按调用懒加载。健康检查、目录搜索和提示词装配不应因为
                # 本机尚未安装科学计算依赖而整体失效；算法入口由 Registry 统一绑定。
                method_result = spec.handler(execution_payload)
            envelope = CapabilityResult(
                method_id=method_id,
                schema_version=REGISTRY_VERSION,
                success=True,
                payload=method_result,
                diagnostics={"warnings": method_result.get("warnings", [])},
                artifacts=[
                    *([{"kind": "result", "path": method_result["resultPath"]}] if method_result.get("resultPath") else []),
                    *([{"kind": "coefficients", "path": method_result["coefficientsPath"]}] if method_result.get("coefficientsPath") else []),
                    *([{"kind": "propensity_scores", "path": method_result["propensityScoresPath"]}] if method_result.get("propensityScoresPath") else []),
                    *([{"kind": "plot", "path": method_result["plotPath"]}] if method_result.get("plotPath") else []),
                    *([{"kind": "data", "path": method_result["dataPath"]}] if method_result.get("dataPath") else []),
                    *([{"kind": "schema", "path": method_result["schemaPath"]}] if method_result.get("schemaPath") else []),
                    *([{"kind": "output", "path": method_result["output_path"]}] if method_result.get("output_path") else []),
                    *method_result.get("artifacts", []),
                ],
                warnings=method_result.get("warnings", []),
            )
            result = _success(request_id, {
                **envelope.model_dump(mode="json"),
            }, protocol_version)
            if emit_progress is not None:
                emit_progress({"label_zh": f"已完成 {method_id}", "status": "completed"})
            return result
        raise EngineError("OPERATION_NOT_FOUND", f"不支持的引擎操作：{operation}。")
    except Exception as error:
        return _failure(request_id, classify_exception(error, method_id=payload.get("method_id") if isinstance(payload.get("method_id"), str) else None), protocol_version)


def run_jsonl() -> None:
    sequence_by_request: dict[str, int] = {}
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
            if not isinstance(request, dict):
                raise EngineError("INVALID_REQUEST", "每行请求必须是 JSON 对象。")
            request_id = str(request.get("request_id", "")) if isinstance(request, dict) else ""

            def emit_progress(event: dict[str, Any]) -> None:
                if request.get("protocol_version") != PROTOCOL_VERSION or request.get("stream_progress") is not True:
                    return
                sequence_by_request[request_id] = sequence_by_request.get(request_id, 0) + 1
                frame = {
                    "protocol_version": PROTOCOL_VERSION,
                    "request_id": request_id,
                    "type": "progress",
                    "sequence": sequence_by_request[request_id],
                    "event": _json_safe(event),
                }
                sys.stdout.write(json.dumps(frame, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
                sys.stdout.flush()

            response = handle_request(request, emit_progress=emit_progress)
        except Exception as error:
            response = _failure("", classify_exception(error), PROTOCOL_VERSION)
        sys.stdout.write(json.dumps(_json_safe(response), ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n")
        sys.stdout.flush()
