"""Deterministic statsmodels MNLogit adapter for KillStata model-facing tools.

对多类别（无序）结果变量执行 Multinomial Logit 最大似然估计。
与 GLM/count 适配器同构：模型只发结构化字段，绝不发明公式；本适配器验证列、类别数、
秩与样本量后调用 statsmodels MNLogit（最低取值为基准类别），返回各非基准类别相对于
基准的对数几率系数与相对风险比（RRR=exp 系数）。

多分类 Logit 没有简洁的 AME——AME 是变量取值和所有分类的函数，不独立于其他变量；
所以本品只返回 RRR（倍数比）作为可解读量，不给 AME。
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

MULTINOMIAL_LOGIT = "multinomial_logit"


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
    if method != MULTINOMIAL_LOGIT:
        raise ValueError(f"不支持的方法：{method}")

    frame, aliases, regressor_names, rows_input = prepare_frame(payload)
    require_numeric(frame, aliases, [payload["dependentVar"], *regressor_names])
    if not np.isfinite(frame.to_numpy(dtype=float)).all():
        raise ValueError("因变量或解释变量包含非有限值（inf/-inf），请先清洗数据")

    raw_y = frame[aliases[payload["dependentVar"]]].astype(float)
    if not np.equal(raw_y.to_numpy(), np.round(raw_y.to_numpy())).all():
        raise ValueError("多项 Logit 因变量必须使用离散整数类别编码；当前含连续值，系统不会四舍五入或自动分箱")
    y = raw_y.astype(int)
    y_unique = sorted(y.unique())
    if len(y_unique) < 2:
        raise ValueError("因变量必须至少包含两个不同类别")
    if len(y_unique) > 20:
        raise ValueError(f"因变量类别过多（{len(y_unique)}），不适用多分类 Logit")
    baseline = int(y_unique[0])

    design_names = [aliases[name] for name in regressor_names]
    exog = sm.add_constant(frame[design_names].astype(float), has_constant="add")
    if len(exog) <= exog.shape[1]:
        raise ValueError("样本量相对解释变量个数过少，无法稳定估计")
    rank = int(np.linalg.matrix_rank(exog.to_numpy(dtype=float)))
    if rank < exog.shape[1]:
        raise ValueError(f"设计矩阵秩亏（rank={rank}，列数={exog.shape[1]}），存在完全共线性")

    covariance = payload.get("covariance", "nonrobust")
    cov_type = "HC1" if covariance == "robust" else "nonrobust"

    try:
        model = sm.MNLogit(y, exog)
        fit = model.fit(disp=False, maxiter=200, cov_type=cov_type)
    except np.linalg.LinAlgError as exc:
        raise ValueError("估计过程矩阵奇异") from exc
    except Exception as exc:
        raise ValueError(f"最大似然估计失败：{exc}") from exc

    if not bool(getattr(fit, "mle_retvals", {}).get("converged", True)):
        raise ValueError("最大似然迭代未收敛，结果不可信")

    alias_to_original = {alias: original for original, alias in aliases.items()}

    def term_label(alias: str) -> str:
        if alias == "const":
            return "const"
        return alias_to_original.get(alias, alias)

    # params columns = non-baseline categories（DataFrame columns）
    # params columns = internal category indices (0..K-2 for non-baseline)
    # 需要映射回原始类别编码
    internal_compare = [int(c) for c in fit.params.columns]
    compare_categories = [int(y_unique[idx + 1]) for idx in internal_compare]  # native int for JSON
    term_aliases = list(fit.params.index)

    # 扁平化系数表: 每个非基准类别 × 每个变量 一行
    # 用 internal_compare 索引访问 fit.params（params.columns 是 internal indices）
    coefficients: list[dict[str, Any]] = []
    for cat_idx, cat in zip(internal_compare, compare_categories):
        for alias in term_aliases:
            est = float(fit.params.loc[alias, cat_idx])
            se = float(fit.bse.loc[alias, cat_idx])
            pv = float(fit.pvalues.loc[alias, cat_idx])
            ci_result = fit.conf_int()
            # MNLogit 的 conf_int 使用真实结果类别标签（如 "2"），而非 params 的 0-based 列索引。
            ci_key = (str(cat), alias)
            try:
                low = float(ci_result.loc[ci_key, "lower"])
                high = float(ci_result.loc[ci_key, "upper"])
            except Exception:
                low, high = None, None
            coefficients.append({
                "category": int(cat),
                "term": term_label(alias),
                "estimate": scalar(est),
                "stdError": scalar(se),
                "pValue": scalar(pv),
                "confLow": scalar(low),
                "confHigh": scalar(high),
                "rrr": scalar(math.exp(est)),
            })

    # treatment 效应路径: 核心解释变量在各非基准类别上的效应
    treat_alias = aliases[payload["treatmentVar"]]
    treatment_path: list[dict[str, Any]] = []
    for cat_idx, cat in zip(internal_compare, compare_categories):
        est = float(fit.params.loc[treat_alias, cat_idx])
        se = float(fit.bse.loc[treat_alias, cat_idx])
        pv = float(fit.pvalues.loc[treat_alias, cat_idx])
        ci_result = fit.conf_int()
        try:
            low = float(ci_result.loc[(str(cat), treat_alias), "lower"])
            high = float(ci_result.loc[(str(cat), treat_alias), "upper"])
        except Exception:
            low, high = None, None
        treatment_path.append({
            "category": int(cat),
            "estimate": scalar(est),
            "stdError": scalar(se),
            "pValue": scalar(pv),
            "confLow": scalar(low),
            "confHigh": scalar(high),
            "rrr": scalar(math.exp(est)),
        })

    # primary = treatment 在 p 值最小的类别上的系数
    best = sorted(treatment_path, key=lambda x: x["pValue"] or 1.0)[0]
    primary = next((c for c in coefficients if c["category"] == best["category"] and c["term"] == payload["treatmentVar"]), None)
    primary_rrr = next((r for r in treatment_path if r["category"] == best["category"]), None)

    rows_used = int(fit.nobs)

    # 预测准确率
    pred = fit.predict(exog)
    accuracy = float((pred.idxmax(axis=1).values == y.values).mean())

    warnings_list: list[str] = []
    if len(y_unique) >= 8:
        warnings_list.append(f"类别数较多（{len(y_unique)}），估计系数过多，解读请聚焦相对风险比（RRR）")

    result = {
        "success": True,
        "method": method,
        "backend": "statsmodels",
        "statsmodelsVersion": statsmodels.__version__,
        "rowsInput": rows_input,
        "rowsUsed": rows_used,
        "droppedRows": rows_input - rows_used,
        "covariance": cov_type,
        "categories": [int(c) for c in y_unique],
        "baselineCategory": int(baseline),
        "nCategories": len(y_unique),
        "compareCategories": compare_categories,
        "logLikelihood": scalar(fit.llf),
        "pseudoRSquared": scalar(fit.prsquared),
        "accuracy": accuracy,
        "coefficients": coefficients,
        "treatmentPath": treatment_path,
        "primary": primary,
        "primaryRrr": primary_rrr,
        "warnings": warnings_list,
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
        if payload.get("method") != MULTINOMIAL_LOGIT:
            raise ValueError(f"不支持的方法：{payload.get('method')}")
        result = build_result(payload)
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        return
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
