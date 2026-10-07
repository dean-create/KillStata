"""Deterministic linearmodels IV-2SLS adapter for KillStata model-facing tools.

使用 linearmodels IV2SLS 做工具变量两阶段最小二乘估计。
"""

from __future__ import annotations
import json, math, sys, warnings
from pathlib import Path
from typing import Any
import numpy as np, pandas as pd
import linearmodels

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

def first_stage_statistics(iv, endog_alias):
    """返回 linearmodels 给出的第一阶段统计量及其真实分布。"""
    try:
        row = iv.first_stage.diagnostics.loc[endog_alias]
        statistic = scalar(row["f.stat"])
        return {
            "firstStageStatistic": statistic,
            "firstStageStatisticDistribution": str(row["f.dist"]),
            "firstStagePValue": scalar(row["f.pval"]),
            "firstStagePartialRSquared": scalar(row["partial.rsquared"]),
            # 历史结果消费者仍使用该键；新结果应以 statisticDistribution 解释口径。
            "firstStageF": statistic,
        }
    except Exception:
        return {
            "firstStageStatistic": None,
            "firstStageStatisticDistribution": None,
            "firstStagePValue": None,
            "firstStagePartialRSquared": None,
            "firstStageF": None,
        }

def build_result(payload):
    method=payload["method"]
    frame=load_frame(payload["dataPath"])
    if frame.columns.duplicated().any():
        dups=frame.columns[frame.columns.duplicated()].tolist()
        raise ValueError(f"数据中存在重复列名：{', '.join(map(str,dups))}")

    cols=[payload["dependentVar"],payload["treatmentVar"],*payload.get("covariates",[]),*payload.get("instrumentVars",[])]
    seen={}; [seen.setdefault(n) for n in cols]; cols=list(seen.keys())
    miss=[n for n in cols if n not in frame.columns]
    if miss: raise ValueError(f"数据中找不到变量：{', '.join(miss)}")
    rows_in=int(len(frame))
    frame=frame.loc[:,cols].dropna().copy()
    if frame.empty: raise ValueError("所选变量删除缺失值后没有可用样本")
    alias={n:f"v_{i}" for i,n in enumerate(cols)}
    frame=frame.rename(columns=alias)

    da=alias[payload["dependentVar"]]
    ta=alias[payload["treatmentVar"]]
    reg_a=[alias[n] for n in payload.get("covariates",[])]
    iv_a=[alias[n] for n in payload["instrumentVars"]]
    y=frame[da].astype(float)
    endog=frame[[ta]].astype(float)
    # linearmodels 不会自动补截距（与 statsmodels 一致），漏加会把回归强制过原点，
    # 系数严重偏误（Card 1995 上 educ 从 0.1323 变成 0.3228）。必须显式加常数项。
    exog=frame[reg_a].astype(float).copy() if reg_a else pd.DataFrame(index=frame.index)
    exog.insert(0,"const",1.0)
    instr=frame[iv_a].astype(float)

    if y.nunique()<5: raise ValueError("因变量取值过于集中")
    cov_type=payload.get("covariance","robust")
    if cov_type=="robust": cov_type="robust"
    elif cov_type=="unadjusted": cov_type="unadjusted"
    else: cov_type="robust"

    try:
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            from linearmodels.iv import IV2SLS
            iv=IV2SLS(y, exog, endog, instr).fit(cov_type=cov_type)
    except Exception as e:
        raise ValueError(f"IV 估计失败：{e}") from e

    ao={a:o for o,a in alias.items()}
    def tl(t):
        if t in ("const","Intercept"): return "const"
        return ao.get(t,t)
    ci=iv.conf_int()
    lc,rc=ci.columns[0],ci.columns[1]
    coefs=[{"term":tl(t),"estimate":scalar(iv.params[t]),"stdError":scalar(iv.std_errors[t]),"statistic":scalar(iv.tstats[t]),"pValue":scalar(iv.pvalues[t]),"confLow":scalar(ci.loc[t,lc]),"confHigh":scalar(ci.loc[t,rc])} for t in iv.params.index]
    primary=next((c for c in coefs if c["term"]==payload["treatmentVar"]),None)
    rows_u=int(iv.nobs)
    ws=[]
    if rows_u<len(coefs): ws.append(f"小样本（N={rows_u}），IV 估计可能不可靠")
    res={"success":True,"method":method,"backend":"linearmodels.iv.IV2SLS",
         "linearmodelsVersion":linearmodels.__version__,
         "rowsInput":rows_in,"rowsUsed":rows_u,"droppedRows":rows_in-rows_u,
         "covariance":cov_type,
         "rSquared":scalar(iv.rsquared),"rSquaredAdj":scalar(iv.rsquared_adj),
         "coefficients":coefs,"primary":primary,"warnings":ws}
    res.update(first_stage_statistics(iv, ta))
    od=Path(payload["outputDir"]);od.mkdir(parents=True,exist_ok=True)
    rp=od/"results.json";cp=od/"coefficients.csv"
    with open(rp,"w",encoding="utf-8") as f: json.dump(res,f,ensure_ascii=False,indent=2)
    pd.DataFrame(coefs).to_csv(cp,index=False,encoding="utf-8-sig")
    res["resultPath"]=str(rp);res["coefficientsPath"]=str(cp)
    return res

def main():
    try:
        p=json.loads(sys.stdin.read())
        if p.get("method")!="iv_2sls": raise ValueError(f"不支持的方法：{p.get('method')}")
        print(json.dumps(build_result(p),ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success":False,"message":str(e)},ensure_ascii=False))
if __name__=="__main__": main()
