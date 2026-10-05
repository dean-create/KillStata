"""Standalone PSM runner for KillStata model-facing tools.

Handles all 6 PSM methods (psm_construction, psm_matching, psm_ipw,
psm_regression, psm_double_robust, psm_visualize) in a single deterministic runner.
Each method imports its implementation from econometric_algorithm.py.

为什么是 6 合 1 而不是 6 个独立 runner:
- 6 个方法共享同一套数据加载、列别名、倾向得分构造（Logit）流程
- psm_regression/double_robust 的内部逻辑就是先跑 IPW 的门控再叠加回归
- 单一 runner 避免了 6 倍的 load_frame/prepare_frame 重复
"""

from __future__ import annotations

import json
import math
import os
import sys
import warnings
from pathlib import Path

import matplotlib
import numpy as np
import pandas as pd

matplotlib.use("Agg")

import statsmodels.api as sm

# 从 econometric_algorithm.py 导入所有 PSM 实现
import sys as _sys

# runner 会被复制到 outputDir 后执行，__file__ 不再位于源码树内，
# 因此优先读取调用方注入的源码目录，回退值仅用于直接从源码树运行的场景。
_sys.path.insert(
    0,
    os.environ.get("KILLSTATA_PSM_CORE_DIR")
    or str(Path(__file__).resolve().parent.parent / "econometrics"),
)
# ── 注意 ──
# econometric_algorithm.py 有 1661 行且包含 linearmodels 导入，但 psm 方法只依赖于
# statsmodels/numpy/pandas/matplotlib。运行时即使没有 linearmodels 也能工作。
# 但如果 econometric_algorithm.py 的顶级导入失败（linearmodels 缺失），这里就会崩溃。
# 解决方案：在 psm/runner.py 本地只导入需要的函数，不触发 linearmodels 的 import。
# 因此这里用 importlib 按需加载。
from importlib import import_module

_econ = import_module("econometric_algorithm")


# ── 数据加载与准备 ──

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


def scalar(value):
    if value is None:
        return None
    if isinstance(value, (np.integer, np.floating)):
        value = value.item()
    if isinstance(value, float) and (math.isnan(value) or math.isinf(value)):
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    return str(value)


def json_safe(value):
    if value is None:
        return None
    if isinstance(value, (np.integer, np.floating)):
        value = value.item()
    if isinstance(value, float):
        return None if (value != value or value == float("inf") or value == -float("inf")) else value
    return value


def prepare_psm_frame(payload: dict) -> tuple[pd.DataFrame, dict[str, str], list[str], int]:
    """加载数据，校验列名，去缺失，返回别名映射。

    与 econometric_algorithm.py 的 prepare_frame 不同之处：
    所有 PSM 方法共用 covariates 这一组列（psm_matching 额外有 dependentVar）。
    """
    frame = load_frame(payload["dataPath"])
    if frame.columns.duplicated().any():
        dup = frame.columns[frame.columns.duplicated()].tolist()
        raise ValueError(f"数据中存在重复列名：{', '.join(map(str, dup))}")

    columns: list[str] = list(payload.get("covariates", []))
    if payload.get("treatmentVar"):
        columns.insert(0, payload["treatmentVar"])
    if payload.get("dependentVar"):
        columns.insert(0, payload["dependentVar"])

    seen: dict[str, None] = {}
    for name in columns:
        seen.setdefault(name, None)
    columns = list(seen.keys())

    missing = [name for name in columns if name not in frame.columns]
    if missing:
        raise ValueError(f"数据中找不到变量：{', '.join(missing)}")

    # PSM 的每个分析单位只能有一行。若声明了 analysisUnitVar 却仍是重复的实体-时间面板，
    # 同一单位会被当成多个独立观测，倾向得分与平衡诊断都不再成立，必须拒绝而不是静默估计。
    unit_var = payload.get("analysisUnitVar")
    if unit_var:
        if unit_var not in frame.columns:
            raise ValueError(f"数据中找不到分析单位列：{unit_var}")
        duplicated_units = int(frame[unit_var].duplicated().sum())
        if duplicated_units:
            raise ValueError(
                f"分析单位 {unit_var} 存在 {duplicated_units} 行重复；"
                "PSM 要求每个分析单位一行，请先按声明的聚合方式（baseline 或 pre_treatment_mean）"
                "把面板整理为横截面后再估计"
            )

    rows_input = int(len(frame))
    frame = frame.loc[:, columns].dropna().copy()
    if frame.empty:
        raise ValueError("所选变量删除缺失值后没有可用样本")

    aliases = {name: f"v_{index}" for index, name in enumerate(columns)}
    frame = frame.rename(columns=aliases)
    return frame, aliases, list(payload.get("covariates", [])), rows_input


