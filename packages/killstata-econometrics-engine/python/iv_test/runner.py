"""工具变量诊断（iv_test）：弱工具、内生性、过度识别三组检验。

对标 Stata `ivregress 2sls` 之后的 `estat firststage` / `estat endogenous` / `estat overid`。
本 runner 只出检验统计量，不出回归系数表——回归表归 iv_2sls，边界不重叠。

三组检验的适用性是硬性的，不适用时返回 null 并写明原因，绝不编造数字：
  1. 弱工具：第一阶段对排除性工具变量的联合 F。任何情况都能算。
  2. 内生性 DWH：Durbin(chi2) / Wu-Hausman(F)，稳健设定下另给 Wooldridge 回归型稳健得分检验。
  3. 过度识别：仅当工具变量数 > 内生变量数才有自由度。恰好识别时 Sargan/Hansen J 无意义。
"""

from __future__ import annotations
import json, math, sys, warnings
from pathlib import Path
import numpy as np, pandas as pd
import linearmodels

# Staiger-Stock (1997) 经验法则。刻意不内置 Stock-Yogo 临界值表：
# 该表随工具变量个数与容忍的最大偏误/水平扭曲而变，凭记忆写进代码等于编数据。
WEAK_INSTRUMENT_F_THRESHOLD = 10.0
ENDOGENEITY_ALPHA = 0.05
OVERID_ALPHA = 0.05


def scalar(v):
    if v is None: return None
    if isinstance(v,(np.integer,np.floating)): v=v.item()
    if isinstance(v,float) and (math.isnan(v) or math.isinf(v)): return None
    if isinstance(v,(str,int,float,bool)): return v
    return str(v)


def load_frame(p):
    s=Path(p).suffix.lower()
    if s==".csv": return pd.read_csv(p)
    if s in (".xlsx",".xls"): return pd.read_excel(p)
    if s==".dta": return pd.read_stata(p)
    if s==".parquet": return pd.read_parquet(p)
    raise ValueError(f"不支持的数据格式：{s or '未知格式'}")


def test_triple(result, name):
    """把 linearmodels 的 WaldTestStatistic 摊平成 stat/pValue/df；不可用时全 None。"""
    try:
        t = getattr(result, name)
        if callable(t): t = t()
        stat, pval, df = scalar(t.stat), scalar(t.pval), t.df
        # 恰好识别时 linearmodels 对过度识别检验返回 NaN，scalar() 已转成 None。
        if stat is None: return {"stat": None, "pValue": None, "df": None}
        return {"stat": stat, "pValue": pval, "df": int(df) if df is not None else None}
    except Exception:
        return {"stat": None, "pValue": None, "df": None}


