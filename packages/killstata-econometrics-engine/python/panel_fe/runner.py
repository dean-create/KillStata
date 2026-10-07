"""Deterministic linearmodels panel fixed-effects adapter for KillStata model-facing tools.

对面板数据做双向固定效应(FE)估计 —— entity_effects + time_effects。
与 panel_random_effects 共享 linearmodels 依赖,但只输出 FE 结果(不跑 Hausman)。
"""

from __future__ import annotations
import json, math, sys, warnings
from pathlib import Path
from typing import Any
import numpy as np, pandas as pd
from linearmodels.panel import PanelOLS

def scalar(v): return None if v is None else v.item() if isinstance(v,(np.integer,np.floating)) else None if (isinstance(v,float) and (math.isnan(v) or math.isinf(v))) else v if isinstance(v,(str,int,float,bool)) else str(v)
def load_frame(p):
    s = Path(p).suffix.lower()
    if s==".csv": return pd.read_csv(p)
    if s in (".xlsx",".xls"): return pd.read_excel(p)
    if s==".dta": return pd.read_stata(p)
    if s==".parquet": return pd.read_parquet(p)
    raise ValueError(f"不支持的数据格式：{s or '未知格式'}")

def col_dup_check(cols, label):
    dups = list(cols[cols.duplicated()])
    if dups: raise ValueError(f"{label} 中存在重复列名：{', '.join(map(str,dups))}")

def build_result(payload):
    method = payload["method"]
    frame = load_frame(payload["dataPath"])
    ecol, tcol = payload["entityVar"], payload["timeVar"]
    ccol = payload.get("clusterVar") or ecol
    cols = [payload["dependentVar"],payload["treatmentVar"],ecol,tcol,ccol,*payload.get("covariates",[])]
    seen={}; [seen.setdefault(n) for n in cols]; cols=list(seen.keys())
    miss=[n for n in cols if n not in frame.columns]
    if miss: raise ValueError(f"数据中找不到变量：{', '.join(miss)}")
    rows_in=int(len(frame))
    frame=frame.loc[:,cols].dropna().copy()
    if frame.empty: raise ValueError("所选变量删除缺失值后没有可用样本")
    dup=frame.duplicated(subset=[ecol,tcol],keep=False)
    if dup.any(): raise ValueError(f"面板索引 {ecol}×{tcol} 不唯一")
    alias={n:f"v_{i}" for i,n in enumerate(cols)}
    frame=frame.rename(columns=alias)
    reg=[payload["treatmentVar"],*payload.get("covariates",[])]
    ea,ta,ca=alias[ecol],alias[tcol],alias[ccol]
    da=alias[payload["dependentVar"]]
    reg_a=[alias[n] for n in reg]
    panel=frame.set_index([ea,ta])
    y=panel[da].astype(float)
    X=panel[reg_a].astype(float)
    if y.nunique()<5: raise ValueError("因变量取值过于集中")
    if int(panel.index.get_level_values(0).unique().size)<2: raise ValueError("面板个体数过少(<2)")
    cov_type=payload.get("covariance","clustered")
    if cov_type not in ("clustered", "robust", "unadjusted"):
        raise ValueError(f"不支持的协方差设定：{cov_type}")
    # cluster 列可能恰好是 entity/time 索引，set_index 后不再留在普通列中；
    # 因此按原顺序取值，再绑定到 PanelOLS 使用的 MultiIndex。
    clusters = pd.DataFrame({"cluster": frame[ca].to_numpy()}, index=panel.index)
    cluster_count = int(clusters["cluster"].nunique())
    if cov_type == "clustered" and cluster_count < 2:
        raise ValueError("聚类列至少需要 2 个不同组")
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        fit_kwargs = {"cov_type": cov_type}
        if cov_type == "clustered": fit_kwargs["clusters"] = clusters
        fe=PanelOLS(y,X,entity_effects=True,time_effects=True).fit(**fit_kwargs)
    ao={a:o for o,a in alias.items()}
    def tl(t):
        if t in ("const","Intercept"): return "const"
        return ao.get(t,t)
    ci=fe.conf_int()
    lc,rc=ci.columns[0],ci.columns[1]
    coefs=[{"term":tl(t),"estimate":scalar(fe.params[t]),"stdError":scalar(fe.std_errors[t]),"statistic":scalar(fe.tstats[t]),"pValue":scalar(fe.pvalues[t]),"confLow":scalar(ci.loc[t,lc]),"confHigh":scalar(ci.loc[t,rc])} for t in fe.params.index]
    primary=next((c for c in coefs if c["term"]==payload["treatmentVar"]),None)
    rows_u=int(fe.nobs)
    n_ent=int(panel.index.get_level_values(0).unique().size)
    n_per=int(panel.index.get_level_values(1).unique().size)
    ws=[]
    res={"success":True,"method":method,"backend":"linearmodels","linearmodelsVersion": __version(),
         "rowsInput":rows_in,"rowsUsed":rows_u,"droppedRows":rows_in-rows_u,"covariance":cov_type,"clusterVar":ccol,
         "nEntities":n_ent,"nPeriods":n_per,"rSquaredWithin":scalar(fe.rsquared_within),
         "coefficients":coefs,"primary":primary,"warnings":ws}
    if cov_type == "clustered": res["clusterCount"] = cluster_count
    od=Path(payload["outputDir"]);od.mkdir(parents=True,exist_ok=True)
    rp=od/"results.json";cp=od/"coefficients.csv"
    with open(rp,"w",encoding="utf-8") as f: json.dump(res,f,ensure_ascii=False,indent=2)
    pd.DataFrame(coefs).to_csv(cp,index=False,encoding="utf-8-sig")
    res["resultPath"]=str(rp);res["coefficientsPath"]=str(cp)
    return res

def __version():
    import linearmodels; return linearmodels.__version__

def main():
    try:
        p=json.loads(sys.stdin.read())
        if p.get("method")!="panel_fe_regression": raise ValueError(f"不支持的方法：{p.get('method')}")
        print(json.dumps(build_result(p),ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"success":False,"message":str(e)},ensure_ascii=False))
if __name__=="__main__": main()