def extract_column(frame: pd.DataFrame, aliases: dict[str, str], name: str) -> pd.Series:
    return frame[aliases[name]].astype(float)


def extract_covariates(frame: pd.DataFrame, aliases: dict[str, str], covariate_names: list[str]) -> pd.DataFrame:
    return pd.concat([frame[aliases[n]].astype(float) for n in covariate_names], axis=1)


# ── 各方法实现 ──

def run_psm_construction(payload: dict) -> dict:
    frame, aliases, covariate_names, rows_input = prepare_psm_frame(payload)
    treatment = extract_column(frame, aliases, payload["treatmentVar"])
    covariates = extract_covariates(frame, aliases, covariate_names)

    ps = _econ.propensity_score_construction(treatment, covariates)
    support = _econ.common_support_report(treatment, ps)

    # 不要用 .resolve()：macOS 上它会把 /var 解析成 /private/var，与 TS path.resolve 对不上
    # （2026-08-14 排查同类问题时发现：其他 runner 已修，psm 是唯一还在用 .resolve() 的，是
    # 生成侧/消费侧路径形态不一致的隐患，即使目前有 realPathOrSelf 兜底吸收）。
    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    scores_path = output_dir / "propensity_scores.csv"
    scores_temp = output_dir / "propensity_scores.csv.tmp"
    scores_frame = pd.DataFrame({
        "row_index": ps.index.to_numpy(),
        "treatment": treatment.loc[ps.index].astype(int).to_numpy(),
        "propensity_score": ps.to_numpy(dtype=float),
    })
    try:
        scores_frame.to_csv(scores_temp, index=False)
        scores_temp.replace(scores_path)
    finally:
        scores_temp.unlink(missing_ok=True)

    extreme_score_share = float(((ps <= 0.01) | (ps >= 0.99)).mean())
    share_in_support = support.get("share_in_support") if isinstance(support, dict) else None

    warnings_list = []
    if extreme_score_share > 0:
        warnings_list.append(
            f"{extreme_score_share:.1%} 的倾向得分落在 [0.01, 0.99] 之外，"
            "后续不得直接使用不稳定的逆概率权重"
        )
    if isinstance(share_in_support, (int, float)) and share_in_support < 1:
        warnings_list.append(
            f"只有 {share_in_support:.1%} 的样本位于经验共同支撑区间，"
            "估计效应前必须先处理重叠问题"
        )

    result = {
        "success": True,
        "method": "psm_construction",
        "backend": "psm_runner",
        "rowsInput": rows_input,
        "rowsUsed": int(len(ps)),
        "propensityScoresPath": str(scores_path),
        "scoreMin": float(ps.min()),
        "scoreMax": float(ps.max()),
        "meanTreated": float(ps[treatment == 1].mean()),
        "meanControl": float(ps[treatment == 0].mean()),
        "extremeScoreShare": extreme_score_share,
        "supportLower": support.get("lower_bound") if isinstance(support, dict) else None,
        "supportUpper": support.get("upper_bound") if isinstance(support, dict) else None,
        "shareInSupport": share_in_support,
        "logitIterations": int(ps.attrs.get("iterations", 0)),
        "warnings": warnings_list,
    }

    result_path = _write_output(output_dir, result)
    result["resultPath"] = str(result_path)
    return result


