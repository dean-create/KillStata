"""Deterministic statsmodels count-data adapter for KillStata model-facing tools.

处理计数结果变量的 Poisson / 负二项（NegativeBinomial）最大似然估计。与 GLM 适配器
同构：模型只发结构化字段（因变量、核心解释变量、控制变量、协方差选择），绝不发公式；
本适配器验证列、结果非负性、秩与样本量，构造安全公式，调用 statsmodels，
计算发生率比（IRR = exp(系数)）与计数尺度的平均边际效应（AME），做过度离散诊断，
最后在 stdout 输出单行 JSON 结果。

为什么单独一个 count 域而不塞进 glm：计数模型的世界观和二元不同——结果校验是"非负"
而非"0/1"，可解释量是发生率比而非概率，还多一个 Poisson 独有的过度离散诊断（均值=方差
假设一旦破裂就要改用负二项）。混在一起会让二元校验和计数校验到处分叉。

关于非整数结果变量：**故意不拒绝**。Poisson 伪极大似然（PPML，Santos Silva & Tenreyro
2006）对连续非负结果是贸易引力、工资等场景的主力方法，pyfixest 的 fepois 正是干这个的。
因此只对 Poisson/PPML 放行连续非负结果。负二项分布要求非负整数计数，不能用它拟合小数结果。
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

METHODS = {
    "poisson_regression": "poisson",
    "negbin_regression": "negbin",
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
    family = METHODS[method]
    frame, aliases, regressor_names, rows_input = prepare_frame(payload)

    require_numeric(frame, aliases, [payload["dependentVar"], *regressor_names])
    if not np.isfinite(frame.to_numpy(dtype=float)).all():
        raise ValueError("因变量或解释变量包含非有限值（inf/-inf），请先清洗数据")

    y = frame[aliases[payload["dependentVar"]]].astype(float)
    # Poisson/PPML 与负二项都要求非负；只有 Poisson 允许连续非负结果。
    if (y < 0).any():
        raise ValueError("计数结果变量不能有负值；Poisson/负二项只适用于非负结果（如次数、数量、非负金额）")
    if float(y.max()) <= 0.0:
        raise ValueError("结果变量全为 0，没有可估计的计数变异")
    if y.nunique() < 2:
        raise ValueError("结果变量没有变异（取值全相同），无法估计")
    # 是否纯计数；Poisson 可用于 PPML，负二项则在下方拒绝非整数结果。
    is_pure_count = bool(np.all(np.equal(np.mod(y.to_numpy(dtype=float), 1.0), 0.0)))
    if family == "negbin" and not is_pure_count:
        raise ValueError(
            "负二项回归要求因变量为非负整数计数；当前结果含非整数值。若它是连续非负结果，"
            "请先确认研究口径，再搜索并选择 Poisson/PPML；系统不会四舍五入或静默更换方法"
        )
    if family == "negbin" and y.isin([0, 1]).all():
        raise ValueError("因变量只有 0/1 取值，是二元结果而非负二项计数结果；请根据研究问题确认合适的模型")

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
        if family == "poisson":
            model = sm.Poisson(y, exog)
        else:
            model = sm.NegativeBinomial(y, exog)
        fit = model.fit(disp=False, maxiter=200, cov_type=cov_type)
    except np.linalg.LinAlgError as exc:
        raise ValueError("估计过程矩阵奇异，请检查解释变量的共线性") from exc
    except Exception as exc:  # noqa: BLE001 —— 收敛失败等统一转成可读信息
        raise ValueError(f"最大似然估计失败：{exc}") from exc

    if not bool(getattr(fit, "mle_retvals", {}).get("converged", True)):
        raise ValueError("最大似然迭代未收敛，结果不可信；请检查数据或改用负二项")

    predicted = np.asarray(fit.predict(exog), dtype=float)
    if not np.isfinite(predicted).all() or np.any(predicted <= 0.0):
        raise ValueError("预测均值出现非正或非有限值，估计不可靠")

    alias_to_original = {alias: original for original, alias in aliases.items()}

    def term_label(alias: str) -> str:
        if alias == "const":
            return "const"
        return alias_to_original.get(alias, alias)

    # 负二项会多估一个 alpha（过度离散参数），它不是回归系数，画系数表时要剔除
    beta_columns = [col for col in exog.columns]

    conf_int = fit.conf_int()
    coefficients: list[dict[str, Any]] = []
    incidence_rate_ratios: list[dict[str, Any]] = []
    for alias in beta_columns:
        estimate = float(fit.params[alias])
        low = float(conf_int.loc[alias, 0])
        high = float(conf_int.loc[alias, 1])
        coefficients.append(
            {
                "term": term_label(alias),
                "estimate": scalar(estimate),
                "stdError": scalar(fit.bse[alias]),
                "statistic": scalar(fit.tvalues[alias]),
                "pValue": scalar(fit.pvalues[alias]),
                "confLow": scalar(low),
                "confHigh": scalar(high),
            }
        )
        # 发生率比（IRR = exp(系数)）：计数模型可解释量。系数每增一单位，
        # 期望计数变为原来的 exp(系数) 倍；CI 也是对系数 CI 取指数。
        incidence_rate_ratios.append(
            {
                "term": term_label(alias),
                "irr": scalar(math.exp(estimate)),
                "confLow": scalar(math.exp(low)),
                "confHigh": scalar(math.exp(high)),
                "pValue": scalar(fit.pvalues[alias]),
            }
        )

    # 计数尺度的平均边际效应（dy/dx）——"X 每增一单位，期望计数平均变化多少"
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

    treatment_term = payload["treatmentVar"]
    primary_coefficient = next((c for c in coefficients if c["term"] == treatment_term), None)
    primary_irr = next((r for r in incidence_rate_ratios if r["term"] == treatment_term), None)
    primary_margin = next((m for m in marginal_effects if m["term"] == treatment_term), None)

    rows_used = int(fit.nobs)

    # 过度离散诊断（Poisson 的核心假设检查）：Pearson 统计量 / 残差自由度。
    # 显著大于 1 说明方差远大于均值，Poisson 标准误被低估，应改用负二项。
    resid_df = rows_used - len(beta_columns)
    pearson_dispersion = None
    if resid_df > 0:
        pearson_dispersion = float(np.sum((y.to_numpy() - predicted) ** 2 / predicted) / resid_df)

    warnings: list[str] = []
    if not is_pure_count:
        warnings.append("结果变量含非整数值，按 Poisson 伪极大似然（PPML）处理；若本意是纯计数请检查数据")
    if family == "poisson" and pearson_dispersion is not None and pearson_dispersion > 1.5:
        dispersion_message = f"检测到过度离散（Pearson 离散度约 {round(pearson_dispersion, 2)}，远大于 1）。"
        if not is_pure_count:
            if cov_type == "HC1":
                warnings.append(
                    f"{dispersion_message}当前使用 HC1 稳健协方差；该诊断不改变连续非负结果的测量类型，"
                    "也不构成改用负二项计数模型的依据。"
                )
            else:
                warnings.append(
                    f"{dispersion_message}当前使用非稳健协方差，标准误可能受方差设定影响；可由你确认是否改用 HC1。"
                    "连续非负结果不适用负二项计数模型。"
                )
        elif cov_type == "HC1":
            warnings.append(
                f"{dispersion_message}当前计数模型使用 HC1 稳健协方差；如需改用负二项分布模型，应由研究者另行确认，不自动替换。"
            )
        else:
            warnings.append(
                f"{dispersion_message}非稳健 Poisson 标准误可能被低估；可由你确认是否改用负二项或 HC1，不自动切换。"
            )

    # 负二项的 alpha：过度离散参数，alpha→0 时退化为 Poisson
    alpha = None
    if family == "negbin" and "alpha" in fit.params.index:
        alpha = scalar(fit.params["alpha"])

    result = {
        "success": True,
        "method": method,
        "backend": "statsmodels",
        "statsmodelsVersion": statsmodels.__version__,
        "rowsInput": rows_input,
        "rowsUsed": rows_used,
        "droppedRows": rows_input - rows_used,
        "covariance": cov_type,
        "isPureCount": is_pure_count,
        "meanOutcome": float(y.mean()),
        "logLikelihood": scalar(fit.llf),
        "pseudoRSquared": scalar(getattr(fit, "prsquared", None)),
        "dispersion": scalar(pearson_dispersion),
        "alpha": alpha,
        "coefficients": coefficients,
        "incidenceRateRatios": incidence_rate_ratios,
        "marginalEffects": marginal_effects,
        "primary": primary_coefficient,
        "primaryIrr": primary_irr,
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
