"""Deterministic statsmodels RLM adapter for KillStata model-facing tools.

对连续结果变量做稳健线性回归（M-估计），它在 OLS 的基础上用迭代重加权最小二乘
来抑制离群值的影响——每个观测得到一个有效性权重，极端点的权重被自动降低。
返回系数（与 OLS 同一尺度，可直接比较）、scale 估计、每个观测的权重以及
降权诊断。

为什么不塞进 OLS 那个 runner：
- RLM 需要多选 psi 函数和额外输出（权重、scale、降权诊断）
- 同一个 tool 路径两种行为会让结果契约膨胀
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import statsmodels
import statsmodels.api as sm

PSI_FUNCTIONS: dict[str, Any] = {
    "huber": sm.robust.norms.HuberT,
    "hampel": sm.robust.norms.Hampel,
    "tukey": sm.robust.norms.TukeyBiweight,
}


def scalar(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (np.integer, np.floating)):
        value = value.item()
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def json_safe(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (np.integer, np.floating)):
        value = value.item()
    if isinstance(value, float):
        return None if (value != value or value == float("inf") or value == -float("inf")) else value
    return value


def load_frame(data_path: str) -> pd.DataFrame:
    suffix = Path(data_path).suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(data_path)
    if suffix in {".xlsx", ".xls"}:
        return pd.read_excel(data_path)
    if suffix == ".dta":
        return pd.read_stata(data_path)
    if suffix == ".parquet":
        return pd.read_parquet(data_path)
    raise ValueError(f"不支持的数据格式：{suffix or '未知格式'}")


def prepare_frame(payload: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, str], list[str], int]:
    frame = load_frame(payload["dataPath"])
    if frame.columns.duplicated().any():
        duplicated = frame.columns[frame.columns.duplicated()].tolist()
        raise ValueError(f"数据中存在重复列名：{', '.join(map(str, duplicated))}")

    columns: list[str] = [payload["dependentVar"], payload["treatmentVar"], *payload.get("covariates", [])]
    seen: dict[str, None] = {}
    for name in columns:
        seen.setdefault(name, None)
    columns = list(seen.keys())

    missing = [name for name in columns if name not in frame.columns]
    if missing:
        raise ValueError(f"数据中找不到变量：{', '.join(missing)}")

    rows_input = int(len(frame))
    frame = frame.loc[:, columns].dropna().copy()
    if frame.empty:
        raise ValueError("所选变量删除缺失值后没有可用样本")

    aliases = {name: f"v_{index}" for index, name in enumerate(columns)}
    frame = frame.rename(columns=aliases)
    regressor_names = [payload["treatmentVar"], *payload.get("covariates", [])]
    return frame, aliases, regressor_names, rows_input


def require_numeric(frame: pd.DataFrame, aliases: dict[str, str], names: list[str]) -> None:
    invalid = [name for name in names if not pd.api.types.is_numeric_dtype(frame[aliases[name]])]
    if invalid:
        raise ValueError(f"以下变量必须是数值型：{', '.join(invalid)}")


def build_result(payload: dict[str, Any]) -> dict[str, Any]:
    method = payload["method"]
    frame, aliases, regressor_names, rows_input = prepare_frame(payload)

    require_numeric(frame, aliases, [payload["dependentVar"], *regressor_names])
    if not np.isfinite(frame.to_numpy(dtype=float)).all():
        raise ValueError("因变量或解释变量包含非有限值（inf/-inf），请先清洗数据")

    y = frame[aliases[payload["dependentVar"]]].astype(float)
    # 连续结果校验：不能是常数/二元，必须体现连续变异
    if y.nunique() < 5:
        raise ValueError("因变量取值过于集中（少于 5 个不同值），不适合连续回归")
    if set(pd.unique(y.to_numpy())) == {0.0, 1.0}:
        raise ValueError("因变量似乎是二元 0/1 变量，建议使用 Logit/Probit 而非稳健回归")

    design_names = [aliases[name] for name in regressor_names]
    exog = sm.add_constant(frame[design_names].astype(float), has_constant="add")
    if len(exog) <= exog.shape[1]:
        raise ValueError("样本量相对解释变量个数过少，无法稳定估计")

    rank = int(np.linalg.matrix_rank(exog.to_numpy(dtype=float)))
    if rank < exog.shape[1]:
        raise ValueError(f"设计矩阵秩亏（rank={rank}，列数={exog.shape[1]}），存在完全共线性")

    psi_name = payload.get("psi", "huber")
    PsiClass = PSI_FUNCTIONS.get(psi_name)
    if PsiClass is None:
        raise ValueError(f"不支持的 psi 函数：{psi_name}，可选：{', '.join(PSI_FUNCTIONS.keys())}")
    psi = PsiClass()

    covariance = payload.get("covariance", "HC1")
    # RLM 的默认推断就是 HC1(异方差稳健),不支持 nonrobust——稳健回归不带稳健标准误
    # 就没有意义了。和 OLS 的 nonrobust 不同,RLM 始终使用 HC1 或更强的标准误。
    if covariance != "robust":
        raise ValueError("稳健回归必须使用稳健标准误（covariance='robust'）：HC1 类型，这是 RLM 的最小推断标准")

    try:
        model = sm.RLM(y, exog, M=psi)
        fit = model.fit(maxiter=200)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"稳健回归估计失败：{exc}") from exc

    # 检查收敛：通过 deviance 的最后变化来判断(RLM fit_history 无 iteration 键)
    n_iter = len(fit.fit_history.get("deviance", [])) - 1  # deviance 比 params 少一步
    if n_iter >= 199:
        raise ValueError("稳健回归迭代未收敛（已达最大迭代次数），结果不可信；请检查数据")
    # 检查末段参数变化是否已收敛
    params_hist = fit.fit_history.get("params", [])
    if len(params_hist) >= 4:
        recent_changes = np.max(np.abs(np.diff(params_hist[-4:], axis=0)), axis=1)
        if np.max(recent_changes) > 1e-3:
            raise ValueError(f"稳健回归参数未稳定收敛（末段最大参数变化 {np.max(recent_changes):.2e}），结果不可信")

    # 提取最终迭代的权重——每个观测的稳健性权重
    # statsmodels RLM 的 weight_history[-1] 是最终权重的 ndarray
    weights_array = np.asarray(fit.model.weights if hasattr(fit.model, "weights") else fit.fit_history["weights"][-1], dtype=float)
    weights_array = np.where(np.isfinite(weights_array), weights_array, 0.0)

    # 降权诊断：权重 < 0.5 的观测数
    down_weighted_mask = weights_array < 0.5
    down_weighted_count = int(down_weighted_mask.sum())
    down_weighted_pct = round(down_weighted_count / len(weights_array) * 100, 1)

    alias_to_original = {alias: original for original, alias in aliases.items()}

    def term_label(alias: str) -> str:
        if alias == "const":
            return "const"
        return alias_to_original.get(alias, alias)

    conf_int = fit.conf_int()
    coefficients: list[dict[str, Any]] = []
    for alias in exog.columns:
        coefficients.append(
            {
                "term": term_label(alias),
                "estimate": scalar(fit.params[alias]),
                "stdError": json_safe(fit.bse[alias]),
                "statistic": json_safe(fit.tvalues[alias]),
                "pValue": json_safe(fit.pvalues[alias]),
                "confLow": json_safe(conf_int.loc[alias, 0]) if alias in conf_int.index else None,
                "confHigh": json_safe(conf_int.loc[alias, 1]) if alias in conf_int.index else None,
            }
        )

    treatment_term = payload["treatmentVar"]
    primary_coefficient = next((c for c in coefficients if c["term"] == treatment_term), None)

    rows_used = int(fit.nobs)
    scale_estimate = json_safe(fit.scale)

    warnings: list[str] = []
    if down_weighted_pct > 5:
        warnings.append(
            f"检测到 {down_weighted_count} 个观测（{down_weighted_pct}%）的有效性权重低于 0.5，"
            f"说明数据存在不可忽视的影响点/离群值；OLS 系数可能因此有偏"
        )
    if scale_estimate is not None and scale_estimate > 2.0:
        warnings.append(f"残差尺度估计较大（scale≈{scale_estimate:.2f}），注意 RLM 的推断可能偏保守")

    result = {
        "success": True,
        "method": method,
        "backend": "statsmodels",
        "statsmodelsVersion": statsmodels.__version__,
        "rowsInput": rows_input,
        "rowsUsed": rows_used,
        "droppedRows": rows_input - rows_used,
        "psi": psi_name,
        "covariance": "HC1",  # RLM 永远使用 HC1 稳健标准误
        "scale": scale_estimate,
        "meanOutcome": json_safe(float(y.mean())),
        "logLikelihood": None,  # RLM 不直接返回 LL
        "pseudoRSquared": None,
        "coefficients": coefficients,
        "primary": primary_coefficient,
        "downWeightedCount": down_weighted_count,
        "downWeightedPct": down_weighted_pct,
        "warnings": warnings,
    }

    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    result_path = output_dir / "results.json"
    coefficients_path = output_dir / "coefficients.csv"
    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    pd.DataFrame(coefficients).to_csv(coefficients_path, index=False, encoding="utf-8-sig")
    result["resultPath"] = str(result_path)
    result["coefficientsPath"] = str(coefficients_path)
    return result


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
        if payload.get("method") not in {"robust_regression", "rlm_regression"}:
            raise ValueError(f"不支持的方法：{payload.get('method')}")
        result = build_result(payload)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        return
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