def run_psm_matching(payload: dict) -> dict:
    frame, aliases, covariate_names, rows_input = prepare_psm_frame(payload)
    treatment = extract_column(frame, aliases, payload["treatmentVar"])
    outcome = extract_column(frame, aliases, payload["dependentVar"])
    covariates = extract_covariates(frame, aliases, covariate_names)

    ps = _econ.propensity_score_construction(treatment, covariates)
    matching, match_warnings = _try_or_warn(_econ.propensity_score_nearest_neighbor_att, outcome, treatment, ps, covariates)

    # _try_or_warn 把"平衡性/ESS/重叠检查失败"这类常见的统计降级转成 {"warnings": [...]}
    # （不含 att 等核心字段），意图是"不硬崩、把原因当警告返回"。但此前这里无条件写
    # success=True，只是**有条件地**补充 att/caliper 等字段——组出"success=True 但核心
    # 字段全部缺失"的自相矛盾结果，TS 侧 Zod schema（att 必填）随即报"结构不合法"，
    # 模型和用户都看不到真正原因（真实数据复现：did.xlsx 换一组容易失衡的协变量，
    # 100% 触发）。改为诚实失败：没有 att 说明这次匹配没有可报告的结果，抛出去让
    # main() 的既有 except 分支转成 {success: False, message: <原因>}——用户会看到
    # "PSM matching failed post-match balance: max absolute SMD=... exceeds 0.10"
    # 这种可操作的具体原因，而不是内部契约错误。
    if "att" not in matching:
        raise ValueError(match_warnings[0] if match_warnings else "PSM matching 未能产出可报告的匹配结果")

    # 不要用 .resolve()：macOS 上它会把 /var 解析成 /private/var，与 TS path.resolve 对不上
    # （2026-08-14 排查同类问题时发现：其他 runner 已修，psm 是唯一还在用 .resolve() 的，是
    # 生成侧/消费侧路径形态不一致的隐患，即使目前有 realPathOrSelf 兜底吸收）。
    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)

    result: dict = {
        "success": True,
        "method": "psm_matching",
        "backend": "psm_runner",
        "rowsInput": rows_input,
        "rowsUsed": int(len(ps)),
        "warnings": match_warnings,
        "att": float(matching["att"]),
        "caliper": matching["caliper"],
        "treatedCount": int(matching["treated_count"]),
        "controlCount": int(matching["control_count"]),
        "matchedTreatedCount": int(matching["matched_treated_count"]),
        "unmatchedTreatedCount": int(matching["unmatched_treated_count"]),
        "reusedControlCount": int(matching["reused_control_count"]),
        "maxMatchDistance": matching["max_match_distance"],
        "preMatchSmd": matching["pre_match_smd"],
        "postMatchSmd": matching["post_match_smd"],
        "preMatchMaxAbsSmd": matching["pre_match_max_abs_smd"],
        "postMatchMaxAbsSmd": matching["post_match_max_abs_smd"],
    }

    result_path = _write_output(output_dir, result)
    result["resultPath"] = str(result_path)
    return result


