"""iv_test 的独立数值 oracle。

铁律：产品后端用 linearmodels，oracle 就绝不能再用 linearmodels 自证。
这里三组统计量全部用 statsmodels OLS + NumPy 按教科书定义手算：

  1. 第一阶段相关性：对排除性工具变量做联合 HC0 稳健 Wald 检验，再换成 chi2 形式
     （产品用 cov_type="robust"，linearmodels 的 first_stage f.stat / f.dist 对应此口径）。
  2. DWH：控制函数法——把第一阶段残差 vhat 塞进结构方程，检验 vhat 系数是否为 0
     （Wooldridge 15.5）。用 OLS 标准误得到的 t² 对应 Wu-Hausman，
     用 HC0 标准误得到的 t² 对应 Wooldridge 稳健回归型检验（产品稳健设定下的主判据）。
  3. Sargan：2SLS 残差对全部外生变量（控制变量 + 工具变量）回归，
     N·R² ~ chi2(工具变量数 − 内生变量数)。恰好识别时自由度为 0，返回 None。

已核实的对齐精度（Card 1995，恰好识别与过度识别两种设定）：
  第一阶段 Wald χ²、Wooldridge 稳健 DWH、Sargan 均在 1e-9 以内逐位吻合；
  Wu-Hausman 在恰好识别下逐位吻合，过度识别下 linearmodels 另用一套小样本自由度约定，
  相对差约 1.5%，故不作为对标项——产品稳健设定下的主判据是 Wooldridge 稳健检验。

用法：python iv_test_oracle.py <card1995.csv>
"""

import hashlib
import json
import sys

import numpy as np
import pandas as pd
import statsmodels.api as sm
from scipy import stats

CONTROLS = ["exper", "expersq", "black", "south", "smsa"]
DEPENDENT = "lwage"
ENDOGENOUS = "educ"


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def two_stage_least_squares(y, X, Z):
    """手算 2SLS：beta = (X'P_Z X)^-1 X'P_Z y，P_Z 为对 Z 的投影阵。"""
    ZtZ_inv = np.linalg.pinv(Z.T @ Z)
    Xhat = Z @ (ZtZ_inv @ (Z.T @ X))
    beta = np.linalg.pinv(Xhat.T @ X) @ (Xhat.T @ y)
    resid = y - X @ beta
    return beta, resid, Xhat


def diagnostics(frame: pd.DataFrame, instruments: list[str]) -> dict:
    used = frame.dropna(subset=[DEPENDENT, ENDOGENOUS, *CONTROLS, *instruments]).copy()
    n = len(used)

    y = used[DEPENDENT].astype(float).to_numpy()
    endog = used[ENDOGENOUS].astype(float).to_numpy()
    controls = sm.add_constant(used[CONTROLS].astype(float)).to_numpy()
    instr = used[instruments].astype(float).to_numpy()

    # ---- 1. 第一阶段：educ ~ const + 控制变量 + 工具变量 ----
    first_stage_X = np.column_stack([controls, instr])
    first_stage = sm.OLS(endog, first_stage_X).fit()
    # 对排除性工具变量的联合零假设。工具变量位于设计矩阵最后 len(instruments) 列。
    k_exog = controls.shape[1]
    q = len(instruments)
    restriction = np.zeros((q, first_stage_X.shape[1]))
    for i in range(q):
        restriction[i, k_exog + i] = 1.0
    # 产品用稳健协方差，第一阶段 Wald 也必须用 HC0；f_test 返回 chi2/q，乘回 q 得 chi2 形式。
    robust_wald = sm.OLS(endog, first_stage_X).fit(cov_type="HC0").f_test(restriction)
    first_stage_chi2 = float(np.squeeze(robust_wald.fvalue)) * q

    # partial R²：控制变量吸收后，工具变量还能解释多少 educ 的变异
    endog_resid = sm.OLS(endog, controls).fit().resid
    instr_resid = np.column_stack([sm.OLS(instr[:, i], controls).fit().resid for i in range(q)])
    partial_r2 = float(sm.OLS(endog_resid, instr_resid).fit().rsquared)

    # ---- 2. DWH：控制函数法 ----
    vhat = first_stage.resid
    struct_X = np.column_stack([controls, endog, vhat])
    struct = sm.OLS(y, struct_X).fit()
    dwh_stat = float(struct.tvalues[-1]) ** 2  # Wu-Hausman 的等价形式（同方差标准误）
    dwh_p = float(struct.pvalues[-1])
    struct_robust = sm.OLS(y, struct_X).fit(cov_type="HC0")
    dwh_robust_stat = float(struct_robust.tvalues[-1]) ** 2  # Wooldridge 稳健回归型检验
    dwh_robust_p = float(struct_robust.pvalues[-1])

    # ---- 3. Sargan：2SLS 残差对全部外生变量回归的 N·R² ----
    X = np.column_stack([controls, endog])
    Z = np.column_stack([controls, instr])
    beta, resid_2sls, _ = two_stage_least_squares(y, X, Z)
    overid_df = q - 1  # 1 个内生变量
    if overid_df > 0:
        aux_r2 = float(sm.OLS(resid_2sls, Z).fit().rsquared)
        sargan_stat = n * aux_r2
        sargan_p = float(stats.chi2.sf(sargan_stat, overid_df))
    else:
        sargan_stat, sargan_p = None, None

    # OLS 对照
    ols = sm.OLS(y, X).fit()

    return {
        "instruments": instruments,
        "rowsUsed": int(n),
        "overIdentifyingRestrictions": int(overid_df),
        "firstStageFChi2": first_stage_chi2,
        "partialRSquared": partial_r2,
        "dwhStat": dwh_stat,
        "dwhPValue": dwh_p,
        "dwhRobustStat": dwh_robust_stat,
        "dwhRobustPValue": dwh_robust_p,
        "sarganStat": sargan_stat,
        "sarganPValue": sargan_p,
        "olsEstimate": float(ols.params[-1]),
        "ivEstimate": float(beta[-1]),
    }


def main() -> None:
    target = sys.argv[1]
    frame = pd.read_csv(target)
    payload = {
        "path": target,
        "sha256": sha256(target),
        "justIdentified": diagnostics(frame, ["nearc4"]),
        "overIdentified": diagnostics(frame, ["nearc4", "nearc2"]),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
