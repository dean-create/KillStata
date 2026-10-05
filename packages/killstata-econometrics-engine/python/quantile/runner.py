"""Deterministic statsmodels quantile-regression adapter for KillStata model-facing tools.

对连续结果变量做分位数回归（Koenker & Bassett 1978）。与 GLM/count 适配器同构：
模型只发结构化字段（因变量、核心解释变量、控制变量、分位点、协方差选择），绝不发公式；
本适配器验证列、结果变异、秩与样本量，对每个分位点分别拟合 statsmodels QuantReg，
汇总各分位点的系数，并抽出核心解释变量在不同分位点上的"效应路径"——
这正是分位数回归相对 OLS 的价值：看清处理效应在结果分布不同位置的异质性。

分位数回归的系数**就是**该分位点上的边际效应（结果尺度），不需要像 Logit 那样再算
边际效应，也没有计数模型的发生率比概念。tau=0.5 是中位数回归（对异常值稳健的"均值"）。
"""

from __future__ import annotations

import json
import math
import sys
import warnings
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import statsmodels
import statsmodels.formula.api as smf


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
    # 结果变量必须有足够变异：statsmodels QuantReg 对常数/近常数因变量不会报错，
    # 而是吐 divide-by-zero 的垃圾标准误。必须在这里先拦掉。
    if y.nunique() < 5:
        raise ValueError("结果变量取值过于集中（不同取值太少），无法稳定估计分位数回归")

    quantiles = payload.get("quantiles", [0.25, 0.5, 0.75])
    for tau in quantiles:
        if not (0.0 < float(tau) < 1.0):
            raise ValueError(f"分位点必须在 0 和 1 之间（开区间），收到 {tau}")

    dep_alias = aliases[payload["dependentVar"]]
    design_aliases = [aliases[name] for name in regressor_names]
    # 秩与样本量检查（基于含常数的设计矩阵）
    exog = np.column_stack([np.ones(len(frame)), frame[design_aliases].astype(float).to_numpy()])
    n_params = exog.shape[1]
    if len(frame) <= n_params:
        raise ValueError("样本量相对解释变量个数过少，无法稳定估计")
    rank = int(np.linalg.matrix_rank(exog))
    if rank < n_params:
        raise ValueError(f"设计矩阵秩亏（rank={rank}，列数={n_params}），存在完全共线性，请删除重复或线性组合变量")

    covariance = payload.get("covariance", "robust")
    vcov = "iid" if covariance == "iid" else "robust"

    alias_to_original = {alias: original for original, alias in aliases.items()}

    def term_label(alias: str) -> str:
        if alias == "Intercept":
            return "const"
        return alias_to_original.get(alias, alias)

    formula = f"{dep_alias} ~ " + " + ".join(design_aliases)
    model = smf.quantreg(formula, frame)

    fits: list[dict[str, Any]] = []
    treatment_path: list[dict[str, Any]] = []
    treatment_alias = aliases[payload["treatmentVar"]]
    rows_used = 0

    for tau in quantiles:
        tau = float(tau)
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            fit = model.fit(q=tau, vcov=vcov, max_iter=2000)
        rows_used = int(fit.nobs)

        conf_int = fit.conf_int()
        # 标准误若非有限，说明这个分位点估计不可靠（常见于稀疏尾部），fail-closed
        if not np.isfinite(np.asarray(fit.bse, dtype=float)).all():
            raise ValueError(f"分位点 {tau} 的标准误出现非有限值，通常意味着该分位处样本过稀，估计不可靠")

        coefficients: list[dict[str, Any]] = []
        for alias in fit.params.index:
            coefficients.append(
                {
                    "term": term_label(str(alias)),
                    "estimate": scalar(fit.params[alias]),
                    "stdError": scalar(fit.bse[alias]),
                    "statistic": scalar(fit.tvalues[alias]),
                    "pValue": scalar(fit.pvalues[alias]),
                    "confLow": scalar(conf_int.loc[alias, 0]),
                    "confHigh": scalar(conf_int.loc[alias, 1]),
                }
            )
        primary = next((c for c in coefficients if c["term"] == payload["treatmentVar"]), None)
        fits.append(
            {
                "tau": tau,
                "pseudoRSquared": scalar(getattr(fit, "prsquared", None)),
                "coefficients": coefficients,
                "primary": primary,
            }
        )
        treatment_path.append(
            {
                "tau": tau,
                "estimate": scalar(fit.params[treatment_alias]),
                "stdError": scalar(fit.bse[treatment_alias]),
                "pValue": scalar(fit.pvalues[treatment_alias]),
                "confLow": scalar(conf_int.loc[treatment_alias, 0]),
                "confHigh": scalar(conf_int.loc[treatment_alias, 1]),
            }
        )

    # 主报告分位点：最接近中位数的那个（中位数回归是分位数回归的"基准"）
    primary_index = min(range(len(quantiles)), key=lambda i: abs(float(quantiles[i]) - 0.5))
    primary_fit = fits[primary_index]

    warn_list: list[str] = []
    # 处理效应是否随分位点单调变化——提示分布异质性（不是错误，是有价值的发现）
    path_estimates = [item["estimate"] for item in treatment_path if item["estimate"] is not None]
    if len(path_estimates) >= 2:
        spread = max(path_estimates) - min(path_estimates)
        median_abs = abs(primary_fit["primary"]["estimate"]) if primary_fit["primary"] else 0.0
        if median_abs > 0 and spread > 0.5 * median_abs:
            warn_list.append(
                f"核心解释变量在不同分位点的效应差异较大（{round(min(path_estimates), 4)} ~ "
                f"{round(max(path_estimates), 4)}），说明存在分布异质性，OLS 的均值效应会掩盖这一点"
            )

    result = {
        "success": True,
        "method": method,
        "backend": "statsmodels",
        "statsmodelsVersion": statsmodels.__version__,
        "rowsInput": rows_input,
        "rowsUsed": rows_used,
        "droppedRows": rows_input - rows_used,
        "covariance": vcov,
        "quantiles": [float(t) for t in quantiles],
        "outcomeMean": float(y.mean()),
        "fits": fits,
        "primaryTau": float(quantiles[primary_index]),
        "primary": primary_fit["primary"],
        "treatmentPath": treatment_path,
        "warnings": warn_list,
    }

    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    result_path = output_dir / "results.json"
    coefficients_path = output_dir / "coefficients.csv"
    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    # 系数表：长表，每个分位点 × 每个系数一行
    rows_out = []
    for fit_entry in fits:
        for coef in fit_entry["coefficients"]:
            rows_out.append({"tau": fit_entry["tau"], **coef})
    pd.DataFrame(rows_out).to_csv(coefficients_path, index=False, encoding="utf-8-sig")
    # 不要用 .resolve()：macOS 上它会把 /var 解析成 /private/var，和 TS 侧 path.resolve 对不上。
    result["resultPath"] = str(result_path)
    result["coefficientsPath"] = str(coefficients_path)
    return result


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
        if payload.get("method") != "quantile_regression":
            raise ValueError(f"不支持的方法：{payload.get('method')}")
        result = build_result(payload)
    except Exception as exc:  # noqa: BLE001 —— 统一转成结构化失败，绝不把 traceback 泄漏到对话
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        return
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