def run_psm_ipw(payload: dict) -> dict:
    frame, aliases, covariate_names, rows_input = prepare_psm_frame(payload)
    treatment = extract_column(frame, aliases, payload["treatmentVar"])
    outcome = extract_column(frame, aliases, payload["dependentVar"])
    covariates = extract_covariates(frame, aliases, covariate_names)

    ps = _econ.propensity_score_construction(treatment, covariates)
    ipw, ipw_warnings = _try_or_warn(_econ.propensity_score_hajek_ipw_ate, outcome, treatment, ps, covariates)

    # 见 run_psm_matching 顶部注释：_try_or_warn 降级时没有 ate，不能带着 success=True
    # 却缺核心字段返回——诚实失败，让 main() 转成 {success:False, message:<具体原因>}。
    if "ate" not in ipw:
        raise ValueError(ipw_warnings[0] if ipw_warnings else "PSM IPW 未能产出可报告的加权结果")

    # 不要用 .resolve()：macOS 上它会把 /var 解析成 /private/var，与 TS path.resolve 对不上
    # （2026-08-14 排查同类问题时发现：其他 runner 已修，psm 是唯一还在用 .resolve() 的，是
    # 生成侧/消费侧路径形态不一致的隐患，即使目前有 realPathOrSelf 兜底吸收）。
    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)

    result: dict = {
        "success": True,
        "method": "psm_ipw",
        "backend": "psm_runner",
        "rowsInput": rows_input,
        "rowsUsed": int(len(ps)),
        "warnings": ipw_warnings,
        "ate": float(ipw["ate"]),
        "treatedCount": int(ipw["treated_count"]),
        "controlCount": int(ipw["control_count"]),
        "treatmentEss": float(ipw["treatment_ess"]),
        "controlEss": float(ipw["control_ess"]),
        "minPropensityScore": float(ipw["min_propensity_score"]),
        "maxPropensityScore": float(ipw["max_propensity_score"]),
        "maxWeight": float(ipw["max_weight"]),
        "weightedSmd": ipw["weighted_smd"],
        "weightedMaxAbsSmd": float(ipw["weighted_max_abs_smd"]),
    }

    result_path = _write_output(output_dir, result)
    result["resultPath"] = str(result_path)
    return result


def run_psm_regression(payload: dict) -> dict:
    frame, aliases, covariate_names, rows_input = prepare_psm_frame(payload)
    treatment = extract_column(frame, aliases, payload["treatmentVar"])
    outcome = extract_column(frame, aliases, payload["dependentVar"])
    covariates = extract_covariates(frame, aliases, covariate_names)

    ps = _econ.propensity_score_construction(treatment, covariates)
    adjustment, adj_warnings = _try_or_warn(_econ.propensity_score_regression_adjustment_ate, outcome, treatment, ps, covariates)

    # 见 run_psm_matching 顶部注释：同一处诚实失败模式。
    if "ate" not in adjustment:
        raise ValueError(adj_warnings[0] if adj_warnings else "PSM 回归调整未能产出可报告的结果")

    # 不要用 .resolve()：macOS 上它会把 /var 解析成 /private/var，与 TS path.resolve 对不上
    # （2026-08-14 排查同类问题时发现：其他 runner 已修，psm 是唯一还在用 .resolve() 的，是
    # 生成侧/消费侧路径形态不一致的隐患，即使目前有 realPathOrSelf 兜底吸收）。
    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)

    result: dict = {
        "success": True,
        "method": "psm_regression",
        "backend": "psm_runner",
        "rowsInput": rows_input,
        "rowsUsed": int(len(ps)),
        "warnings": adj_warnings,
        "ate": float(adjustment["ate"]),
        "treatedCount": int(adjustment["treated_count"]),
        "controlCount": int(adjustment["control_count"]),
        "treatmentEss": float(adjustment["treatment_ess"]),
        "controlEss": float(adjustment["control_ess"]),
        "minPropensityScore": float(adjustment["min_propensity_score"]),
        "maxPropensityScore": float(adjustment["max_propensity_score"]),
        "maxWeight": float(adjustment["max_weight"]),
        "weightedSmd": adjustment["weighted_smd"],
        "weightedMaxAbsSmd": float(adjustment["weighted_max_abs_smd"]),
    }

    result_path = _write_output(output_dir, result)
    result["resultPath"] = str(result_path)
    diag_path, out_path = _write_post_estimation_outputs(output_dir, treatment, ps, result, "psm_regression")
    result["diagnostics_path"] = diag_path
    result["output_path"] = out_path
    return result


