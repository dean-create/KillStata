from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Callable

from pydantic import BaseModel

from .errors import EngineError
from .schemas import INPUT_MODELS
from .capabilities import UnifiedToolDescriptor, descriptor_for
from .result_models import CapabilityResult

REGISTRY_VERSION = 2
Handler = Callable[[dict[str, Any]], dict[str, Any]]


def _handler_for(method_id: str) -> Handler:
    """延迟绑定执行器，避免 health/catalog/search 阶段加载科学计算依赖。"""

    def handler(payload: dict[str, Any]) -> dict[str, Any]:
        from .runner_bridge import execute_registered_method

        return execute_registered_method(method_id, payload)

    return handler


@dataclass(frozen=True)
class MethodSpec:
    method_id: str
    family: str
    aliases: tuple[str, ...]
    description_zh: str
    use_when_zh: str
    do_not_use_when_zh: str
    input_model: type[BaseModel]
    input_examples: tuple[dict[str, Any], ...]
    input_requirements_zh: tuple[str, ...]
    output_schema: dict[str, Any]
    diagnostic_requirements_zh: tuple[str, ...]
    dependencies: tuple[str, ...]
    runtime_injected_fields: tuple[str, ...]
    handler: Handler

    @property
    def input_schema(self) -> dict[str, Any]:
        """生成模型可见 Schema；Harness 自己维护的血缘字段不交给模型填写。"""
        schema = deepcopy(self.input_model.model_json_schema())
        properties = schema.get("properties")
        if isinstance(properties, dict):
            for field in self.runtime_injected_fields:
                properties.pop(field, None)
        required = schema.get("required")
        if isinstance(required, list):
            schema["required"] = [field for field in required if field not in self.runtime_injected_fields]
        if self.input_examples:
            schema["examples"] = deepcopy(list(self.input_examples))
        return schema

    def to_descriptor(self) -> UnifiedToolDescriptor:
        return descriptor_for(self)


def _spec(
    method_id: str,
    family: str,
    aliases: tuple[str, ...],
    description: str,
    *,
    use_when: str | None = None,
    do_not_use_when: str | None = None,
    requirements: tuple[str, ...] = (),
    diagnostics: tuple[str, ...] = (),
    dependencies: tuple[str, ...] = (),
    input_examples: tuple[dict[str, Any], ...] = (),
) -> MethodSpec:
    runtime_fields = {
        "data_import": ("datasetId", "stageId", "inputPath", "outputPath", "runId", "branch"),
        "data_preprocess": ("datasetId", "stageId", "outputPath"),
        "composite_evaluation": ("datasetId", "stageId", "expectedDataFingerprint"),
        "econometrics_recommend": ("datasetId", "stageId"),
        "heterogeneity_runner": (
            "datasetId", "stageId", "expectedDataFingerprint", "runId", "branch", "outputDir", "baselineResultDir", "directResultPath",
        ),
    }
    runtime_injected_fields = runtime_fields.get(method_id, ())
    return MethodSpec(
        method_id=method_id,
        family=family,
        aliases=aliases,
        description_zh=description,
        use_when_zh=use_when or description,
        do_not_use_when_zh=do_not_use_when or "变量角色、样本单位或方法前置条件不满足时不要调用。",
        input_model=INPUT_MODELS[method_id],
        input_examples=input_examples,
        input_requirements_zh=requirements,
        output_schema=CapabilityResult.model_json_schema(),
        diagnostic_requirements_zh=diagnostics,
        dependencies=dependencies,
        runtime_injected_fields=runtime_injected_fields,
        handler=_handler_for(method_id),
    )


