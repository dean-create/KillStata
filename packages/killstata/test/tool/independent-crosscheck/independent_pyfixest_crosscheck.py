"""独立交叉验证：只用 pandas/numpy/statsmodels 重新实现，完全不导入 pyfixest。

对标分级协议（PLAN.md）里的 B 级——"跨库独立实现对标"——要求核心估计量
必须能被一份不共享任何代码路径的独立实现复现，而不是"拿 pyfixest 跟自己比"。
这个脚本就是那份独立实现，只在测试里被调用，绝不出现在生产 runner.py 的路径上。

三个方法对应的独立算法：

- hdfe: LSDV（虚拟变量最小二乘）。固定效应用哑变量展开后跑普通 OLS，
  数学上和吸收式估计（demeaning）严格等价（Frisch–Waugh–Lovell），
  系数应当精确一致；聚类标准误因为两边对"参数个数 K"的小样本自由度
  修正约定不同，允许更松的容差（这不是 bug，是两种正当约定的差异）。
- did2s: Gardner (2021) 两阶段法手工复现。第一步只用"未处理"样本
  （从未处理组 + 尚未到处理期的观测）回归个体和时间固定效应；
  第二步用第一步残差对相对时期虚拟变量回归，取参考期为 -1。
- saturated: 分 cohort 单独跑饱和的"cohort×相对时期"虚拟变量交互回归，
  再对各 cohort 在同一相对时期的系数取简单平均——这正是 pyfixest
  saturated estimator 的 aggregate() 在做的事，只是这里用独立代码路径复现。
"""

from __future__ import annotations

import json
import sys

import numpy as np
import pandas as pd
import statsmodels.api as sm
import statsmodels.formula.api as smf


def _lsdv_design(frame: pd.DataFrame, fe_cols: list[str]) -> pd.DataFrame:
    design = pd.get_dummies(frame[fe_cols], columns=fe_cols, drop_first=True).astype(float)
    return sm.add_constant(design)


def run_hdfe(payload: dict) -> dict:
    frame = pd.read_csv(payload["csvPath"])
    dependent = payload["dependentVar"]
    treatment = payload["treatmentVar"]
    covariates = payload.get("covariates", [])
    fixed_effects = payload["fixedEffects"]
    cluster_var = payload.get("clusterVar")

    fe_design = _lsdv_design(frame, fixed_effects)
    design = pd.concat([frame[[treatment, *covariates]].astype(float), fe_design], axis=1)

    if cluster_var:
        model = sm.OLS(frame[dependent], design).fit(
            cov_type="cluster", cov_kwds={"groups": frame[cluster_var]}
        )
    else:
        model = sm.OLS(frame[dependent], design).fit(cov_type="HC1")

    return {
        "method": "hdfe_regression",
        "treatmentEstimate": float(model.params[treatment]),
        "treatmentStdError": float(model.bse[treatment]),
        "covariateEstimates": {name: float(model.params[name]) for name in covariates},
    }


def run_did2s(payload: dict) -> dict:
    frame = pd.read_csv(payload["csvPath"])
    dependent = payload["dependentVar"]
    treatment = payload["treatmentVar"]
    entity = payload["entityVar"]
    time = payload["timeVar"]
    relative_time = payload["relativeTimeVar"]
    reference_period = payload["referencePeriod"]

    not_yet_treated = frame[frame[treatment] == 0].copy()
    stage1_design = _lsdv_design(not_yet_treated, [entity, time])
    stage1_model = sm.OLS(not_yet_treated[dependent], stage1_design).fit()

    full_design = _lsdv_design(frame, [entity, time]).reindex(columns=stage1_design.columns, fill_value=0.0)
    fitted_full = stage1_model.predict(full_design)
    residual = frame[dependent] - fitted_full

    stage2 = frame.copy()
    stage2["resid"] = residual
    is_never_treated = ~np.isfinite(stage2[relative_time].astype(float))
    stage2 = stage2[~is_never_treated]
    stage2["et"] = stage2[relative_time].astype(int).astype(str)
    stage2_model = smf.ols(
        f"resid ~ C(et, Treatment(reference='{int(reference_period)}'))", data=stage2
    ).fit()

    target = f"T.0]"
    coefficient = next(
        (value for name, value in stage2_model.params.items() if name.endswith(target)),
        None,
    )
    if coefficient is None:
        raise ValueError("independent did2s stage 2 produced no relative-time-0 coefficient")

    return {"method": "did2s", "eventTimeZeroEstimate": float(coefficient)}


def run_saturated(payload: dict) -> dict:
    frame = pd.read_csv(payload["csvPath"])
    dependent = payload["dependentVar"]
    cohort_var = payload["cohortVar"]
    entity = payload["entityVar"]
    time = payload["timeVar"]

    frame = frame.copy()
    frame["__rel_time"] = np.where(
        frame[cohort_var] > 0, frame[time] - frame[cohort_var], np.nan
    )

    design = _lsdv_design(frame, [entity, time])
    treated_rows = frame[frame[cohort_var] > 0]
    cohorts = sorted(treated_rows[cohort_var].unique())
    cell_columns: dict[tuple[float, int], str] = {}
    for cohort_value in cohorts:
        rel_times = sorted(
            treated_rows.loc[treated_rows[cohort_var] == cohort_value, "__rel_time"].unique()
        )
        for rel in rel_times:
            if rel == -1:
                continue  # 每个 cohort 各自的参照期
            column = f"cohort{int(cohort_value)}_rel{int(rel)}"
            design[column] = (
                (frame[cohort_var] == cohort_value) & (frame["__rel_time"] == rel)
            ).astype(float)
            cell_columns[(cohort_value, int(rel))] = column

    model = sm.OLS(frame[dependent], design).fit()

    per_cohort_at_zero = [
        float(model.params[column])
        for (cohort_value, rel), column in cell_columns.items()
        if rel == 0
    ]
    if not per_cohort_at_zero:
        raise ValueError("independent saturated regression produced no relative-time-0 cells")

    return {
        "method": "did_event_study_saturated",
        "eventTimeZeroEstimate": float(np.mean(per_cohort_at_zero)),
        "perCohortEventTimeZero": per_cohort_at_zero,
    }


def main() -> None:
    payload = json.loads(sys.argv[1])
    method = payload["method"]
    handler = {
        "hdfe_regression": run_hdfe,
        "did2s": run_did2s,
        "did_event_study_saturated": run_saturated,
    }[method]
    print(json.dumps(handler(payload)))


if __name__ == "__main__":
    main()
