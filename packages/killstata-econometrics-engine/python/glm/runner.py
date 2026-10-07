"""Deterministic statsmodels GLM adapter for KillStata model-facing tools.

处理二元结果变量的 Logit / Probit 最大似然估计。与 PyFixest 适配器同构：
模型只发结构化字段（因变量、核心解释变量、控制变量、协方差选择），绝不发公式；
本适配器验证列、二元编码、秩与分离，构造安全公式，调用 statsmodels，
计算平均边际效应（AME），并在 stdout 输出单行 JSON 结果。

平均边际效应是 Logit/Probit 真正可解释的量：系数本身是对数几率/潜变量尺度，
不能直接当"处理效应"读；AME 才是概率尺度上的边际变化，也是 Stata `margins, dydx(*)`
的默认输出。
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
from statsmodels.tools.sm_exceptions import PerfectSeparationError

METHODS = {
    "logit_regression": sm.Logit,
    "probit_regression": sm.Probit,
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
    # 去重但保序：因变量、核心解释变量、控制变量
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
    # 解释变量顺序：核心解释变量在前，控制变量随后
    regressor_names = [payload["treatmentVar"], *payload.get("covariates", [])]
    return frame, aliases, regressor_names, rows_input


def require_numeric(frame: pd.DataFrame, aliases: dict[str, str], names: list[str]) -> None:
    invalid = [name for name in names if not pd.api.types.is_numeric_dtype(frame[aliases[name]])]
    if invalid:
        raise ValueError(f"以下变量必须是数值型：{', '.join(invalid)}")


def build_result(payload: dict[str, Any]) -> dict[str, Any]:
    method = payload["method"]
    estimator = METHODS[method]
    frame, aliases, regressor_names, rows_input = prepare_frame(payload)

    require_numeric(frame, aliases, [payload["dependentVar"], *regressor_names])
    if not np.isfinite(frame.to_numpy(dtype=float)).all():
        raise ValueError("因变量或解释变量包含非有限值（inf/-inf），请先清洗数据")

    y = frame[aliases[payload["dependentVar"]]].astype(float)
    y_values = set(pd.unique(y).tolist())
    if y_values != {0.0, 1.0}:
        raise ValueError("因变量必须是二元 0/1 编码，且两类都要出现；Logit/Probit 不适用于连续或多值结果变量")

    design_names = [aliases[name] for name in regressor_names]
    exog = sm.add_constant(frame[design_names].astype(float), has_constant="add")
    if len(exog) <= exog.shape[1]:
        raise ValueError("样本量相对解释变量个数过少，无法稳定估计")

    rank = int(np.linalg.matrix_rank(exog.to_numpy(dtype=float)))
    if rank < exog.shape[1]:
        raise ValueError(f"设计矩阵秩亏（rank={rank}，列数={exog.shape[1]}），存在完全共线性，请删除重复或线性组合变量")

    covariance = payload.get("covariance", "nonrobust")
    cov_type = "HC1" if covariance == "robust" else "nonrobust"

    try:
        model = estimator(y, exog)
        fit = model.fit(disp=False, maxiter=200, cov_type=cov_type)
    except PerfectSeparationError as exc:  # noqa: PERF203
        raise ValueError("数据存在完全分离（某些解释变量可完美预测结果），最大似然不收敛，请检查变量或样本") from exc
    except np.linalg.LinAlgError as exc:
        raise ValueError("估计过程矩阵奇异，请检查解释变量的共线性") from exc

    if not bool(getattr(fit, "mle_retvals", {}).get("converged", True)):
        raise ValueError("最大似然迭代未收敛，结果不可信；请检查数据分离或共线性")

    predicted = np.asarray(fit.predict(exog), dtype=float)
    if not np.isfinite(predicted).all() or np.any(predicted <= 0.0) or np.any(predicted >= 1.0):
        raise ValueError("预测概率落到 0/1 边界，通常意味着分离，估计不可靠")

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
                "stdError": scalar(fit.bse[alias]),
                "statistic": scalar(fit.tvalues[alias]),
                "pValue": scalar(fit.pvalues[alias]),
                "confLow": scalar(conf_int.loc[alias, 0]),
                "confHigh": scalar(conf_int.loc[alias, 1]),
            }
        )

    # 平均边际效应（概率尺度）——Logit/Probit 的可解释输出，对应 Stata margins, dydx(*)
    margeff = fit.get_margeff(at="overall")
    margeff_frame = margeff.summary_frame()
    marginal_effects: list[dict[str, Any]] = []
    for alias, row in margeff_frame.iterrows():
        marginal_effects.append(
            {
                "term": term_label(str(alias)),
                "estimate": scalar(row.get("dy/dx")),
                "stdError": scalar(row.get("Std. Err.")),
                "pValue": scalar(row.get("Pr(>|z|)")),
            }
        )

    treatment_alias = aliases[payload["treatmentVar"]]
    primary_coefficient = next((c for c in coefficients if c["term"] == payload["treatmentVar"]), None)
    primary_margin = next((m for m in marginal_effects if m["term"] == payload["treatmentVar"]), None)

    rows_used = int(fit.nobs)
    outcome_rate = float(y.mean())
    warnings: list[str] = []
    minority = min(outcome_rate, 1 - outcome_rate)
    if minority * rows_used < 10:
        warnings.append(
            f"结果变量较少一类仅约 {round(minority * rows_used)} 个观测，最大似然估计可能不稳定（经验法则每个参数需要约 10 个）"
        )

    result = {
        "success": True,
        "method": method,
        "backend": "statsmodels",
        "statsmodelsVersion": statsmodels.__version__,
        "rowsInput": rows_input,
        "rowsUsed": rows_used,
        "droppedRows": rows_input - rows_used,
        "covariance": cov_type,
        "outcomeRate": outcome_rate,
        "logLikelihood": scalar(fit.llf),
        "pseudoRSquared": scalar(fit.prsquared),
        "coefficients": coefficients,
        "marginalEffects": marginal_effects,
        "primary": primary_coefficient,
        "primaryMarginalEffect": primary_margin,
        "warnings": warnings,
    }

    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    result_path = output_dir / "results.json"
    coefficients_path = output_dir / "coefficients.csv"
    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    pd.DataFrame(coefficients).to_csv(coefficients_path, index=False, encoding="utf-8-sig")
    # 不要用 .resolve()：macOS 上它会把 /var 符号链接解析成 /private/var，
    # 而 TS 侧 path.resolve 不解析符号链接，两者对不上会误判"不可信路径"。
    result["resultPath"] = str(result_path)
    result["coefficientsPath"] = str(coefficients_path)
    return result


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
        if payload.get("method") not in METHODS:
            raise ValueError(f"不支持的方法：{payload.get('method')}")
        result = build_result(payload)
    except Exception as exc:  # noqa: BLE001 —— 统一转成结构化失败，绝不把 traceback 泄漏到对话
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        return
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