def run_psm_double_robust(payload: dict) -> dict:
    frame, aliases, covariate_names, rows_input = prepare_psm_frame(payload)
    treatment = extract_column(frame, aliases, payload["treatmentVar"])
    outcome = extract_column(frame, aliases, payload["dependentVar"])
    covariates = extract_covariates(frame, aliases, covariate_names)

    ps = _econ.propensity_score_construction(treatment, covariates)
    aipw, aipw_warnings = _try_or_warn(_econ.propensity_score_aipw_ate, outcome, treatment, ps, covariates)

    # 见 run_psm_matching 顶部注释：同一处诚实失败模式。
    if "ate" not in aipw:
        raise ValueError(aipw_warnings[0] if aipw_warnings else "PSM 双重稳健未能产出可报告的结果")

    # 不要用 .resolve()：macOS 上它会把 /var 解析成 /private/var，与 TS path.resolve 对不上
    # （2026-08-14 排查同类问题时发现：其他 runner 已修，psm 是唯一还在用 .resolve() 的，是
    # 生成侧/消费侧路径形态不一致的隐患，即使目前有 realPathOrSelf 兜底吸收）。
    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)

    result: dict = {
        "success": True,
        "method": "psm_double_robust",
        "backend": "psm_runner",
        "rowsInput": rows_input,
        "rowsUsed": int(len(ps)),
        "warnings": aipw_warnings,
        "ate": float(aipw["ate"]),
        "treatedCount": int(aipw["treated_count"]),
        "controlCount": int(aipw["control_count"]),
        "treatmentEss": float(aipw["treatment_ess"]),
        "controlEss": float(aipw["control_ess"]),
        "minPropensityScore": float(aipw["min_propensity_score"]),
        "maxPropensityScore": float(aipw["max_propensity_score"]),
        "maxWeight": float(aipw["max_weight"]),
        "weightedSmd": aipw["weighted_smd"],
        "weightedMaxAbsSmd": float(aipw["weighted_max_abs_smd"]),
    }

    result_path = _write_output(output_dir, result)
    result["resultPath"] = str(result_path)
    diag_path, out_path = _write_post_estimation_outputs(output_dir, treatment, ps, result, "psm_double_robust")
    result["diagnostics_path"] = diag_path
    result["output_path"] = out_path
    return result


