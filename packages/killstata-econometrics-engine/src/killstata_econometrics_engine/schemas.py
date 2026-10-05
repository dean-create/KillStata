"""Python Registry 的参数契约。

这些模型同时承担运行时校验和 JSON Schema 生成，避免 Python 与 TypeScript
各维护一份容易漂移的方法参数定义。严格模式是刻意的：JSON 中的字符串、
数字和布尔值不能被静默转换成另一种类型。
"""

from __future__ import annotations

import json
import math
from typing import Annotated, Any, ClassVar, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator


NonEmptyString = Annotated[str, Field(min_length=1)]
Covariance = Literal["nonrobust", "robust", "HC1", "HC2", "HC3", "clustered"]
TRANSPORT_ALIAS_MAP = {
    "dependent_var": "dependentVar",
    "treatment_var": "treatmentVar",
    "entity_var": "entityVar",
    "time_var": "timeVar",
    "cluster_var": "clusterVar",
    "fixed_effects": "fixedEffects",
    "cluster_vars": "clusterVars",
    "instrument_vars": "instrumentVars",
    "relative_time_var": "relativeTimeVar",
    "cohort_var": "cohortVar",
    "analysis_unit_var": "analysisUnitVar",
    "pre_treatment_aggregation": "preTreatmentAggregation",
    "weights_var": "weightsVar",
    "running_var": "runningVar",
    "fuzzy_var": "fuzzyVar",
    "group_var": "groupVar",
    "post_var": "postVar",
}
INDEPENDENT_VARS_ALIASES = ("independent_vars", "independentVars")
METHOD_ARGUMENT_ALIASES = (*TRANSPORT_ALIAS_MAP, *INDEPENDENT_VARS_ALIASES)
OLS_ROBUST_ALIASES = ("robust_se", "robustSE")
OLS_CONFIDENCE_ALIASES = ("confidence_level", "confidenceLevel")
HDFE_EXTRA_ALIASES = ("entityVar", "timeVar", "clusterVar")
OLS_ARGUMENT_ALIASES = (*METHOD_ARGUMENT_ALIASES, *OLS_ROBUST_ALIASES, *OLS_CONFIDENCE_ALIASES)
HDFE_ARGUMENT_ALIASES = (*METHOD_ARGUMENT_ALIASES, *HDFE_EXTRA_ALIASES)


class MethodArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    accepted_input_aliases: ClassVar[tuple[str, ...]] = METHOD_ARGUMENT_ALIASES

    dependentVar: NonEmptyString | None = Field(default=None, description="数据中真实存在的结果变量列名。")
    treatmentVar: NonEmptyString | None = Field(default=None, description="数据中真实存在的核心解释变量列名。")
    covariates: list[NonEmptyString] = Field(default_factory=list, description="数据中真实存在的控制变量列名，可为空。")
    covariance: Covariance = Field(default="HC1", description="协方差估计方式；未指定时使用 HC1。")

    @model_validator(mode="before")
    @classmethod
    def normalize_transport_aliases(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        if "dependentVar" not in data and isinstance(data.get("dependent_var"), str):
            data["dependentVar"] = data.pop("dependent_var")
        if "treatmentVar" not in data and isinstance(data.get("treatment_var"), str):
            data["treatmentVar"] = data.pop("treatment_var")
        if "treatmentVar" not in data:
            independent = next((data[field] for field in INDEPENDENT_VARS_ALIASES if field in data), None)
            if isinstance(independent, list) and len(independent) == 1 and isinstance(independent[0], str):
                data["treatmentVar"] = independent[0]
                for field in INDEPENDENT_VARS_ALIASES:
                    data.pop(field, None)
        for legacy, canonical in TRANSPORT_ALIAS_MAP.items():
            if canonical not in data and legacy in data:
                data[canonical] = data.pop(legacy)
        for field in ("covariates", "fixedEffects", "clusterVars", "instrumentVars"):
            current = data.get(field)
            if current == "":
                data[field] = []
            elif isinstance(current, dict) and set(current) == {"item"}:
                item = current["item"]
                data[field] = item if isinstance(item, list) else [item] if isinstance(item, str) and item.strip() else []
            elif isinstance(current, str):
                try:
                    parsed = json.loads(current)
                except json.JSONDecodeError:
                    continue
                if isinstance(parsed, list):
                    data[field] = parsed
        return data


class RegressionArguments(MethodArguments):
    dependentVar: NonEmptyString = Field(description="用户明确指定的数据中真实存在的结果变量列名。")
    treatmentVar: NonEmptyString = Field(description="用户明确指定的数据中真实存在的核心解释变量列名。")


class OLSArguments(RegressionArguments):
    accepted_input_aliases: ClassVar[tuple[str, ...]] = OLS_ARGUMENT_ALIASES
    covariance: Literal["nonrobust", "robust", "HC1", "HC2", "HC3"] = Field(default="HC1", description="标准误协方差口径；默认使用 HC1 稳健标准误。")

    @model_validator(mode="before")
    @classmethod
    def normalize_ols_aliases(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        robust_field = next((field for field in OLS_ROBUST_ALIASES if field in data), None)
        if robust_field:
            raw = data[robust_field]
            robust = raw if isinstance(raw, bool) else raw.lower() == "true" if isinstance(raw, str) and raw.lower() in {"true", "false"} else None
            covariance = data.get("covariance")
            equivalent = robust is not None and (
                covariance is None or
                (robust and str(covariance) in {"robust", "HC1", "HC2", "HC3"}) or
                (not robust and covariance == "nonrobust")
            )
            if equivalent:
                data.setdefault("covariance", "HC1" if robust else "nonrobust")
                data.pop(robust_field, None)
        confidence = next((data[field] for field in OLS_CONFIDENCE_ALIASES if field in data), None)
        try:
            if confidence is not None and float(confidence) == 0.95:
                for field in OLS_CONFIDENCE_ALIASES:
                    data.pop(field, None)
        except (TypeError, ValueError):
            pass
        return data


class PanelFEArguments(RegressionArguments):
    entityVar: NonEmptyString | None = Field(default=None, description="面板实体列名。")
    timeVar: NonEmptyString | None = Field(default=None, description="面板时间列名。")
    clusterVar: NonEmptyString | None = Field(default=None, description="聚类稳健标准误使用的列名。")
    covariance: Literal["robust", "unadjusted", "clustered"] = Field(default="robust", description="稳健、非稳健或按 clusterVar 聚类的协方差口径。")

    @model_validator(mode="before")
    @classmethod
    def normalize_panel_aliases(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        if data.get("covariance") == "cluster":
            data["covariance"] = "clustered"
        effects = data.get("fixedEffects")
        entity = data.get(HDFE_EXTRA_ALIASES[0])
        time = data.get(HDFE_EXTRA_ALIASES[1])
        if isinstance(effects, list):
            mapped = [entity if item == "entity" and isinstance(entity, str) else time if item == "time" and isinstance(time, str) else item for item in effects]
            if entity and time and len(mapped) == 2 and set(mapped) == {entity, time}:
                data.pop("fixedEffects", None)
            else:
                data["fixedEffects"] = mapped
        return data


class PanelREArguments(RegressionArguments):
    entityVar: NonEmptyString | None = Field(default=None, description="面板实体列名。")
    timeVar: NonEmptyString | None = Field(default=None, description="面板时间列名。")
    covariance: Literal["robust", "unadjusted"] = Field(default="robust", description="随机效应估计使用的稳健或非稳健协方差口径。")


class HDFEArguments(RegressionArguments):
    accepted_input_aliases: ClassVar[tuple[str, ...]] = HDFE_ARGUMENT_ALIASES
    fixedEffects: list[NonEmptyString] = Field(min_length=1, description="需要吸收的固定效应列名。")
    clusterVars: list[NonEmptyString] = Field(default_factory=list, description="聚类稳健标准误使用的列名。")
    covariance: Literal["HC1", "CRV1", "CRV3"] = Field(default="HC1", description="HC1 异方差稳健或 CRV1/CRV3 聚类协方差口径。")

    @model_validator(mode="before")
    @classmethod
    def normalize_hdfe_aliases(cls, value: Any) -> Any:
        if not isinstance(value, dict):
            return value
        data = dict(value)
        entity = data.get("entityVar")
        time = data.get("timeVar")
        if not isinstance(data.get("fixedEffects"), list) and isinstance(entity, str) and isinstance(time, str):
            data["fixedEffects"] = [entity, time]
        cluster = data.get(HDFE_EXTRA_ALIASES[2])
        if not isinstance(data.get("clusterVars"), list) and isinstance(cluster, str):
            data["clusterVars"] = [cluster]
        if data.get("covariance") == "robust":
            data["covariance"] = "HC1"
        elif data.get("covariance") in {"clustered", "cluster"}:
            data["covariance"] = "CRV1"
        for field in HDFE_EXTRA_ALIASES:
            data.pop(field, None)
        return data


class IVArguments(RegressionArguments):
    instrumentVars: list[NonEmptyString] = Field(min_length=1, description="有理论依据的工具变量列名。")
    instrumentJustification: Annotated[str, Field(min_length=10, description="说明工具变量相关性、外生性和排除限制的具体研究依据；不得只写“工具变量有效”。")]
    covariance: Literal["robust", "unadjusted"] = Field(default="robust", description="2SLS 使用的稳健或非稳健协方差口径。")


class IVTestArguments(RegressionArguments):
    instrumentVars: list[NonEmptyString] = Field(min_length=1, description="待检验的工具变量列名。")


class StaticDIDArguments(MethodArguments):
    dependentVar: NonEmptyString = Field(description="实际结果变量列名。")
    groupVar: NonEmptyString = Field(description="已按研究设计定义的二元处理组/对照组列名。")
    postVar: NonEmptyString = Field(description="已按政策时点定义的政策前/后列名；不得由工具自行构造。")


class StaggeredDIDArguments(RegressionArguments):
    entityVar: NonEmptyString = Field(description="唯一标识面板实体的真实列名。")
    timeVar: NonEmptyString = Field(description="表示时期的真实列名。")
    cohortVar: NonEmptyString | None = Field(default=None, description="首次处理时期列；仅当相对时期列未能直接表达所需 cohort 时提供。若提供，缺失值可表示从未处理单位并保留在样本中。")
    relativeTimeVar: NonEmptyString = Field(description="已经按用户研究设计构造的相对处理时间列。")
    clusterVar: NonEmptyString | None = Field(default=None, description="有研究设计依据的聚类层级列。")
    referencePeriod: float | None = Field(default=None, description="事件研究参考时期，须与 relativeTimeVar 的编码一致。")


class EventStudyArguments(RegressionArguments):
    entityVar: NonEmptyString = Field(description="唯一标识面板实体的真实列名。")
    timeVar: NonEmptyString = Field(description="表示时期的真实列名。")
    cohortVar: NonEmptyString = Field(description="各实体首次接受处理的时期列。")
    neverTreatedCohortValue: Literal[0] | None = Field(default=None, description="仅当用户明确确认 cohort 缺失表示从未处理时设为 0；只在事件研究计算副本中映射，不修改原始数据。")
    clusterVar: NonEmptyString = Field(description="按研究设计确定的聚类标准误分组列。")
    relativeTimeVar: NonEmptyString | None = Field(default=None, description="已存在时使用的相对处理时间列；不得凭空生成。")
    referencePeriod: float | None = Field(default=None, description="事件研究中作为比较基准的相对时期。")
    aggregateAtt: bool | None = Field(default=None, description="是否报告聚合 ATT；省略时按方法默认处理。")


class TreatmentOnlyArguments(MethodArguments):
    treatmentVar: NonEmptyString = Field(description="实际的二元处理变量列名，必须完整且只有 0/1 两类。")
    analysisUnitVar: NonEmptyString = Field(description="PSM 分析单位唯一标识列；当前数据阶段必须每个分析单位仅一行，面板需先经研究者确认时点/聚合并生成横截面阶段。")


class PSMAnalysisArguments(MethodArguments):
    dependentVar: NonEmptyString = Field(description="用户指定的结果变量真实列名。")
    treatmentVar: NonEmptyString = Field(description="二元处理变量真实列名，必须只有 0/1 两类。")
    analysisUnitVar: NonEmptyString = Field(description="分析单位的唯一标识列；聚合前数据需明确实体单位。")
    preTreatmentAggregation: Literal["not_applicable", "baseline", "pre_treatment_mean"] = Field(description="面板转分析单位时的前处理期聚合方式；仅按已确认的设计选择。")


class GLMArguments(RegressionArguments):
    covariance: Literal["nonrobust", "robust"] = Field(default="nonrobust", description="广义线性模型支持的非稳健或稳健协方差口径。")


class LogitArguments(GLMArguments):
    pass


class ProbitArguments(GLMArguments):
    pass


class PoissonArguments(RegressionArguments):
    covariance: Literal["nonrobust", "robust"] = Field(default="nonrobust", description="Poisson/PPML 支持的非稳健或稳健协方差口径。")


class NegativeBinomialArguments(RegressionArguments):
    covariance: Literal["nonrobust", "robust"] = Field(default="nonrobust", description="负二项回归支持的非稳健或稳健协方差口径。")


class QuantileArguments(RegressionArguments):
    quantiles: list[float] = Field(
        default_factory=lambda: [0.25, 0.5, 0.75],
        min_length=1,
        description="需要估计的分位点，例如 0.25、0.5、0.75。",
    )
    covariance: Literal["robust", "iid"] = Field(default="robust", description="分位数回归使用稳健或 iid 协方差估计。")


class RDDSharpArguments(MethodArguments):
    dependentVar: NonEmptyString = Field(description="断点设计中的结果变量真实列名。")
    runningVar: NonEmptyString = Field(description="决定个体是否跨过处理阈值的连续运行变量列名。")
    cutoff: float = Field(description="必须由用户或研究设计明确提供的断点值；不得默认或猜测。")
    clusterVar: NonEmptyString | None = Field(default=None, description="可选的观测聚类标识列。存在同一学校、地区等簇内相关时可指定，以 CR1 聚类协方差推断。")


class RDDFuzzyArguments(MethodArguments):
    dependentVar: NonEmptyString = Field(description="模糊断点设计中的结果变量真实列名。")
    runningVar: NonEmptyString = Field(description="决定跨越阈值的连续运行变量列名。")
    fuzzyVar: NonEmptyString = Field(description="阈值处处理概率发生跳变但不完全由阈值决定的实际处理状态或处理剂量列名。")
    cutoff: float = Field(description="必须由用户或研究设计明确提供的断点值；不得默认或猜测。")
    clusterVar: NonEmptyString | None = Field(default=None, description="可选的观测聚类标识列；存在同一学校、地区等簇内相关时可指定，以 CR1 聚类协方差推断。")


class MultinomialArguments(RegressionArguments):
    covariance: Literal["nonrobust", "robust"] = Field(default="nonrobust", description="多项 Logit 支持的非稳健或稳健协方差口径。")


class RobustArguments(RegressionArguments):
    psi: Literal["huber", "hampel", "tukey"] = Field(default="huber", description="M 估计的稳健损失函数。")
    covariance: Literal["robust"] = Field(default="robust", description="稳健回归固定使用 robust 协方差。")


class WLSArguments(RegressionArguments):
    weightsVar: NonEmptyString = Field(description="当前数据中已存在、严格为正且有来源依据的逆误差方差权重列（w 与 1/Var(误差) 成比例）；抽样权重、频数权重或任意正数不能直接当作 WLS 权重。")
    covariance: Literal["nonrobust", "robust"] = Field(default="nonrobust", description="标准误口径；robust 使用 HC1 异方差稳健协方差，nonrobust 使用经典 WLS 协方差。")


PreprocessMethod = Literal[
    "listwise_deletion", "mean_impute", "median_impute", "knn_impute", "zscore_detect", "iqr_detect",
    "winsorize", "trim", "zscore_standardize", "minmax_scale", "robust_scale", "log_transform",
    "boxcox_transform", "yeojohnson_transform", "fill_constant", "forward_fill", "backward_fill",
    "linear_interpolate", "group_linear_interpolate", "regression_impute", "create_dummies",
    "combine_columns", "filter", "create_column", "create_relative_time", "coerce_numeric",
]
CreateColumnOperator = Literal["eq", "neq", "gt", "gte", "lt", "lte"]
FilterOperator = Literal["in", "not_in", "eq", "neq", "gt", "gte", "lt", "lte", "contains", "not_contains"]
FilterScalar = str | int | float | bool
NonNegativeFiniteWeight = Annotated[float, Field(ge=0, allow_inf_nan=False)]


class FilterRuleArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    column: NonEmptyString = Field(description="要筛选的真实列名。")
    operator: FilterOperator = Field(description="in/not_in 配合非空 values；其余比较配合 value；contains 按字面子串匹配。")
    value: FilterScalar | None = Field(default=None, description="单值比较或字面子串匹配的常量。")
    values: list[FilterScalar] | None = Field(default=None, min_length=1, description="in/not_in 必须提供的非空候选值列表。")
    caseSensitive: bool = Field(default=False, description="字符串比较是否区分大小写，默认 false。")

    @model_validator(mode="after")
    def validate_rule_arguments(self):
        if self.operator in ("in", "not_in"):
            if not self.values:
                raise ValueError("in/not_in 运算符必须提供非空 values")
            if self.value is not None:
                raise ValueError("in/not_in 运算符不能同时提供 value")
        else:
            if self.value is None:
                raise ValueError(f"{self.operator} 运算符必须提供 value")
            if self.values is not None:
                raise ValueError(f"{self.operator} 运算符不能提供 values")
        if self.operator in ("contains", "not_contains") and not isinstance(self.value, str):
            raise ValueError("contains/not_contains 的 value 必须是字符串")
        if self.operator in ("gt", "gte", "lt", "lte") and (
            self.value is None or isinstance(self.value, bool)
        ):
            raise ValueError("value 必须是数值或可解析的数值字符串，不能是布尔值")
        return self


class DataPreprocessOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    lower: float | None = Field(default=None, description="缩尾/截尾下尾比例，例如 0.01 表示底部 1%。")
    upper: float | None = Field(default=None, description="缩尾/截尾上尾比例，例如 0.01 表示顶部 1%；不是填上分位点 0.99。")
    threshold: float | None = Field(default=None, gt=0, description="zscore_detect 的正数 Z 阈值，例如 3。")
    factor: float | None = Field(default=None, gt=0, description="iqr_detect 的正数 IQR 倍数，例如 1.5。")
    k: int | None = Field(default=None, gt=0, description="knn_impute 的正整数邻居数。")
    offset: float | None = Field(default=None, description="log_transform 的有限平移量。")
    suffix: NonEmptyString | None = Field(default=None, max_length=32, description="新生成列名后缀，长度 1～32。")
    feature_range: list[float] | None = Field(default=None, min_length=2, max_length=2, description="minmax_scale 的递增目标范围。")
    shift: float | None = Field(default=None, description="boxcox_transform 的有限平移量。")
    value: str | float | int | None = Field(default=None, description="fill_constant 的常数值。")
    group_by: list[NonEmptyString] | None = Field(default=None, description="前向/后向填充的分组列。")
    entity_var: NonEmptyString | None = Field(default=None, description="面板实体列。")
    time_var: NonEmptyString | None = Field(default=None, description="时间或顺序列。")
    predictors: list[NonEmptyString] | None = Field(default=None, description="回归插补的预测变量。")
    drop_first: bool | None = Field(default=None, description="create_dummies 是否删除第一类。")
    output_column: NonEmptyString | None = Field(default=None, description="combine_columns/create_column/create_relative_time 必须提供的结果列名。")
    separator: NonEmptyString | None = Field(default=None, max_length=16, description="combine_columns 的分隔符。")
    rules: list[FilterRuleArguments] | None = Field(default=None, min_length=1, description="filter 的筛选规则。")
    operator: CreateColumnOperator | None = Field(default=None, description="create_column 的单次比较运算符。")
    right_value: str | float | int | None = Field(default=None, description="create_column 的右侧常量。")
    right_column: NonEmptyString | None = Field(default=None, description="create_column 的右侧列名。")
    cohort_var: NonEmptyString | None = Field(default=None, description="create_relative_time 的首次处理时期列；缺失表示从未处理，须由用户确认。")
    treatment_var: NonEmptyString | None = Field(default=None, description="create_relative_time 的 0/1 处理状态列；必须逐行符合 cohort 与 time 的关系。")
    missing_tokens: list[NonEmptyString] | None = Field(
        default=None,
        min_length=1,
        description="coerce_numeric 的精确缺失标记；仅在用户或数据源确认文本表示缺失时提供。其余无法解析的非空文本会报错，不会自动删除或重编码。",
    )

    @model_validator(mode="after")
    def validate_range(self):
        if self.feature_range is not None:
            if not all(math.isfinite(value) for value in self.feature_range):
                raise ValueError("feature_range 必须使用有限数值")
            if self.feature_range[0] >= self.feature_range[1]:
                raise ValueError("feature_range 必须递增")
        return self


class DataPreprocessArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    datasetId: NonEmptyString = Field(description="当前规范化数据集 ID，由 Harness 从活动阶段注入。")
    stageId: NonEmptyString = Field(description="当前规范化数据阶段 ID，由 Harness 从活动阶段注入。")
    outputPath: NonEmptyString = Field(description="由 Harness 在受控输出目录中生成的目标文件路径。")
    method: PreprocessMethod = Field(description="一次只执行一个已准入的数据预处理方法。")
    columns: list[NonEmptyString] = Field(default_factory=list, max_length=100, description="要处理的真实列；filter 可省略。")
    operator: CreateColumnOperator | None = Field(default=None, description="create_column 顶层兼容字段。")
    right_value: str | float | int | None = Field(default=None, description="create_column 顶层兼容字段。")
    right_column: NonEmptyString | None = Field(default=None, description="create_column 顶层兼容字段。")
    output_column: NonEmptyString | None = Field(default=None, description="create_column 顶层兼容字段。")
    options: DataPreprocessOptions = Field(default_factory=DataPreprocessOptions, description="当前 method 允许的专用参数。")

    @model_validator(mode="before")
    @classmethod
    def merge_create_column_compatibility_fields(cls, value: Any) -> Any:
        if not isinstance(value, dict) or value.get("method") != "create_column":
            return value
        data = dict(value)
        options = dict(data.get("options") or {})
        for field in ("operator", "right_value", "right_column", "output_column"):
            if data.get(field) is not None:
                options.setdefault(field, data[field])
            data.pop(field, None)
        data["options"] = options
        return data

    @model_validator(mode="after")
    def validate_method_contract(self):
        allowed = {
            "listwise_deletion": set(), "mean_impute": set(), "median_impute": set(),
            "knn_impute": {"k"}, "zscore_detect": {"threshold"}, "iqr_detect": {"factor"},
            "winsorize": {"lower", "upper"}, "trim": {"lower", "upper"},
            "zscore_standardize": {"suffix"}, "minmax_scale": {"suffix", "feature_range"},
            "robust_scale": {"suffix"}, "log_transform": {"offset", "suffix"},
            "boxcox_transform": {"suffix", "shift"}, "yeojohnson_transform": {"suffix"},
            "fill_constant": {"value"}, "forward_fill": {"group_by", "entity_var"},
            "backward_fill": {"group_by", "entity_var"}, "linear_interpolate": {"time_var"},
            "group_linear_interpolate": {"time_var", "entity_var"}, "regression_impute": {"predictors"},
            "create_dummies": {"drop_first"}, "combine_columns": {"output_column", "separator"},
            "filter": {"rules"}, "create_column": {"output_column", "operator", "right_value", "right_column"},
            "create_relative_time": {"entity_var", "time_var", "cohort_var", "treatment_var", "output_column"},
            "coerce_numeric": {"missing_tokens"},
        }
        options = self.options.model_dump(exclude_none=True)
        unexpected = set(options) - allowed[self.method]
        if unexpected:
            raise ValueError(f"{self.method} 不接受参数 {sorted(unexpected)[0]}")
        if self.method not in {"filter", "create_relative_time"} and not self.columns:
            raise ValueError(f"{self.method} 需要至少指定一列")
        if len(set(self.columns)) != len(self.columns):
            raise ValueError("列名不能重复")
        if self.options.lower is not None and self.options.upper is not None and self.options.lower + self.options.upper >= 1:
            raise ValueError("lower + upper 必须小于 1")
        if self.method == "create_column":
            if self.options.operator is None:
                raise ValueError("create_column 需要 operator（eq/neq/gt/gte/lt/lte）")
            if self.options.right_value is None and self.options.right_column is None:
                raise ValueError("create_column 需要 right_value 或 right_column 之一")
            if self.options.output_column is None:
                raise ValueError("create_column 需要 output_column")
        if self.method == "combine_columns":
            if len(self.columns) < 2:
                raise ValueError("combine_columns 至少需要两列")
            if self.options.output_column is None:
                raise ValueError("combine_columns 需要 output_column")
        if self.method == "create_relative_time":
            required = ("entity_var", "time_var", "cohort_var", "treatment_var", "output_column")
            missing = [field for field in required if getattr(self.options, field) is None]
            if missing:
                raise ValueError(f"create_relative_time 缺少必填 options：{', '.join(missing)}")
        return self


class CompositeIndicatorArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    column: NonEmptyString = Field(description="当前数据中的一个真实评价指标列名。")
    direction: Literal["benefit", "cost"] = Field(description="指标方向：越大越好用 benefit，越小越好用 cost。")


class CompositeEvaluationArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    datasetId: NonEmptyString = Field(description="当前规范化数据集 ID，由 Harness 注入。")
    stageId: NonEmptyString = Field(description="已完成质量检查的数据阶段 ID，由 Harness 注入。")
    expectedDataFingerprint: Annotated[str, Field(pattern=r"^sha256:[0-9a-f]{64}$")] | None = Field(
        default=None,
        description="当前输入阶段的数据诊断指纹，由 Harness 注入；不得由模型指定。",
    )
    method: Literal["entropy_weight", "topsis"] = Field(description="entropy_weight 生成熵权综合指数；若用户要求熵权 TOPSIS，必须选择 topsis。")
    idColumns: list[NonEmptyString] = Field(min_length=1, description="用于标识每行评价对象的真实 ID 列，可由多个列组成。")
    indicators: list["CompositeIndicatorArguments"] = Field(min_length=2, description="至少两个指标，并逐项明确 benefit/cost 方向。")
    scope: Literal["global", "by_group"] = Field(description="global 全样本统一评价；by_group 按 groupColumns 分组评价。")
    groupColumns: list[NonEmptyString] | None = Field(default=None, description="scope=by_group 时使用的分组列；global 时不得提供。")
    weightSource: Literal["equal", "manual", "entropy"] | None = Field(default=None, description="topsis 必须明确指定权重来源，不得默认等权；熵权 TOPSIS 必须为 entropy，手工权重必须为 manual。")
    manualWeights: dict[str, NonNegativeFiniteWeight] | None = Field(default=None, description="weightSource=manual 时，按指标列名提供权重，所有权重必须非负且总和为 1。")

    @model_validator(mode="after")
    def validate_research_contract(self):
        indicator_columns = [item.column for item in self.indicators]
        if len(set(indicator_columns)) != len(indicator_columns):
            raise ValueError("指标列不能重复")
        groups = set(self.groupColumns or [])
        if set(self.idColumns) & (set(indicator_columns) | groups) or set(indicator_columns) & groups:
            raise ValueError("ID、指标和分组列不能重叠")
        if self.scope == "by_group" and not self.groupColumns:
            raise ValueError("分组评价必须提供 groupColumns")
        if self.scope == "global" and self.groupColumns:
            raise ValueError("全局评价不能提供 groupColumns")
        if self.method == "entropy_weight" and self.weightSource not in (None, "entropy"):
            raise ValueError("entropy_weight 必须使用 entropy 权重来源")
        if self.method == "topsis" and self.weightSource is None:
            raise ValueError("topsis 必须明确提供 weightSource，不得默认等权")
        if self.weightSource == "manual":
            weights = self.manualWeights or {}
            if set(weights) != set(indicator_columns):
                raise ValueError("手工权重必须与指标一一对应")
            if abs(sum(weights.values()) - 1.0) > 1e-12:
                raise ValueError("manualWeights 手工权重之和必须为 1")
        elif self.manualWeights is not None:
            raise ValueError("仅 weightSource=manual 时可传手工权重")
        return self


class SheetPolicyArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    mode: Literal["first_sheet", "named_sheet"] = Field(default="first_sheet", description="Excel 工作表选择方式。")
    sheetName: NonEmptyString | None = Field(default=None, description="mode=named_sheet 时必须与工作簿中的名称完全一致。")
    headerRow: int | None = Field(default=None, ge=0, description="零基表头行号；省略时由第一行作为表头。")

    @model_validator(mode="after")
    def require_named_sheet(self):
        if self.mode == "named_sheet" and not self.sheetName:
            raise ValueError("sheetPolicy.mode=named_sheet 时必须提供 sheetName")
        return self


class DataImportArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    action: Literal["healthcheck", "import", "profile", "frequency", "correlation", "validate", "export", "rollback"] = Field(description="选择一个数据动作。常见用法：import 导入附件；profile 查看画像；validate 检查数据质量；frequency 查看有界频数；correlation 查看相关性；export 导出；rollback 回到指定历史阶段。")
    inputPath: NonEmptyString | None = Field(default=None, description="Harness 解析出的受控输入路径；模型不得填写或覆盖。")
    outputPath: NonEmptyString | None = Field(default=None, description="Harness 在受控目录中生成的输出路径；模型不得填写或覆盖。")
    format: Literal["csv", "xlsx", "dta", "parquet"] | None = Field(default=None, description="仅 action=export 时指定导出格式；其它动作不需要此字段。")
    datasetId: NonEmptyString | None = Field(default=None, description="当前活动 workflow 的数据集引用，由 Harness 注入；不得改指其他会话或历史数据集。")
    stageId: NonEmptyString | None = Field(default=None, description="必须与当前活动 workflow 的规范化数据阶段一致，由 Harness 注入；即使历史阶段仍存在也不得指定。")
    variables: list[NonEmptyString] | None = Field(default=None, description="需要查看的真实列名；省略时按动作使用当前完整列集。")
    groupBy: list[NonEmptyString] | None = Field(default=None, max_length=2, description="frequency 的分组列，最多两个真实列。")
    maxDistinct: int | None = Field(default=None, ge=1, le=1000, description="frequency 每个分组最多展示的不同取值数，范围 1～1000。")
    entityVar: NonEmptyString | None = Field(default=None, description="质量检查时指定的面板实体列。")
    timeVar: NonEmptyString | None = Field(default=None, description="质量检查时指定的时间列。")
    options: dict[str, Any] | None = Field(default=None, description="当前数据动作专用的附加参数；只传 Registry 描述的字段。")
    sheetPolicy: SheetPolicyArguments | None = Field(default=None, description="Excel 工作表读取策略；默认读取第一张表。")
    preserveLabels: bool = Field(default=True, description="导入 Stata/Excel 数据时是否保留变量标签。")
    runId: NonEmptyString | None = Field(default=None, description="已知工作流运行标识；通常省略并由 Harness 从当前阶段推断。")
    branch: NonEmptyString | None = Field(default=None, description="已知工作流分支；通常省略并由 Harness 从当前阶段推断。")
    stageLabel: NonEmptyString | None = Field(default=None, description="用户需要区分阶段时提供的简短显示名称。")
    rollbackStageId: NonEmptyString | None = Field(default=None, description="rollback 目标阶段 ID，必须来自当前数据集的真实阶段清单。")

    @model_validator(mode="after")
    def validate_action_contract(self):
        if self.action == "import" and not self.inputPath:
            raise ValueError("import 必须提供 inputPath")
        if self.action not in {"import", "healthcheck"}:
            if bool(self.datasetId) != bool(self.stageId):
                raise ValueError("datasetId 和 stageId 必须同时提供")
            if not self.inputPath and not (self.datasetId and self.stageId):
                raise ValueError(f"{self.action} 必须提供 inputPath，或同时提供 datasetId 与 stageId")
        return self


class EconometricsRecommendArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    datasetId: NonEmptyString = Field(description="当前会话规范化数据集 ID，由 TypeScript Harness 注入。")
    stageId: NonEmptyString = Field(description="当前会话规范化数据阶段 ID，由 TypeScript Harness 注入。")
    dependentVar: NonEmptyString | None = Field(default=None, description="已由用户或研究问题明确的结果变量真实列名。")
    treatmentVar: NonEmptyString | None = Field(default=None, description="已由用户或研究问题明确的核心解释变量真实列名。")
    entityVar: NonEmptyString | None = Field(default=None, description="已由用户明确或从唯一完整面板键核验得到的实体列名。")
    timeVar: NonEmptyString | None = Field(default=None, description="已由用户明确或从唯一完整面板键核验得到的时间列名。")


class HeterogeneityAlternativeSpecification(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: NonEmptyString = Field(description="替代规格的简短研究含义名称。")
    dependentVar: NonEmptyString | None = Field(default=None, description="仅当用户明确要求替换结果变量时提供真实列名。")
    treatmentVar: NonEmptyString | None = Field(default=None, description="仅当用户明确要求替换核心解释变量时提供真实列名。")
    covariates: list[NonEmptyString] | None = Field(default=None, description="该替代规格中明确的控制变量列名。")
    notes: NonEmptyString | None = Field(default=None, description="说明该替代规格的设计依据，不写未验证的结论。")


class HeterogeneityPlaceboSpecification(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    variables: list[NonEmptyString] | None = Field(default=None, description="用户已确定的安慰剂变量列名。")
    notes: NonEmptyString | None = Field(default=None, description="说明安慰剂设定依据；没有明确设计时不得自动构造。")


class HeterogeneityRunnerArguments(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    datasetId: NonEmptyString | None = Field(default=None, description="当前数据集引用，由 Harness 注入。")
    stageId: NonEmptyString | None = Field(default=None, description="当前数据阶段引用，由 Harness 注入。")
    expectedDataFingerprint: Annotated[str, Field(pattern=r"^sha256:[0-9a-f]{64}$")] | None = Field(
        default=None,
        description="当前阶段数据诊断指纹，由 Harness 注入；不得由模型指定。",
    )
    baselineResultDir: NonEmptyString | None = Field(default=None, description="已有基准估计结果目录；仅使用可信工作流产物，不得猜测本地路径。")
    baselineOutputKey: NonEmptyString | None = Field(default=None, description="当前数据阶段可信 FE/DID 基准结果的精确选择标识（不是路径）；仅有一个候选时可省略。多个结果的完整选择标识由工具返回；如果标识含有运行后缀，必须原样使用，不得猜测或截断。")
    directResultPath: NonEmptyString | None = Field(default=None, description="已有基准结果文件引用；必须来自可信产物，不能自行拼接路径。")
    methodFamily: Literal["fe", "did"] = Field(description="基准模型所属方法族。当前仅能运行规格可一一映射到线性 OLS+固定效应的 FE 扩展；did 仅用于识别并返回用户决策，当前不会把 DID2S、事件研究或传统 DID 静默替换为 LSDV。")
    dependentVar: NonEmptyString = Field(description="与已完成基准规格一致的结果变量真实列名。")
    treatmentVar: NonEmptyString = Field(description="与已完成基准规格一致的核心解释变量真实列名。")
    entityVar: NonEmptyString | None = Field(default=None, description="面板/处理单元实体列名；方法需要时须与基准结果一致。")
    timeVar: NonEmptyString | None = Field(default=None, description="时间列名；方法需要时须与基准结果一致。")
    clusterVar: NonEmptyString | None = Field(default=None, description="基准估计使用的聚类层级列名。")
    covariates: list[NonEmptyString] = Field(default_factory=list, description="与基准设定一致的控制变量列。")
    heterogeneityVars: list[NonEmptyString] = Field(
        default_factory=list,
        description="用户明确指定的异质性变量列。数值变量会同时按样本中位数分高/低组并生成中心化交互项；类别变量对所有非缺失类别分别估计，类别超过两种时交互规格标记为跳过。当前输入不能只选一种规格，调用前需确认用户接受完整规格集合。",
    )
    mechanismVars: list[NonEmptyString] = Field(default_factory=list, description="用户明确指定的机制变量列。")
    placebo: bool | HeterogeneityPlaceboSpecification | None = Field(default=None, description="用户明确指定的安慰剂变量或设定；不得自动生成。")
    alternativeSpecifications: list[HeterogeneityAlternativeSpecification] = Field(default_factory=list, description="用户明确要求的替代规格；每项必须说明研究含义。")
    runId: NonEmptyString | None = Field(default=None, description="工作流运行标识，由 Harness 从当前阶段注入。")
    branch: NonEmptyString | None = Field(default=None, description="工作流分支，由 Harness 从当前阶段注入。")
    outputDir: NonEmptyString | None = Field(default=None, description="受控结果输出目录，由 Harness 注入。")


INPUT_MODELS: dict[str, type[BaseModel]] = {
    "ols_regression": OLSArguments,
    "panel_fe_regression": PanelFEArguments,
    "panel_random_effects": PanelREArguments,
    "hdfe_regression": HDFEArguments,
    "iv_2sls": IVArguments,
    "iv_test": IVTestArguments,
    "did_static": StaticDIDArguments,
    "did2s": StaggeredDIDArguments,
    "did_event_study_saturated": EventStudyArguments,
    "psm_construction": TreatmentOnlyArguments,
    "psm_visualize": TreatmentOnlyArguments,
    "psm_matching": PSMAnalysisArguments,
    "psm_ipw": PSMAnalysisArguments,
    "psm_regression": PSMAnalysisArguments,
    "psm_double_robust": PSMAnalysisArguments,
    "logit_regression": LogitArguments,
    "probit_regression": ProbitArguments,
    "poisson_regression": PoissonArguments,
    "negbin_regression": NegativeBinomialArguments,
    "quantile_regression": QuantileArguments,
    "rdd_sharp": RDDSharpArguments,
    "rdd_fuzzy": RDDFuzzyArguments,
    "multinomial_logit": MultinomialArguments,
    "robust_regression": RobustArguments,
    "wls_regression": WLSArguments,
    "data_preprocess": DataPreprocessArguments,
    "composite_evaluation": CompositeEvaluationArguments,
    "data_import": DataImportArguments,
    "econometrics_recommend": EconometricsRecommendArguments,
    "heterogeneity_runner": HeterogeneityRunnerArguments,
}
