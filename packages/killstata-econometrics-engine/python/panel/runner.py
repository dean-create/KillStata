"""Deterministic linearmodels panel random-effects adapter for KillStata model-facing tools.

对面板数据做随机效应（GLS / Swamy-Arora）估计，与固定效应（PanelOLS with entity effects）
一起给出 Hausman-Taylor 检验，辅助用户在 FE 与 RE 之间做模型选择。
与 GLM/count/quantile 适配器同构：模型只发结构化字段（因变量、个体+时间索引、
核心解释变量、控制变量、协方差选择），绝不发明公式；本适配器验证面板结构、列、样本量
与秩，跑 LM 的 RandomEffects / PanelOLS，按正定化投影给出稳健 Hausman 统计量。

为什么"RE"和"Hausman"放在同一个工具里：Hausman 检验需要同一个数据集上 FE 和 RE
两个估计量；用户问"RE"时实际意思是"我要在 FE/RE 之间选一个，告诉我哪个对"，
分离成两个工具反而要模型拼参数（"先用 FE、再用 RE、最后用 Hausman 比对"），
踩了之前 GLM 已经踩过的"工具调用中途消失"死锁。一站式返回。

Hausman 的数值稳健性：
教科书公式 H = (β_FE - β_RE)' [V_FE - V_RE]^-1 (β_FE - β_RE) 在 V_FE - V_RE 非正定
时会给出负的 H（小样本常见）。本实现用 eigendecomposition + 正特征空间投影丢弃负
特征值的贡献，df 报告为正特征值个数——这是 Stata `hausman, sigmamore` 等统计软件
处理该数值问题的事实标准。
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
from linearmodels.panel import PanelOLS, RandomEffects


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
    """加载数据 → 校验面板结构（entity×time 唯一）→ 安全重命名 → 去重。

    实体与时间索引是面板回归的前置条件。索引重复 → 抛错而非静默取第一行，
    否则 RE 估计会把伪重复当独立观测。
    """
    frame = load_frame(payload["dataPath"])
    if frame.columns.duplicated().any():
        duplicated = frame.columns[frame.columns.duplicated()].tolist()
        raise ValueError(f"数据中存在重复列名：{', '.join(map(str, duplicated))}")

    entity_col = payload["entityVar"]
    time_col = payload["timeVar"]
    columns: list[str] = [payload["dependentVar"], payload["treatmentVar"], entity_col, time_col, *payload.get("covariates", [])]
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

    # 面板结构检查：entity×time 必须唯一
    dup_mask = frame.duplicated(subset=[entity_col, time_col], keep=False)
    if dup_mask.any():
        n = int(dup_mask.sum())
        raise ValueError(f"面板索引 {entity_col}×{time_col} 不唯一，存在 {n} 条重复实体-时间记录；请先去重或合并")

    aliases = {name: f"v_{index}" for index, name in enumerate(columns)}
    frame = frame.rename(columns=aliases)
    regressor_names = [payload["treatmentVar"], *payload.get("covariates", [])]
    return frame, aliases, regressor_names, rows_input


def require_numeric(frame: pd.DataFrame, aliases: dict[str, str], names: list[str]) -> None:
    invalid = [name for name in names if not pd.api.types.is_numeric_dtype(frame[aliases[name]])]
    if invalid:
        raise ValueError(f"以下变量必须是数值型：{', '.join(invalid)}")


def hausman_statistic(fe, re, common: list[str]) -> tuple[float | None, int, float | None]:
    """Robust Hausman test: H = (β_FE - β_RE)' [V_FE - V_RE]^+ (β_FE - β_RE) ~ χ²(df).

    V_diff = V_FE - V_RE 渐近正半定，但小样本常常非正定；用 eigendecomposition 投影
    到正特征值子空间丢弃负贡献（标准做法，参见 Stata 的 sigmamore 选项）。
    df 报告为正特征值个数，反映实际检验维度；没有有效方向时检验不可判定，不能赋 p=1。
    """
    diff = (fe.params[common] - re.params[common]).values
    V_diff = fe.cov.loc[common, common].values - re.cov.loc[common, common].values
    eigvals, eigvecs = np.linalg.eigh(V_diff)
    pos = eigvals > 1e-8
    if not pos.any():
        return None, 0, None
    Pd = eigvecs[:, pos].T @ diff
    H = float(Pd @ np.diag(1.0 / eigvals[pos]) @ Pd)
    df = int(pos.sum())
    from scipy.stats import chi2
    pval = float(1 - chi2.cdf(H, df))
    return H, df, pval


def build_result(payload: dict[str, Any]) -> dict[str, Any]:
    method = payload["method"]
    if method != "panel_random_effects":
        raise ValueError(f"不支持的方法：{method}")

    # 角色互斥：entity/time 不能同时当回归变量。set_index 会把它们从 columns 移走，
    # 留在回归列表里会出现"v_1 in columns" KeyError，且语义上也无法同时做面板索引
    # 又当自变量。
    for forbidden in (payload["entityVar"], payload["timeVar"]):
        if forbidden == payload["dependentVar"]:
            raise ValueError(f"{forbidden} 是个体/时间索引，不能同时作为因变量")
        regressor_names = [payload["treatmentVar"], *payload.get("covariates", [])]
        if forbidden in regressor_names:
            raise ValueError(f"{forbidden} 是个体/时间索引，不能同时作为回归变量")

    frame, aliases, regressor_names, rows_input = prepare_frame(payload)
    require_numeric(frame, aliases, [payload["dependentVar"], *regressor_names])

    entity_alias = aliases[payload["entityVar"]]
    time_alias = aliases[payload["timeVar"]]
    dep_alias = aliases[payload["dependentVar"]]
    design_aliases = [aliases[name] for name in regressor_names]

    # 构造面板索引
    panel = frame.set_index([entity_alias, time_alias])

    if int(panel.index.get_level_values(0).unique().size) < 2:
        raise ValueError("面板个体数过少（<2），无法估计随机效应")
    n_periods = int(panel.index.get_level_values(1).unique().size)
    if n_periods < 2:
        raise ValueError("面板时间期数过少（<2），无法估计个体时间双效应之外的固定效应")

    covariance = payload.get("covariance", "robust")
    cov_type = "robust" if covariance == "robust" else "unadjusted"

    # 同时跑 FE + RE（Hausman 的两端必须来自同一数据集）
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fe = PanelOLS(panel[dep_alias], panel[design_aliases], entity_effects=True).fit(cov_type=cov_type)
        re = RandomEffects(panel[dep_alias], panel[design_aliases]).fit(cov_type=cov_type)

    alias_to_original = {alias: original for original, alias in aliases.items()}

    def term_label(term: str) -> str:
        if term == "const" or term == "Intercept":
            return "const"
        return alias_to_original.get(term, term)

    def build_coef_list(fit, has_const: bool) -> list[dict[str, Any]]:
        conf_int = fit.conf_int()
        # LM 7.0 的 conf_int 列名为 lower/upper；旧版用 0/1 整数索引。
        # 统一按列名读，缺则退化到位置访问。
        low_col = conf_int.columns[0]
        high_col = conf_int.columns[1]
        rows: list[dict[str, Any]] = []
        for term in fit.params.index:
            rows.append({
                "term": term_label(str(term)),
                "estimate": scalar(fit.params[term]),
                "stdError": scalar(fit.std_errors[term]),
                "statistic": scalar(fit.tstats[term]),
                "pValue": scalar(fit.pvalues[term]),
                "confLow": scalar(conf_int.loc[term, low_col]),
                "confHigh": scalar(conf_int.loc[term, high_col]),
            })
        return rows

    fe_coefficients = build_coef_list(fe, has_const=True)
    re_coefficients = build_coef_list(re, has_const=True)

    # Hausman：比较 slope 系数（不包括 const）；FE 无显式常数项（被吸收）
    common = [c for c in regressor_names]
    common_aliases = [aliases[name] for name in common]
    H, df_h, pval = hausman_statistic(fe, re, common_aliases)

    primary_treatment = payload["treatmentVar"]
    primary_re = next((c for c in re_coefficients if c["term"] == primary_treatment), None)
    primary_fe = next((c for c in fe_coefficients if c["term"] == primary_treatment), None)

    rows_used = int(re.nobs)
    n_entities = int(panel.index.get_level_values(0).unique().size)
    n_periods_used = int(panel.index.get_level_values(1).unique().size)

    # 只有检验有正自由度时才能按 p 值比较；不可判定不能误写成“未拒绝 RE”。
    if df_h == 0 or pval is None:
        recommendation = "undetermined"
        reason = "Hausman 检验没有有效自由度，无法据此选择固定效应或随机效应。"
    elif pval < 0.05:
        recommendation = "fixed_effects"
        reason = "Hausman 检验显著，个体效应与解释变量相关，RE 不一致，FE 更可靠"
    else:
        recommendation = "random_effects"
        reason = "Hausman 检验不显著，无法拒绝 RE；RE 更有效率"

    warnings_list: list[str] = []
    if df_h == 0:
        warnings_list.append("Hausman 检验没有有效自由度，不能据此选择 FE 或 RE；请检查模型规格和协方差差矩阵。")
    if n_periods_used < 5:
        warnings_list.append(f"时间期数仅 {n_periods_used}，RE 的 GLS 估计在短面板下效率有限")

    result = {
        "success": True,
        "method": method,
        "backend": "linearmodels",
        "statsmodelsVersion": statsmodels.__version__,  # 借用字段名以保持统一 schema
        "linearmodelsVersion": _linearmodels_version(),
        "rowsInput": rows_input,
        "rowsUsed": rows_used,
        "droppedRows": rows_input - rows_used,
        "covariance": cov_type,
        "entityVar": payload["entityVar"],
        "timeVar": payload["timeVar"],
        "nEntities": n_entities,
        "nPeriods": n_periods_used,
        "randomEffects": {
            "coefficients": re_coefficients,
            "primary": primary_re,
            "sigmaEntity": scalar(_entity_std(re)),
        },
        "fixedEffects": {
            "coefficients": fe_coefficients,
            "primary": primary_fe,
        },
        "hausman": {
            "statistic": scalar(H),
            "df": df_h,
            "pValue": scalar(pval),
            "alpha": 0.05,
            "rejectRe": None if df_h == 0 or pval is None else bool(pval < 0.05),
        },
        "recommendation": {
            "preferred": recommendation,
            "reason": reason,
        },
        "warnings": warnings_list,
    }

    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    result_path = output_dir / "results.json"
    coefficients_path = output_dir / "coefficients.csv"
    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    # 长表：每个 (model, term) 一行
    rows_out = []
    for coef in re_coefficients:
        rows_out.append({"model": "random_effects", **coef})
    for coef in fe_coefficients:
        rows_out.append({"model": "fixed_effects", **coef})
    pd.DataFrame(rows_out).to_csv(coefficients_path, index=False, encoding="utf-8-sig")
    # 不要用 .resolve()：macOS 上它会把 /var 解析成 /private/var，与 TS path.resolve 对不上。
    result["resultPath"] = str(result_path)
    result["coefficientsPath"] = str(coefficients_path)
    return result


def _entity_std(re) -> float | None:
    try:
        return float(re.std_devs.iloc[0])
    except Exception:
        return None


def _linearmodels_version() -> str:
    try:
        import linearmodels
        return linearmodels.__version__
    except Exception:
        return "unknown"


def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
        result = build_result(payload)
    except Exception as exc:  # noqa: BLE001 —— 统一转成结构化失败，绝不把 traceback 泄漏到对话
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        return
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