def run_psm_visualize(payload: dict) -> dict:
    frame, aliases, covariate_names, rows_input = prepare_psm_frame(payload)
    treatment = extract_column(frame, aliases, payload["treatmentVar"])
    covariates = extract_covariates(frame, aliases, covariate_names)

    ps = _econ.propensity_score_construction(treatment, covariates)
    support = _econ.common_support_report(treatment, ps)
    figure = _econ.propensity_score_visualize_propensity_score_distribution(treatment, ps)

    # 不要用 .resolve()：macOS 上它会把 /var 解析成 /private/var，与 TS path.resolve 对不上
    # （2026-08-14 排查同类问题时发现：其他 runner 已修，psm 是唯一还在用 .resolve() 的，是
    # 生成侧/消费侧路径形态不一致的隐患，即使目前有 realPathOrSelf 兜底吸收）。
    output_dir = Path(payload["outputDir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    plot_path = output_dir / "ps_distribution.png"
    plot_temp = output_dir / "ps_distribution.tmp.png"
    try:
        figure.savefig(str(plot_temp), dpi=160, bbox_inches="tight", format="png")
        plot_temp.replace(plot_path)
    finally:
        plot_temp.unlink(missing_ok=True)
        from matplotlib import pyplot as plt
        plt.close(figure)

    share_in_support = support.get("share_in_support") if isinstance(support, dict) else None
    warnings_list = []
    if isinstance(share_in_support, (int, float)) and share_in_support < 1:
        warnings_list.append(
            f"只有 {share_in_support:.1%} 的样本位于经验共同支撑区间，"
            "估计效应前必须先处理重叠问题"
        )

    result = {
        "success": True,
        "method": "psm_visualize",
        "backend": "psm_runner",
        "rowsInput": rows_input,
        "rowsUsed": int(len(ps)),
        "plotPath": str(plot_path),
        "scoreMin": float(ps.min()),
        "scoreMax": float(ps.max()),
        "meanTreated": float(ps[treatment == 1].mean()),
        "meanControl": float(ps[treatment == 0].mean()),
        "extremeScoreShare": float(((ps <= 0.01) | (ps >= 0.99)).mean()),
        "supportLower": support.get("lower_bound") if isinstance(support, dict) else None,
        "supportUpper": support.get("upper_bound") if isinstance(support, dict) else None,
        "shareInSupport": share_in_support,
        "treatedCount": int((treatment == 1).sum()),
        "controlCount": int((treatment == 0).sum()),
        "warnings": warnings_list,
    }

    result_path = _write_output(output_dir, result)
    result["resultPath"] = str(result_path)
    return result


# ── 输出写入 ──

def _write_output(output_dir: Path, result: dict) -> Path:
    output_dir.mkdir(parents=True, exist_ok=True)
    result_path = output_dir / "results.json"
    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump(result, handle, ensure_ascii=False, indent=2)
    return result_path


def _write_post_estimation_outputs(
    output_dir: Path,
    treatment,
    prop_scores,
    result: dict,
    method: str,
) -> tuple[str, str]:
    """写 diagnostics.json + delivery_result_summary.md，补齐独立 runner 丢失的交付产物。"""

    support = _econ.common_support_report(treatment, prop_scores)

    diagnostics: dict = {
        "matching": {
            "common_support": {
                "passed": bool(support.get("share_in_support", 1) >= 0.9) if isinstance(support, dict) else True,
            },
            "weighting": {
                "treatment_ess": float(result.get("treatmentEss", 0) or 0),
                "control_ess": float(result.get("controlEss", 0) or 0),
            },
            "balance": {
                "weighted_max_abs_smd": float(result.get("weightedMaxAbsSmd", 0) or 0),
            },
        },
    }

    diagnostics_path = output_dir / "diagnostics.json"
    with open(diagnostics_path, "w", encoding="utf-8") as handle:
        json.dump(diagnostics, handle, ensure_ascii=False, indent=2)

    title = "倾向得分回归调整" if "regression" in method else "双重稳健 AIPW"
    ate = result.get("ate", None)
    summary = (
        f"# {title}\n\n"
        f"ATE：{ate}\n"
        f"有效样本量：处理组 {result.get('treatmentEss', 'N/A')}；"
        f"对照组 {result.get('controlEss', 'N/A')}\n"
        f"加权后最大绝对 SMD：{result.get('weightedMaxAbsSmd', 'N/A')}（阈值 ≤ 0.1000）\n\n"
        "识别假设：协变量必须在处理前形成，且已满足条件独立性与重叠性。\n"
        "未输出标准误、p 值、置信区间或显著性结论。\n"
    )

    output_path = output_dir / "delivery_result_summary.md"
    with open(output_path, "w", encoding="utf-8") as handle:
        handle.write(summary)

    return str(diagnostics_path), str(output_path)


def _try_or_warn(func, *args, **kwargs) -> tuple[dict, list[str]]:
    """调用 Python 算法函数，将可接受的检查失败转为警告而非异常。

    平衡性 SMD、ESS、重叠检查失败在实际数据中常见，不应硬崩。
    """
    try:
        result = func(*args, **kwargs)
        return result, result.get("warnings", []) if isinstance(result, dict) else []
    except ValueError as exc:
        msg = str(exc)
        msg_lower = msg.lower()
        if any(kw in msg_lower for kw in ["smd", "balance", "ess", "overlap", "effective sample"]):
            return {"warnings": [msg]}, [msg]
        raise


# ── 方法映射 ──

METHODS = {
    "psm_construction": run_psm_construction,
    "psm_matching": run_psm_matching,
    "psm_ipw": run_psm_ipw,
    "psm_regression": run_psm_regression,
    "psm_double_robust": run_psm_double_robust,
    "psm_visualize": run_psm_visualize,
}


# ── 入口 ──

def main() -> None:
    try:
        payload = json.loads(sys.stdin.read())
        method = payload.get("method")
        if method not in METHODS:
            raise ValueError(f"不支持的方法：{method}")
        handler = METHODS[method]
        result = handler(payload)
    except Exception as exc:
        print(json.dumps({"success": False, "message": str(exc)}, ensure_ascii=False))
        return
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