def build_result(payload):
    frame = load_frame(payload["dataPath"])
    if frame.columns.duplicated().any():
        dups = frame.columns[frame.columns.duplicated()].tolist()
        raise ValueError(f"数据中存在重复列名：{', '.join(map(str,dups))}")

    cols = [payload["dependentVar"], payload["treatmentVar"], *payload.get("covariates", []), *payload["instrumentVars"]]
    seen = {}; [seen.setdefault(n) for n in cols]; cols = list(seen.keys())
    miss = [n for n in cols if n not in frame.columns]
    if miss: raise ValueError(f"数据中找不到变量：{', '.join(miss)}")

    rows_in = int(len(frame))
    frame = frame.loc[:, cols].dropna().copy()
    if frame.empty: raise ValueError("所选变量删除缺失值后没有可用样本")
    alias = {n: f"v_{i}" for i, n in enumerate(cols)}
    frame = frame.rename(columns=alias)

    da, ta = alias[payload["dependentVar"]], alias[payload["treatmentVar"]]
    reg_a = [alias[n] for n in payload.get("covariates", [])]
    iv_a = [alias[n] for n in payload["instrumentVars"]]

    y = frame[da].astype(float)
    endog = frame[[ta]].astype(float)
    # 与 iv_2sls 保持同一约定：linearmodels 不自动补截距，必须显式加。
    exog = frame[reg_a].astype(float).copy() if reg_a else pd.DataFrame(index=frame.index)
    exog.insert(0, "const", 1.0)
    instr = frame[iv_a].astype(float)

    if y.nunique() < 5: raise ValueError("因变量取值过于集中")
    if endog[ta].nunique() < 2: raise ValueError("内生解释变量没有变异，无法做工具变量诊断")
    for name, alias_name in zip(payload["instrumentVars"], iv_a):
        if frame[alias_name].nunique() < 2:
            raise ValueError(f"工具变量 {name} 没有变异，无法识别第一阶段")

    cov_type = payload.get("covariance", "robust")
    if cov_type not in ("robust", "unadjusted"): cov_type = "robust"

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from linearmodels.iv import IV2SLS
            fit = IV2SLS(y, exog, endog, instr).fit(cov_type=cov_type)
            ols = IV2SLS(y, pd.concat([exog, endog], axis=1), None, None).fit(cov_type=cov_type)
    except Exception as e:
        raise ValueError(f"工具变量诊断失败：{e}") from e

    n_instruments, n_endog = len(iv_a), 1
    overid_df = n_instruments - n_endog
    identification = "over_identified" if overid_df > 0 else "just_identified"

    # ---- 1. 弱工具 ----
    try:
        first_stage_row = fit.first_stage.diagnostics.loc[ta]
        fs_stat = float(first_stage_row["f.stat"])
        fs_pval = float(first_stage_row["f.pval"])
        fs_distribution = str(first_stage_row["f.dist"])
        partial_r2 = float(first_stage_row["partial.rsquared"])
    except Exception as e:
        raise ValueError(f"无法取得第一阶段诊断：{e}") from e
    # linearmodels 在 robust 协方差下返回 Wald chi-square，而非 F。
    # Staiger-Stock 的 F<10 经验规则只在统计量确为 F 时适用。
    is_f_statistic = fs_distribution.lower().startswith("f(")
    weak = fs_stat < WEAK_INSTRUMENT_F_THRESHOLD if is_f_statistic else None
    weak_block = {
        "firstStageStatistic": scalar(fs_stat),
        "firstStageStatisticDistribution": fs_distribution,
        # 向后兼容历史结果键；必须由 firstStageStatisticDistribution 解释其口径。
        "firstStageFStat": scalar(fs_stat),
        "firstStagePValue": scalar(fs_pval),
        "partialRSquared": scalar(partial_r2),
        "threshold": WEAK_INSTRUMENT_F_THRESHOLD if is_f_statistic else None,
        "criterion": (
            "Staiger-Stock (1997) rule of thumb: first-stage F < 10 signals weak instruments"
            if is_f_statistic else
            f"第一阶段统计量服从 {fs_distribution}；F<10 经验规则不适用，不作阈值式弱工具二分类。"
        ),
        "weak": bool(weak) if is_f_statistic else None,
    }

    # ---- 2. 内生性 DWH ----
    durbin = test_triple(fit, "durbin")
    wu_hausman = test_triple(fit, "wu_hausman")
    robust_score = test_triple(fit, "wooldridge_regression")
    # 稳健设定下同方差版本的 Durbin/Wu-Hausman 不再有效，主判据换成 Wooldridge 稳健回归型检验。
    primary_key = "wooldridge_regression" if cov_type == "robust" and robust_score["pValue"] is not None else "durbin"
    primary_endo = robust_score if primary_key == "wooldridge_regression" else durbin
    endogenous = None if primary_endo["pValue"] is None else bool(primary_endo["pValue"] < ENDOGENEITY_ALPHA)
    endo_block = {
        "durbin": durbin,
        "wuHausman": wu_hausman,
        "wooldridgeRegression": robust_score,
        "primaryTest": primary_key,
        "alpha": ENDOGENEITY_ALPHA,
        "endogenous": endogenous,
    }

    # ---- 3. 过度识别 ----
    if overid_df > 0:
        sargan = test_triple(fit, "sargan")
        robust_j = test_triple(fit, "wooldridge_overid")
        overid_primary = "wooldridge_overid" if cov_type == "robust" and robust_j["pValue"] is not None else "sargan"
        chosen = robust_j if overid_primary == "wooldridge_overid" else sargan
        overid_block = {
            "applicable": True,
            "reason": None,
            "sargan": sargan,
            "wooldridgeOverid": robust_j,
            "primaryTest": overid_primary,
            "alpha": OVERID_ALPHA,
            "instrumentsRejected": None if chosen["pValue"] is None else bool(chosen["pValue"] < OVERID_ALPHA),
        }
    else:
        overid_block = {
            "applicable": False,
            "reason": f"恰好识别：{n_instruments} 个工具变量对 {n_endog} 个内生变量，过度识别检验没有自由度。要检验排除限制需要更多工具变量。",
            "sargan": {"stat": None, "pValue": None, "df": None},
            "wooldridgeOverid": {"stat": None, "pValue": None, "df": None},
            "primaryTest": None,
            "alpha": OVERID_ALPHA,
            "instrumentsRejected": None,
        }

    # ---- OLS vs IV 点估计对照（DWH 检验的直观注脚）----
    comparison = {
        "olsEstimate": scalar(ols.params[ta]), "olsStdError": scalar(ols.std_errors[ta]),
        "ivEstimate": scalar(fit.params[ta]), "ivStdError": scalar(fit.std_errors[ta]),
    }

    ws = []
    if is_f_statistic and weak:
        ws.append(f"第一阶段 F={fs_stat:.3f} 低于 {WEAK_INSTRUMENT_F_THRESHOLD} 经验阈值；2SLS 估计可能不可靠")
    elif not is_f_statistic:
        if fs_pval >= 0.05:
            ws.append(
                f"稳健第一阶段 Wald χ²={fs_stat:.3f}（p={fs_pval:.3g}，部分 R²={partial_r2:.4g}）；"
                "相关性证据有限。F<10 经验规则不适用于该 χ²，不作阈值式弱工具二分类。"
            )
        else:
            ws.append(
                f"稳健第一阶段 Wald χ²={fs_stat:.3f}（p={fs_pval:.3g}，部分 R²={partial_r2:.4g}）；"
                "不将 F<10 经验规则应用于该 χ²。"
            )
    if overid_df == 0: ws.append("恰好识别，无法检验工具变量的排除限制（外生性），只能依赖研究设计论证")
    if overid_block["instrumentsRejected"]: ws.append("过度识别检验拒绝原假设，至少一个工具变量的外生性存疑")
    if overid_block["applicable"] and overid_block["instrumentsRejected"] is False:
        ws.append("过度识别检验未拒绝原假设；这不等于证明工具变量外生性或排除限制成立")
    if endogenous is False: ws.append("内生性检验未拒绝原假设，OLS 与 2SLS 无系统差异，本例用 IV 可能没有必要")

    first_stage_verdict = (
        f"第一阶段 F={fs_stat:.3f}（{'低于' if weak else '不低于'} {WEAK_INSTRUMENT_F_THRESHOLD} 经验阈值）"
        if is_f_statistic else
        f"稳健第一阶段 Wald χ²={fs_stat:.3f}（p={fs_pval:.3g}，部分 R²={partial_r2:.4g}）；F<10 分类不适用"
    )
    if not overid_block["applicable"]:
        overid_verdict = overid_block["reason"].rstrip("。")
    elif overid_block["instrumentsRejected"] is True:
        overid_verdict = "检验拒绝原假设，至少一个工具变量的外生性存疑"
    elif overid_block["instrumentsRejected"] is False:
        overid_verdict = "检验未拒绝原假设，但这不等于证明工具变量外生性或排除限制成立"
    else:
        overid_verdict = "检验统计量不可用，无法判断"

    verdict_parts = [
        first_stage_verdict,
        "内生性检验" + ("无法判定" if endogenous is None else ("拒绝外生性，支持使用 IV" if endogenous else "未拒绝外生性")),
        "过度识别检验" + overid_verdict,
    ]

    res = {
        "success": True, "method": "iv_test", "backend": "linearmodels.iv.IV2SLS",
        "linearmodelsVersion": linearmodels.__version__,
        "dependentVar": payload["dependentVar"], "endogenousVar": payload["treatmentVar"],
        "instrumentVars": list(payload["instrumentVars"]),
        "rowsInput": rows_in, "rowsUsed": int(fit.nobs), "droppedRows": rows_in - int(fit.nobs),
        "covariance": cov_type,
        "identification": identification, "overIdentifyingRestrictions": overid_df,
        "weakInstrument": weak_block, "endogeneity": endo_block, "overIdentification": overid_block,
        "comparison": comparison, "warnings": ws, "verdict": "；".join(verdict_parts) + "。",
    }

    od = Path(payload["outputDir"]); od.mkdir(parents=True, exist_ok=True)
    rp, tp = od / "results.json", od / "tests.csv"
    with open(rp, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=2)
    pd.DataFrame([
        {
            "test": "first_stage_F" if is_f_statistic else "first_stage_robust_wald_chi2",
            "statistic": weak_block["firstStageStatistic"],
            "pValue": weak_block["firstStagePValue"],
            "df": n_instruments,
            "distribution": fs_distribution,
            "applicable": True,
        },
        {"test": "durbin", **{k: durbin[k] for k in ("pValue", "df")}, "statistic": durbin["stat"], "applicable": durbin["stat"] is not None},
        {"test": "wu_hausman", **{k: wu_hausman[k] for k in ("pValue", "df")}, "statistic": wu_hausman["stat"], "applicable": wu_hausman["stat"] is not None},
        {"test": "wooldridge_regression", **{k: robust_score[k] for k in ("pValue", "df")}, "statistic": robust_score["stat"], "applicable": robust_score["stat"] is not None},
        {"test": "sargan", **{k: overid_block["sargan"][k] for k in ("pValue", "df")}, "statistic": overid_block["sargan"]["stat"], "applicable": overid_block["applicable"]},
        {"test": "wooldridge_overid", **{k: overid_block["wooldridgeOverid"][k] for k in ("pValue", "df")}, "statistic": overid_block["wooldridgeOverid"]["stat"], "applicable": overid_block["applicable"]},
    ]).to_csv(tp, index=False, encoding="utf-8-sig")
    res["resultPath"], res["testsPath"] = str(rp), str(tp)
    return res


def main():
    try:
        p = json.loads(sys.stdin.read())
        if p.get("method") != "iv_test": raise ValueError(f"不支持的方法：{p.get('method')}")
        print(json.dumps(build_result(p), ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success": False, "message": str(e)}, ensure_ascii=False))


if __name__ == "__main__": main()
