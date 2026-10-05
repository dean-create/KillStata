from __future__ import annotations

import os
import runpy
from pathlib import Path
from typing import Any

from .errors import EngineError


IN_PROCESS_ENTRYPOINTS: dict[str, tuple[str, str]] = {
    "panel_fe_regression": ("panel_fe/runner.py", "build_result"),
    "panel_random_effects": ("panel/runner.py", "build_result"),
    "iv_2sls": ("iv/runner.py", "build_result"),
    "iv_test": ("iv_test/runner.py", "build_result"),
    "hdfe_regression": ("pyfixest/runner.py", "run_hdfe"),
    "did_static": ("pyfixest/runner.py", "run_static_did"),
    "did2s": ("pyfixest/runner.py", "run_did2s"),
    "did_event_study_saturated": ("pyfixest/runner.py", "run_saturated_event_study"),
    "psm_construction": ("psm/runner.py", "run_psm_construction"),
    "psm_visualize": ("psm/runner.py", "run_psm_visualize"),
    "psm_matching": ("psm/runner.py", "run_psm_matching"),
    "psm_ipw": ("psm/runner.py", "run_psm_ipw"),
    "psm_regression": ("psm/runner.py", "run_psm_regression"),
    "psm_double_robust": ("psm/runner.py", "run_psm_double_robust"),
    "logit_regression": ("glm/runner.py", "build_result"),
    "probit_regression": ("glm/runner.py", "build_result"),
    "poisson_regression": ("count/runner.py", "build_result"),
    "negbin_regression": ("count/runner.py", "build_result"),
    "quantile_regression": ("quantile/runner.py", "build_result"),
    "rdd_sharp": ("rdd/runner.py", "build_result"),
    "rdd_fuzzy": ("rdd/runner.py", "build_result"),
    "multinomial_logit": ("multinomial/runner.py", "build_result"),
    "robust_regression": ("rlm/runner.py", "build_result"),
    "wls_regression": ("wls/runner.py", "build_result"),
    "composite_evaluation": ("mcda/runner.py", "build_result"),
    "data_import": ("data_import/runner.py", "execute"),
    "data_preprocess": ("preprocess/runner.py", "execute"),
    "econometrics_recommend": ("recommend/runner.py", "execute"),
    "heterogeneity_runner": ("heterogeneity/runner.py", "execute"),
}

_LOADED_RUNNER_NAMESPACES: dict[str, dict[str, Any]] = {}


def engine_python_root() -> Path:
    configured = os.environ.get("KILLSTATA_ENGINE_METHOD_ROOT", "").strip()
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parents[2] / "python"


def _in_process_result(method_id: str, request: dict[str, Any]) -> dict[str, Any] | None:
    entrypoint = IN_PROCESS_ENTRYPOINTS.get(method_id)
    if entrypoint is None:
        return None
    relative, function_name = entrypoint
    runner = engine_python_root() / relative
    if not runner.is_file():
        raise EngineError("ENGINE_ASSET_MISSING", f"方法执行文件不存在：{method_id}。", method_id=method_id)
    namespace = _LOADED_RUNNER_NAMESPACES.get(str(runner))
    if namespace is None:
        namespace = runpy.run_path(str(runner), run_name=f"killstata_engine_{method_id}")
        _LOADED_RUNNER_NAMESPACES[str(runner)] = namespace
    handler = namespace.get(function_name)
    if not callable(handler):
        raise EngineError("METHOD_HANDLER_MISSING", f"方法没有可调用的 Registry handler：{method_id}。", method_id=method_id)
    try:
        result = handler(request)
    except EngineError:
        raise
    except Exception as error:
        backend_code = getattr(error, "code", None)
        if isinstance(backend_code, str):
            raise EngineError(
                "INVALID_ARGUMENT" if backend_code.startswith("INVALID") or backend_code in {"UNKNOWN_METHOD", "COLUMN_COLLISION"} else "METHOD_EXECUTION_FAILED",
                str(error) or f"方法执行失败：{method_id}。",
                method_id=method_id,
                details={"backend_code": backend_code},
            ) from error
        raise
    if not isinstance(result, dict):
        raise EngineError("INVALID_METHOD_RESULT", f"方法返回结构不是 JSON 对象：{method_id}。", method_id=method_id)
    if result.get("success") is False:
        raise EngineError("METHOD_EXECUTION_FAILED", str(result.get("message") or result.get("error") or f"方法执行失败：{method_id}。"), method_id=method_id)
    if method_id in {"hdfe_regression", "did_static", "did2s", "did_event_study_saturated"}:
        persist = namespace.get("persist")
        if callable(persist):
            result = persist(result, request)
    return result


def execute_registered_method(method_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    # 所有已登记方法都必须在同一个引擎进程内执行；没有显式入口时立即失败，
    # 不退回“每次调用再启动一个 runner”的旧路径。
    if method_id == "ols_regression":
        from .methods.ols import run

        return run(payload)

    # 引擎协议使用 snake_case；计算模块内部的历史 camelCase 字段只在这里转换。
    arguments = payload.get("arguments")
    request = {
        "method": method_id,
        "dataPath": payload.get("data_path"),
        "outputDir": payload.get("output_dir"),
        **(arguments if isinstance(arguments, dict) else {}),
    }
    result = _in_process_result(method_id, request)
    if result is None:
        raise EngineError("METHOD_NOT_IMPLEMENTED", f"方法已登记但没有长驻入口：{method_id}。", method_id=method_id)
    return result