def _build_registry() -> dict[str, MethodSpec]:
    specs = [
        _spec("ols_regression", "estimator", ("普通最小二乘", "普通最小二乘回归", "OLS回归", "基准回归"), "对连续结果变量执行 OLS 基准回归。", use_when="结果变量为连续数值，用户需要横截面或合并样本的线性基准关系时。", do_not_use_when="数据是面板且用户要求吸收个体/时间固定效应，或结果变量是二元、计数、分位数或存在明确内生性时不要用OLS。", requirements=("结果变量和核心解释变量必须为真实数值列。",), dependencies=("pandas", "numpy", "statsmodels")),
        _spec("panel_fe_regression", "estimator", ("面板固定效应", "面板固定效应回归", "双向固定效应", "固定效应面板回归"), "对面板数据执行个体和时间双向固定效应回归。", use_when="同一实体在多个时期重复观测，且需要控制实体不随时间变化因素和共同时间冲击时。", do_not_use_when="实体×时间键不唯一、没有重复时期，或用户要求的是随机效应、断点或DID专用识别时不要用本方法。", requirements=("实体×时间键必须唯一；entityVar和timeVar必须是数据中的真实列。",), dependencies=("pandas", "numpy", "linearmodels")),
        _spec("panel_random_effects", "estimator", ("随机效应", "随机效应面板"), "对面板数据执行随机效应估计并比较固定效应。", use_when="面板个体效应可合理视为与解释变量不相关，并希望估计时间不变变量时。", do_not_use_when="个体效应可能与解释变量相关，或实体×时间键不唯一时不要使用；需要比较FE/RE时必须同时报告Hausman诊断。", dependencies=("pandas", "numpy", "linearmodels")),
        _spec("hdfe_regression", "estimator", ("高维固定效应", "吸收固定效应", "HDFE"), "执行高维固定效应回归。", use_when="需要同时吸收多个高维分类固定效应，且研究设计已明确这些维度时。", do_not_use_when="固定效应列会吸收核心解释变量、聚类层级没有研究依据或只需要普通面板FE时不要调用。", requirements=("至少提供一个固定效应维度。",), dependencies=("pandas", "numpy", "pyfixest")),
        _spec(
            "iv_2sls", "estimator", ("两阶段最小二乘", "工具变量回归", "2SLS"), "执行工具变量两阶段最小二乘估计。",
            use_when="核心解释变量存在明确内生性担忧，并且用户提供了有理论依据的工具变量及排除限制说明时。",
            do_not_use_when="没有工具变量识别依据、工具变量与回归变量重叠或用户只是想要稳健标准误时不要调用。",
            requirements=("工具变量必须有相关性、外生性和排除限制依据。",),
            diagnostics=(
                "本方法只执行 2SLS 估计和第一阶段检验；用户要求内生性或过度识别诊断时，应继续搜索并执行 iv_test。",
                "返回第一阶段统计量及其实际分布；稳健协方差下可能是 Wald χ²，不能误称 F 或套用 F<10 经验阈值。",
                "工具变量的外生性和排除限制依赖研究设计；本次估计不能证明这些假设。",
            ),
            dependencies=("pandas", "numpy", "linearmodels"),
            input_examples=({"dependentVar": "outcome", "treatmentVar": "treatment", "instrumentVars": ["z"], "instrumentJustification": "格式示例：请替换为研究设计中关于相关性、外生性与排除限制的具体证据；不得照抄此说明。"},),
        ),
        _spec(
            "iv_test", "diagnostic", ("工具变量检验", "弱工具检验", "内生性检验", "过度识别检验"),
            "报告工具变量第一阶段相关性、内生性与过度识别诊断；稳健协方差下第一阶段统计量为 Wald χ²。",
            diagnostics=(
                "稳健第一阶段 Wald χ²不适用 F<10 经验规则，不能据此给出弱工具的阈值式二分类。",
                "恰好识别时过度识别检验不适用；未拒绝过度识别检验也不等于证明排除限制成立。",
            ),
            dependencies=("pandas", "numpy", "linearmodels"),
            input_examples=({"dependentVar": "outcome", "treatmentVar": "treatment", "instrumentVars": ["z"]},),
        ),
        _spec("did_static", "estimator", ("传统双重差分", "静态DID", "两组两期DID"), "执行满足四格样本结构的传统 DID。", use_when="存在明确的二元处理组变量和统一政策前后指标，且四类组×时期单元都有观测时。", do_not_use_when="缺少真实post/处理组定义、处理时点因个体而异，或四格样本不完整时不要调用；不要自行构造post。", requirements=("处理组/对照组与政策前/后四格样本必须可核验。",), dependencies=("pandas", "numpy", "pyfixest"), input_examples=({"dependentVar": "outcome", "groupVar": "treated", "postVar": "post", "covariates": []},)),
        _spec("did2s", "estimator", ("两阶段DID", "交错DID", "错位DID", "Gardner DID"), "执行交错处理的两阶段 DID。", use_when="处理在不同实体的首次处理时期不同，且已提供实体、时间、cohort和relativeTime真实列时。", do_not_use_when="没有首次处理时期或相对时间编码、实体×时间键不唯一，或只是标准两组两期DID时不要调用。", dependencies=("pandas", "numpy", "pyfixest"), input_examples=({"dependentVar": "outcome", "treatmentVar": "treated", "entityVar": "unit", "timeVar": "year", "cohortVar": "first_treat", "relativeTimeVar": "event_time", "covariates": []},)),
        _spec("did_event_study_saturated", "estimator", ("事件研究", "动态DID", "事件研究法"), "执行交错处理事件研究。", use_when="cohort、实体、时间、二元处理列及其关系已确认，且需要估计相对处理时期动态效应时。", do_not_use_when="面板键不唯一、处理组/首次处理期编码矛盾、从未处理组语义未确认，或用户只需要静态DID时不要调用。", requirements=("PyFixest 将 cohort=0 视为从未处理组；cohort 缺失时仅在用户明确确认缺失即从未处理后，才可把计算副本映射到0，原始数据不改。", "处理列必须逐行满足 cohort>0 且 year>=cohort；所有cohort与时期须为非负整数编码。"), diagnostics=("PyFixest saturated 事件研究当前标记为 beta；需报告该限制并结合研究设计审慎解释。",), dependencies=("pandas", "numpy", "pyfixest")),
        _spec(
            "psm_construction", "diagnostic", ("倾向得分构造", "倾向得分诊断", "倾向得分重叠"),
            "用已确认的处理前协变量构造倾向得分并检查共同支撑与极端分数。每个分析单位必须恰好一行。",
            use_when="处理变量为完整0/1编码、协变量的处理前时点已由研究者确认，且当前阶段每个分析单位仅一行时。",
            do_not_use_when="数据仍是重复单位的面板、处理变量是逐年变化的状态，或协变量可能为处理后测量且时点未确认时不要直接构造；先请研究者确定样本时期、分析单位和处理前协变量。",
            requirements=("必须提供二元 treatmentVar 和唯一 analysisUnitVar；当前阶段每个分析单位仅一行。",),
            diagnostics=("报告倾向得分范围、处理/对照组均值、极端分数比例、共同支撑边界及覆盖率；不代表已完成匹配或因果识别。",),
            dependencies=("pandas", "numpy", "statsmodels"),
            input_examples=({"treatmentVar": "treated", "analysisUnitVar": "unit_id", "covariates": ["age", "size"]},),
        ),
        _spec(
            "psm_visualize", "diagnostic", ("倾向得分分布", "共同支撑图"),
            "按唯一分析单位展示倾向得分分布与共同支撑。每个分析单位必须恰好一行。",
            use_when="处理变量、处理前协变量和一行一个分析单位均已确认，需要查看分数分布/重叠时。",
            do_not_use_when="输入仍是重复单位的面板、处理变量随时间变化，或协变量时点未确认时不要把所有行当作独立样本；先由研究者确定样本和预处理规则。",
            requirements=("必须提供二元 treatmentVar 和唯一 analysisUnitVar；当前阶段每个分析单位仅一行。",),
            diagnostics=("返回分布图、分数范围、处理/对照组均值、极端分数比例和共同支撑范围；图形本身不证明识别假设。",),
            dependencies=("pandas", "numpy", "matplotlib"),
            input_examples=({"treatmentVar": "treated", "analysisUnitVar": "unit_id", "covariates": ["age", "size"]},),
        ),
        _spec("psm_matching", "estimator", ("倾向得分匹配", "最近邻匹配", "匹配估计"), "执行固定规则的倾向得分最近邻 ATT。", dependencies=("pandas", "numpy", "statsmodels"), input_examples=({"dependentVar": "outcome", "treatmentVar": "treated", "analysisUnitVar": "firm_id", "preTreatmentAggregation": "not_applicable", "covariates": ["age", "size"]},)),
        _spec("psm_ipw", "estimator", ("逆概率加权", "IPW", "加权平均处理效应"), "执行倾向得分 IPW ATE。", dependencies=("pandas", "numpy", "statsmodels")),
        _spec("psm_regression", "estimator", ("倾向得分回归调整", "倾向得分回归"), "执行倾向得分回归调整 ATE。", dependencies=("pandas", "numpy", "statsmodels")),
        _spec("psm_double_robust", "estimator", ("双重稳健", "AIPW"), "执行 AIPW 双重稳健 ATE。", dependencies=("pandas", "numpy", "statsmodels")),
        _spec("logit_regression", "estimator", ("Logit回归", "逻辑回归", "二元Logit"), "对二元 0/1 结果执行 Logit 回归。", dependencies=("pandas", "numpy", "statsmodels")),
        _spec("probit_regression", "estimator", ("Probit回归", "Probit模型"), "对二元 0/1 结果执行 Probit 回归。", dependencies=("pandas", "numpy", "statsmodels")),
        _spec("poisson_regression", "estimator", ("Poisson回归", "泊松回归"), "对非负结果执行 Poisson/PPML 回归。", dependencies=("pandas", "numpy", "statsmodels")),
        _spec(
            "negbin_regression", "estimator", ("负二项回归", "Negative Binomial回归"),
            "对非负整数计数结果执行负二项回归，并估计过度离散参数 alpha。",
            use_when="因变量是有变异的非负整数次数或数量，且需要处理过度离散时。",
            do_not_use_when="因变量含非整数值、只有0/1、含负值或不是次数/数量时不要调用。连续非负结果如需建模，应由研究者确认后改用 Poisson/PPML；不得舍入结果或静默更换方法。",
            requirements=("负二项因变量必须是有变异的非负整数计数。",),
            diagnostics=("报告 alpha、核心变量发生率比 IRR 及其区间、Pearson 离散度与有效样本量。",),
            dependencies=("pandas", "numpy", "statsmodels"),
            input_examples=({"dependentVar": "count_outcome", "treatmentVar": "group_indicator", "covariates": ["age"], "covariance": "robust"},),
        ),
        _spec("quantile_regression", "estimator", ("分位数回归", "分位回归"), "在指定分位点执行分位数回归。", dependencies=("pandas", "numpy", "statsmodels")),
        _spec(
            "rdd_sharp", "estimator", ("锐性断点", "Sharp RDD"),
            "使用 rdrobust 执行锐性断点回归，分别返回常规点估计、偏差校正估计和稳健偏差校正推断。",
            use_when="研究设计已指定连续运行变量和明确 cutoff，且处理状态由是否越过 cutoff 完全决定时。",
            do_not_use_when="只有 0/1 处理指示而没有连续运行变量、cutoff 尚未由研究者确定、阈值应由数据分组推算，或处理概率只在 cutoff 跳变但并非确定处理时不要使用；后者应评估 rdd_fuzzy。不得猜测 cutoff。",
            requirements=("结果变量、运行变量、可选协变量必须是当前数据中的数值列；cutoff 必须显式提供；运行变量必须在阈值两侧有观测。可选 clusterVar 必须是非缺失的聚类标识列。",),
            diagnostics=("报告常规/偏差校正/稳健偏差校正三行、估计与偏差校正带宽、断点两侧有效样本；指定 clusterVar 时报告 CR1 簇稳健推断与带宽内簇数。robust 推断区间以偏差校正点估计为中心，不得与 conventional 点估计混配。RDD 输出不自动验证连续性或运行变量不可操纵等识别假设。",),
            dependencies=("pandas", "numpy", "rdrobust"),
            input_examples=({"dependentVar": "outcome", "runningVar": "score", "cutoff": 70},),
        ),
        _spec(
            "rdd_fuzzy", "estimator", ("模糊断点", "模糊断点回归", "Fuzzy RDD"),
            "使用 rdrobust 执行模糊断点回归，估计阈值处处理概率或处理剂量只发生不完全跳变时的局部处理效应。",
            use_when="连续 runningVar 在明确 cutoff 处改变处理概率，但没有完全决定实际处理状态/剂量；研究问题、处理变量和局部估计对象均已明确时。",
            do_not_use_when="处理状态由是否跨过 cutoff 完全决定时用 rdd_sharp；没有真实实际处理变量、第一阶段在阈值处没有跳变、cutoff 未由研究设计确认，或数据单位/聚类口径尚不明确时不要估计。不得把任意二元列当成 fuzzyVar。",
            requirements=("dependentVar、runningVar、fuzzyVar 必须是当前数据中的数值列，cutoff 必须显式提供；可选 clusterVar 为非缺失簇标识。",),
            diagnostics=("报告模糊断点主效应及稳健偏差校正推断，并单列 fuzzyVar 在 cutoff 处的第一阶段跳变；指定 clusterVar 时报告 CR1 与带宽内簇数。估计不自动验证连续性、排除限制、单调性或无精确操纵等识别假设。",),
            dependencies=("pandas", "numpy", "rdrobust"),
            input_examples=({"dependentVar": "test_score", "runningVar": "enrollment", "fuzzyVar": "class_size", "cutoff": 40, "clusterVar": "school"},),
        ),
        _spec(
            "multinomial_logit", "estimator", ("多项Logit", "多分类Logit", "多项式逻辑回归"),
            "对离散整数编码的无序类别结果执行多项 Logit，按最小类别值设置基准并返回各类别相对风险比（RRR）。",
            use_when="结果是至少两个离散无序类别，每个独立决策单位一行，且需要比较各非基准类别与基准类别的条件关联时。",
            do_not_use_when="因变量是连续/分数值、顺序类别，或数据仍是每个备选项一行的长格式时不要直接调用；二元结果优先评估 Logit/Probit。不得截断连续结果、把备选项行当独立个体或自动分箱。",
            requirements=("因变量须为离散整数类别编码且最多20类；样本行应对应独立观察单位。最小类别值自动作为基准类别。",),
            diagnostics=("报告基准类别、每个非基准类别的核心解释变量系数与 RRR/95%区间、McFadden 伪 R²、样本量；不输出 AME。",),
            dependencies=("pandas", "numpy", "statsmodels"),
            input_examples=({"dependentVar": "choice_class", "treatmentVar": "income", "covariates": [], "covariance": "robust"},),
        ),
        _spec("robust_regression", "estimator", ("稳健回归", "M估计回归", "RLM"), "执行 M 估计稳健回归。", dependencies=("pandas", "numpy", "statsmodels")),
        _spec(
            "wls_regression", "estimator", ("加权最小二乘", "WLS回归"),
            "使用已有的逆误差方差权重执行加权最小二乘；权重来源和统计含义必须明确。",
            use_when="结果和解释变量为连续数值，且当前数据中已有可追溯的精度权重；对效应量 meta-regression，若 vi 是每项研究的采样方差，可使用 weightsVar=1/vi。",
            do_not_use_when="没有可信的逆误差方差权重列，或权重只是抽样概率、频数、人口规模或任意正数时不要调用；不得由模型自行构造权重、用结果/解释变量计算权重，或把 WLS 当成随机效应 meta-analysis。",
            requirements=("weightsVar 必须指向当前阶段已存在、严格为正且与误差方差倒数成比例的数值列；用户/数据源需说明其来源。",),
            diagnostics=("报告权重列、样本量、协方差口径和权重范围；系统只能检查数值与正值，不能仅凭列名验证权重的统计含义。",),
            dependencies=("pandas", "numpy", "statsmodels"),
            input_examples=({"dependentVar": "yi", "treatmentVar": "ablat", "weightsVar": "precision_weight", "covariates": [], "covariance": "robust"},),
        ),
        _spec(
            "data_preprocess", "data", ("数据预处理", "缩尾", "插补", "标准化"),
            "对当前已诊断阶段执行一个明确的数据检查或变换；本工具没有 action 参数，动作只写在 method；变换创建新阶段，诊断不改变数据。",
            use_when="用户明确要求的数据清洗、变换、样本筛选、虚拟变量、数值文本转换或异常值检测，且变量和规则已确认时。coerce_numeric 仅在用户或数据源确认精确缺失标记含义后使用。",
            do_not_use_when="用户只要求上传后检查或查看频数时不要调用；数据改动规则、缺失标记语义、删样本条件、填补值、政策 post 阈值或中位数分组规则需要用户确认，未明确时先询问；coerce_numeric 不得吞掉未声明的非数值文本，也不得自动删除观测；不要默认假设 year >= time。",
            requirements=("method 必须是已准入的方法；columns 必须是当前阶段真实列；options 只允许该方法声明的字段。",),
            diagnostics=("返回行列变化、缺失变化、警告与创建列；coerce_numeric 还要返回实际转换列和每列显式缺失标记数；操作失败不能发布新阶段。",),
            dependencies=("pandas", "numpy", "scikit-learn"),
            input_examples=(
                {"method": "winsorize", "columns": ["income"], "options": {"lower": 0.01, "upper": 0.01}},
                {"method": "combine_columns", "columns": ["省份", "地区"], "options": {"output_column": "省份_地区", "separator": "_"}},
            ),
        ),
        _spec(
            "composite_evaluation", "data", ("熵权法", "TOPSIS", "综合评价"),
            "按用户确认的评价对象、指标方向、评价范围和权重生成可复现得分。熵权综合指数使用 entropy_weight；所有 TOPSIS 都必须显式指定 weightSource=equal/manual/entropy，不得默认等权；熵权 TOPSIS 必须使用 method=topsis 且 weightSource=entropy。分组得分仅在同组内可比较，不得跨组或跨年混排。",
            use_when="用户已明确 ID 列、至少两个指标、每个指标 benefit/cost 方向、global/by_group 范围与权重来源时。",
            do_not_use_when="任一指标方向、分组范围或权重来源需猜测，或 ID/指标/分组列重叠时不要调用。",
            requirements=("至少一个 ID 列和两个指标；分组评价需 groupColumns；手工权重须覆盖全部指标且和为 1。",),
            diagnostics=("报告有效样本、权重来源、权重、分组数、得分产物和样本守恒警告。",),
            dependencies=("pandas", "numpy"),
            input_examples=({"method": "topsis", "idColumns": ["province", "year"], "indicators": [{"column": "green_credit", "direction": "benefit"}, {"column": "access", "direction": "benefit"}], "scope": "global", "weightSource": "entropy"},),
        ),
        _spec(
            "data_import", "data", ("数据导入", "数据画像", "数据质量检查"),
            "读取用户指定表格，或对当前规范化阶段执行画像、质量检查和受控导出。",
            use_when="首次导入用户明确选择的数据文件，或查看当前阶段结构、质量、频数、相关性和导出时。",
            do_not_use_when="已有当前阶段时不得为了恢复内部引用重新导入原始文件；不得用 export/rollback 替代普通读取。",
            requirements=("import 需要 inputPath；其他数据动作需要 inputPath 或 Harness 提供的一对 datasetId/stageId；named_sheet 必须提供准确 sheetName。",),
            diagnostics=("导入后返回行列数、列名、数据质量、结构事实、潜在面板键和可用方法候选。",),
            dependencies=("pandas", "openpyxl", "pyarrow"),
            input_examples=(
                {"action": "import", "sheetPolicy": {"mode": "named_sheet", "sheetName": "Data_可读"}},
                {"action": "frequency", "variables": ["year"], "groupBy": ["province", "year"], "maxDistinct": 20},
            ),
        ),
        _spec(
            "econometrics_recommend",
            "diagnostic",
            ("计量方法推荐", "数据结构画像", "方法推荐"),
            "读取当前规范化数据阶段，说明数据结构、变量类型、缺失和面板键，并给出已准入的基础方法候选；不运行回归。",
            use_when="用户要求查看数据结构、需要基础方法候选，或已明确变量角色并希望核对数据是否适配时。",
            do_not_use_when="尚未完成数据导入、用户要求立即执行已明确的方法，或需要DID、IV、PSM、RDD等识别设计选择时不要调用。",
            requirements=("只使用当前数据阶段的实际列；因变量和核心解释变量仅在用户已明确时填写。",),
            diagnostics=("报告行列数、缺失、候选面板键、变量类型和潜在共线警告。",),
            dependencies=("pandas", "numpy"),
            input_examples=({"dependentVar": "outcome", "treatmentVar": "treatment"},),
        ),
        _spec(
            "heterogeneity_runner",
            "extension",
            ("异质性分析", "机制分析", "安慰剂检验"),
            "在规格已核验的线性 FE 基准上运行异质性、机制、安慰剂或替代规格。当前执行器固定为 OLS+LSDV；必须匹配基准的结果变量、核心解释变量、控制变量、实体/时间固定效应和受支持的聚类设置。扩展结果的标准误不能直接与基准结果表并列比较。数值变量会同时生成中位数分组与中心化交互；类别变量覆盖全部非缺失类别，超过两类时交互规格标记为跳过。",
            use_when="基准是可核验的 panel_fe_regression，或恰含实体/时间两项固定效应且协方差可映射到 OLS+LSDV 的 hdfe_regression；变量规格完全一致，用户明确给出扩展变量并接受完整规格集合时。",
            do_not_use_when="基准规格缺失或无法核验、扩展变量角色与基准不一致、固定效应/协方差无法映射，或基准属于传统 DID、DID2S、事件研究时不要调用；当前实现会停止，不会将 DID 估计量替换成 OLS+LSDV，也不替代 IV、PSM、RDD 等专用识别工具。用户只同意一种连续变量规格或需要自动猜测分组/机制时也不要调用。",
            requirements=("至少提供一项用户明确指定的异质性、机制、安慰剂或替代规格；基准结果和 datasetId/stageId 须绑定当前活动 workflow 的规范化阶段、具有 Harness 保存的原始规格，并通过质量与结果门禁。",),
            diagnostics=("执行前核对基准 methodSpecification 与扩展参数；对类别变量覆盖所有观测类别；逐项返回成功/失败/跳过、样本量、核心系数、诊断与产物引用，不丢弃失败规格。",),
            dependencies=("pandas", "numpy", "statsmodels"),
            input_examples=({"methodFamily": "fe", "dependentVar": "outcome", "treatmentVar": "treatment", "entityVar": "unit", "timeVar": "year", "heterogeneityVars": ["region"], "covariates": []},),
        ),
    ]
    return {item.method_id: item for item in specs}


METHODS = _build_registry()


def get_method(method_id: str) -> MethodSpec:
    try:
        return METHODS[method_id]
    except KeyError as error:
        raise EngineError("METHOD_NOT_FOUND", f"未找到计量方法：{method_id}。", method_id=method_id) from error


def _summary(spec: MethodSpec) -> dict[str, Any]:
    return {
        "method_id": spec.method_id,
        "family": spec.family,
        "aliases": list(spec.aliases),
        "description_zh": spec.description_zh,
    }


def method_catalog() -> list[dict[str, Any]]:
    return [_summary(METHODS[key]) for key in sorted(METHODS)]


def search_methods(query: str, limit: int = 3) -> list[dict[str, Any]]:
    normalized = query.strip().lower()
    if not normalized:
        return method_catalog()[: max(1, min(10, limit))]
    exact: list[tuple[int, MethodSpec]] = []
    has_cjk = any("\u3400" <= char <= "\u9fff" for char in normalized)
    for spec in METHODS.values():
        haystacks = (spec.method_id.lower(), *(alias.lower() for alias in spec.aliases), spec.family.lower())
        if any(normalized == value for value in haystacks):
            exact.append((300, spec))
        elif has_cjk and any(value in normalized and len(value) >= 4 for value in haystacks if "\u3400" <= value[0] <= "\u9fff"):
            exact.append((200, spec))
        elif not has_cjk and any(normalized in value or value in normalized for value in haystacks):
            exact.append((100, spec))
    exact.sort(key=lambda item: (-item[0], item[1].method_id))
    return [_summary(spec) for _, spec in exact[: max(1, min(10, limit))]]


def describe_method(method_id: str) -> dict[str, Any]:
    spec = get_method(method_id)
    descriptor = spec.to_descriptor()
    return {
        **_summary(spec),
        **descriptor,
        "schema_version": REGISTRY_VERSION,
        "use_when_zh": spec.use_when_zh,
        "do_not_use_when_zh": spec.do_not_use_when_zh,
        "input_schema": spec.input_schema,
        "input_requirements_zh": list(spec.input_requirements_zh),
        "output_schema": spec.output_schema,
        "diagnostic_requirements_zh": list(spec.diagnostic_requirements_zh),
        "dependencies": list(spec.dependencies),
        "runtime_injected_fields": list(spec.runtime_injected_fields),
    }
