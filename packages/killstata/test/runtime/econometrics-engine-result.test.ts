import { describe, expect, test } from "bun:test"
import { buildEngineToolResult } from "@/runtime/services/econometrics-engine-result"

describe("Python 引擎统一结果适配", () => {
  test("把方法结果转换为中文摘要、可信指标和产物引用", () => {
    const result = buildEngineToolResult({
      methodID: "ols_regression",
      datasetId: "dataset_demo",
      stageId: "stage_000",
      payload: {
        success: true,
        rowsUsed: 120,
        rSquared: 0.42,
        primary: { term: "x", estimate: 0.8, stdError: 0.1, pValue: 0.01 },
        resultPath: ".killstata/results.json",
        coefficientsPath: ".killstata/coefficients.csv",
      },
      artifacts: [
        { kind: "result", path: ".killstata/results.json" },
        { kind: "coefficients", path: ".killstata/coefficients.csv" },
      ],
    })

    expect(result.title).toContain("ols_regression")
    expect(result.output).toContain("有效样本：120")
    expect(result.output).toContain("x")
    expect(result.metadata.analysisView).toMatchObject({
      kind: "econometrics",
      step: "ols_regression",
      datasetId: "dataset_demo",
      stageId: "stage_000",
    })
    expect(result.metadata.analysisView.results).toEqual(expect.arrayContaining([
      { label: "x 系数", value: "0.8" },
      { label: "标准误", value: "0.1" },
      { label: "p 值", value: "0.010" },
      { label: "N", value: "120" },
    ]))
    expect(result.metadata.analysisView.conclusion).toContain("统计相关性")
  })

  test("结果摘要包含已有的标准误和协方差口径，避免模型回读内部诊断路径", () => {
    const result = buildEngineToolResult({
      methodID: "panel_fe_regression",
      datasetId: "dataset_demo",
      stageId: "stage_000",
      payload: {
        success: true,
        rowsUsed: 120,
        rSquaredWithin: 0.42,
        covariance: "clustered",
        primary: { term: "x", estimate: 0.8, stdError: 0.1, pValue: 0.01, confLow: 0.6, confHigh: 1.0 },
      },
    })

    expect(result.output).toContain("标准误：0.1")
    expect(result.output).toContain("协方差：clustered")
    expect(result.output).toContain("95% 置信区间：[0.6, 1]")
    expect(result.metadata.analysisView.results).toEqual(expect.arrayContaining([
      { label: "标准误", value: "0.1" },
      { label: "95% 置信区间", value: "[0.6, 1]" },
      { label: "协方差", value: "clustered" },
      { label: "组内 R²", value: "0.42" },
    ]))
  })

  test("随机效应结果同时呈现 RE 估计、Hausman 建议与不自动换模型边界", () => {
    const result = buildEngineToolResult({
      methodID: "panel_random_effects",
      payload: {
        success: true,
        rowsUsed: 4709,
        covariance: "robust",
        randomEffects: {
          primary: { term: "did", estimate: 0.31, stdError: 0.08, pValue: 0, confLow: 0.15, confHigh: 0.47 },
        },
        fixedEffects: {
          primary: { term: "did", estimate: 0.22, stdError: 0.07, pValue: 0.001, confLow: 0.08, confHigh: 0.36 },
        },
        hausman: { statistic: 14.2, df: 3, pValue: 0, rejectRe: true },
        recommendation: { preferred: "fixed_effects", reason: "Hausman 检验显著，个体效应与解释变量相关，RE 不一致，FE 更可靠" },
      },
    })

    expect(result.output).toContain("随机效应（RE）估计")
    expect(result.output).toContain("did")
    expect(result.output).toContain("Hausman")
    expect(result.output).toContain("14.2")
    expect(result.output).toContain("RE p 值：<0.001")
    expect(result.output).toContain("p=<0.001")
    expect(result.output).toContain("固定效应")
    expect(result.output).toContain("未自动切换")
    expect(result.output).toContain("不能据此作因果解释")
    expect(result.metadata.analysisView.results).toEqual(expect.arrayContaining([
      { label: "did RE 系数", value: "0.31", visibility: undefined },
      { label: "RE p 值", value: "<0.001", visibility: undefined },
      { label: "Hausman p 值", value: "<0.001", visibility: undefined },
      { label: "Hausman 建议", value: "固定效应", visibility: undefined },
    ]))
  })

  test("Hausman 没有有效自由度时不把 p=1 解释成支持随机效应", () => {
    const result = buildEngineToolResult({
      methodID: "panel_random_effects",
      payload: {
        success: true,
        rowsUsed: 4709,
        randomEffects: { primary: { term: "did", estimate: 0.0649, stdError: 0.0015, pValue: 0.0001 } },
        fixedEffects: { primary: { term: "did", estimate: 0.0640, stdError: 0.0014, pValue: 0.0001 } },
        hausman: { statistic: null, df: 0, pValue: null, rejectRe: null },
        recommendation: { preferred: "undetermined", reason: "Hausman 检验没有有效自由度，无法据此选择固定效应或随机效应。" },
        warnings: ["Hausman 检验没有有效自由度，不能据此选择 FE 或 RE。"],
      },
    })

    expect(result.output).toContain("Hausman 检验无有效自由度")
    expect(result.output).toContain("不能据此判断 FE/RE")
    expect(result.output).not.toContain("p=1")
    expect(result.output).not.toContain("Hausman 建议：随机效应")
    expect(result.metadata.analysisView.results).toContainEqual({ label: "Hausman 建议", value: "不可判定", visibility: undefined })
  })

  test("分位数回归摘要保留所有指定分位点的核心系数路径", () => {
    const result = buildEngineToolResult({
      methodID: "quantile_regression",
      payload: {
        success: true,
        rowsUsed: 277,
        covariance: "robust",
        quantiles: [0.25, 0.5, 0.75],
        primaryTau: 0.5,
        primary: { term: "did", estimate: -0.0241803, stdError: 0.0133283, pValue: 0.0707484, confLow: -0.0504201, confHigh: 0.0020595 },
        treatmentPath: [
          { tau: 0.25, estimate: -0.0244562, stdError: 0.0167515, pValue: 0.1454599, confLow: -0.0574353, confHigh: 0.0085229 },
          { tau: 0.5, estimate: -0.0241803, stdError: 0.0133283, pValue: 0.0707484, confLow: -0.0504201, confHigh: 0.0020595 },
          { tau: 0.75, estimate: -0.0093922, stdError: 0.009761, pValue: 0.3367938, confLow: -0.028609, confHigh: 0.0098245 },
        ],
      },
    })

    expect(result.output).toContain("τ=0.25")
    expect(result.output).toContain("τ=0.5")
    expect(result.output).toContain("τ=0.75")
    expect(result.output).toContain("不能直接解读为因果效应")
    expect(result.metadata.analysisView.results).toEqual(expect.arrayContaining([
      { label: "did τ=0.25 系数", value: "-0.0245", visibility: undefined },
      { label: "did τ=0.5 系数", value: "-0.0242", visibility: undefined },
      { label: "did τ=0.75 系数", value: "-0.0094", visibility: undefined },
    ]))
  })

  test("稳健回归摘要保留 M 估计设定与低权重观测诊断", () => {
    const result = buildEngineToolResult({
      methodID: "robust_regression",
      payload: {
        success: true,
        rowsUsed: 277,
        psi: "huber",
        covariance: "HC1",
        scale: 0.0214,
        downWeightedCount: 6,
        downWeightedPct: 2.2,
        primary: { term: "did", estimate: -0.0202335, stdError: 0.0113398, pValue: 0.074376, confLow: -0.0424591, confHigh: 0.0019921 },
      },
    })

    expect(result.output).toContain("Huber M 估计")
    expect(result.output).toContain("残差尺度")
    expect(result.output).toContain("低权重观测：6（2.2%）")
    expect(result.output).toContain("本结果仅描述当前规格下的统计相关性")
    expect(result.output).toContain("稳健 M 估计不等于因果识别")
    expect(result.metadata.analysisView.results).toEqual(expect.arrayContaining([
      { label: "M 估计函数", value: "Huber", visibility: undefined },
      { label: "低权重观测", value: "6（2.2%）", visibility: undefined },
    ]))
  })

  test("PSM 兜底摘要保留 ATT、匹配样本与平衡诊断", () => {
    const result = buildEngineToolResult({
      methodID: "psm_matching",
      datasetId: "dataset_demo",
      stageId: "stage_000",
      payload: {
        success: true,
        rowsUsed: 277,
        att: 1.25,
        treatedCount: 140,
        matchedTreatedCount: 132,
        unmatchedTreatedCount: 8,
        postMatchMaxAbsSmd: 0.04,
      },
    })

    expect(result.metadata.analysisView.results).toEqual(expect.arrayContaining([
      { label: "ATT", value: "1.25" },
      { label: "已匹配处理组", value: "132/140" },
      { label: "未匹配处理组", value: "8" },
      { label: "匹配后最大绝对 SMD", value: "0.04" },
    ]))
    expect(result.metadata.analysisView.conclusion).toContain("共同支撑")
  })

  test("PSM ATE 投影按统一精度展示估计值和完整共同支撑诊断", () => {
    const cases = [
      { methodID: "psm_ipw", ate: 1630.8240418555997, estimateLine: "ATE：1630.8240（固定为 Hájek 归一化 ATE）" },
      { methodID: "psm_regression", ate: 1670.7325479778087, estimateLine: "ATE：1670.7325" },
      { methodID: "psm_double_robust", ate: 1612.7369896866358, estimateLine: "ATE：1612.7370" },
    ] as const

    for (const scenario of cases) {
      const result = buildEngineToolResult({
        methodID: scenario.methodID,
        datasetId: "dataset_nsw",
        stageId: "stage_000",
        payload: {
          success: true,
          rowsUsed: 445,
          ate: scenario.ate,
          treatedCount: 185,
          controlCount: 260,
          treatmentEss: 177.3875920983547,
          controlEss: 253.05819717788557,
          minPropensityScore: 0.23537249233394145,
          maxPropensityScore: 0.6379746575072575,
          maxWeight: 4.2485848286010475,
          weightedMaxAbsSmd: 0.0023479892227105314,
        },
      })
      const lines = result.output.split("\n")
      expect(lines).toContain(scenario.estimateLine)
      expect(lines).toContain("处理/对照样本量：185/260")
      expect(lines).toContain("有效样本量：处理组 177.39；对照组 253.06")
      expect(lines).toContain("倾向得分范围：[0.2354, 0.6380]（固定 [0.0500, 0.9500] 共同支撑检查通过）")
      expect(lines).toContain("最大权重：4.2486")
      expect(lines).toContain("加权后最大绝对 SMD：0.002348（阈值 ≤ 0.1000）")
      expect(lines).toContain("未输出标准误、p 值、置信区间或显著性结论。")
      expect(result.output).not.toContain(String(scenario.ate))
      if (scenario.methodID === "psm_ipw") {
        expect(lines).not.toContain("IPW 点估计采用 Hájek 组内归一化。")
      }
      expect(result.metadata.analysisView.results).toEqual(expect.arrayContaining([
        { label: "ATE", value: scenario.ate.toFixed(4) },
        { label: "处理/对照样本量", value: "185/260" },
        { label: "处理组有效样本量", value: "177.39" },
        { label: "对照组有效样本量", value: "253.06" },
        { label: "倾向得分范围", value: "[0.2354, 0.6380]" },
        { label: "最大权重", value: "4.2486" },
        { label: "加权后最大绝对 SMD", value: "0.002348" },
        { label: "N", value: "445" },
      ]))
    }
  })

  test("RDD 结果分开展示常规点估计与稳健偏差校正推断", () => {
    const result = buildEngineToolResult({
      methodID: "rdd_sharp",
      datasetId: "dataset_rd_senate",
      stageId: "stage_000",
      methodArguments: { dependentVar: "vote", runningVar: "margin", cutoff: 0 },
      payload: {
        success: true,
        rowsInput: 1390,
        rowsUsed: 1297,
        cutoff: 0,
        runningVar: "margin",
        dependentVar: "vote",
        bandwidth: { h: 17.754397221175502, b: 28.028087151164062 },
        nEffective: { left: 360, right: 323 },
        conventional: {
          estimate: 7.414130801972014,
          stdError: 1.4587160238254098,
          pValue: 3.722215566359848e-7,
          confLow: 4.55509993160274,
          confHigh: 10.273161672341288,
        },
        biasCorrected: {
          estimate: 7.506502470585488,
          stdError: 1.4587160238254098,
          pValue: 2.661482034701358e-7,
          confLow: 4.647471600216214,
          confHigh: 10.365533340954762,
        },
        robust: {
          estimate: 7.506502470585488,
          stdError: 1.7412584146073788,
          pValue: 1.6254431450203327e-5,
          confLow: 4.093698690177712,
          confHigh: 10.919306250993264,
        },
        // 旧主结果把 conventional 点估计与 robust 推断拼在一起，不能把二者当成同一行展示。
        primary: {
          estimate: 7.414130801972014,
          stdError: 1.7412584146073788,
          pValue: 1.6254431450203327e-5,
          confLow: 4.093698690177712,
          confHigh: 10.919306250993264,
        },
        warnings: [],
      },
    })

    expect(result.title).toBe("锐性断点回归")
    expect(result.output).toContain("锐性断点回归（Sharp RDD）完成")
    expect(result.output).toContain("结果变量 vote；运行变量 margin；断点 0.0000")
    expect(result.output).toContain("常规点估计：7.4141")
    expect(result.output).toContain("偏差校正点估计：7.5065")
    expect(result.output).toContain("稳健偏差校正推断：点估计=7.5065；稳健标准误=1.7413")
    expect(result.output).toContain("95% CI=[4.0937, 10.9193]")
    expect(result.output).toContain("带宽：估计 h=17.7544；偏差校正 b=28.0281。")
    expect(result.output).toContain("断点左/右有效样本=360/323；完整样本 N=1297")
    expect(result.output).toContain("本次公开基准复现未验证这些假设")
    expect(result.output).not.toContain("rdd_sharp")
    expect(result.output).not.toContain("7.4141；稳健标准误=1.7413")
    expect(result.metadata.analysisView.results).toEqual(expect.arrayContaining([
      { label: "常规 RDD 点估计", value: "7.4141", visibility: undefined },
      { label: "偏差校正点估计", value: "7.5065", visibility: undefined },
      { label: "稳健偏差校正点估计", value: "7.5065", visibility: undefined },
      { label: "稳健标准误", value: "1.7413", visibility: undefined },
      { label: "稳健 p 值", value: "<0.001", visibility: undefined },
      { label: "稳健 95% 置信区间", value: "[4.0937, 10.9193]", visibility: undefined },
      { label: "估计带宽 h", value: "17.7544", visibility: undefined },
      { label: "断点左有效样本", value: "360", visibility: undefined },
      { label: "断点右有效样本", value: "323", visibility: undefined },
      { label: "N", value: "1297", visibility: undefined },
    ]))
    expect(result.metadata.analysisView.conclusion).toContain("没有检验这些假设")
  })

  test("固定效应兜底摘要保留已经执行的固定效应规格", () => {
    const result = buildEngineToolResult({
      methodID: "hdfe_regression",
      datasetId: "dataset_demo",
      stageId: "stage_000",
      methodArguments: { fixedEffects: ["地区", "年份"], clusterVars: ["地区"] },
      payload: {
        success: true,
        rowsUsed: 9545,
        covariance: "CRV1",
        clusterVars: ["地区"],
        clusterCounts: { "地区": 277 },
        primary: { term: "绿色信贷", estimate: 1.35, stdError: 0.12, pValue: 0.001 },
      },
    })

    expect(result.output).toContain("高维固定效应回归已完成")
    expect(result.output).toContain("固定效应：地区、年份")
    expect(result.output).toContain("聚类变量：地区")
    expect(result.output).toContain("聚类簇数：地区=277")
    expect(result.output).not.toContain("hdfe_regression")
    expect(result.metadata.analysisView.results).toEqual(expect.arrayContaining([
      { label: "固定效应", value: "地区、年份" },
      { label: "聚类变量", value: "地区" },
      { label: "聚类簇数", value: "地区=277" },
    ]))
    expect(result.metadata.analysisView.conclusion).toContain("固定效应")
  })

  test("模糊 RDD 摘要同时报告局部效应、第一阶段和带宽内聚类", () => {
    const result = buildEngineToolResult({
      methodID: "rdd_fuzzy",
      methodArguments: {
        dependentVar: "avgmath",
        runningVar: "c_size",
        fuzzyVar: "classize",
        cutoff: 40,
        clusterVar: "schlcode",
      },
      payload: {
        success: true,
        method: "rdd_fuzzy",
        dependentVar: "avgmath",
        runningVar: "c_size",
        fuzzyVar: "classize",
        cutoff: 40,
        rowsInput: 2059,
        rowsUsed: 2055,
        covariance: "CR1",
        clusterVar: "schlcode",
        nClusters: 366,
        bandwidth: { h: 9.371986676816286, b: 17.09900549457721 },
        nEffective: { left: 80, right: 200 },
        primary: { estimate: -0.5641995823740723, stdError: 0.5152058935676708, pValue: 0.2734748622195211, confLow: -1.5739845783894832, confHigh: 0.44558541364133875 },
        conventional: { estimate: -0.42158461944585274, stdError: 0.43727865870332433, pValue: 0.3349909037019817, confLow: -1.2786350417123507, confHigh: 0.43546580282064523 },
        biasCorrected: { estimate: -0.5641995823740723, stdError: 0.43727865870332433, pValue: 0.1969632415385556, confLow: -1.4212500046405703, confHigh: 0.29285083989242566 },
        robust: { estimate: -0.5641995823740723, stdError: 0.5152058935676708, pValue: 0.2734748622195211, confLow: -1.5739845783894832, confHigh: 0.44558541364133875 },
        firstStage: {
          conventional: { estimate: -9.599540, stdError: 3.443063, pValue: 0.005302, confLow: -16.347819, confHigh: -2.851261 },
          biasCorrected: { estimate: -8.447835, stdError: 3.443063, pValue: 0.014144, confLow: -15.196114, confHigh: -1.699556 },
          robust: { estimate: -8.447835, stdError: 4.030592, pValue: 0.036088, confLow: -16.347649, confHigh: -0.548020 },
          primary: { estimate: -8.447835, stdError: 4.030592, pValue: 0.036088, confLow: -16.347649, confHigh: -0.548020 },
        },
      },
    })

    expect(result.output).toContain("模糊断点回归（Fuzzy RDD）已完成")
    expect(result.output).toContain("局部处理效应")
    expect(result.output).toContain("第一阶段处理跳变")
    expect(result.output).toContain("聚类变量：schlcode")
    expect(result.output).toContain("带宽内聚类簇数：366")
    expect(result.output).toContain("CR1")
    expect(result.output).not.toContain("rdd_fuzzy")
    expect(result.metadata.analysisView.results).toEqual(expect.arrayContaining([
      { label: "局部处理效应", value: "-0.5642" },
      { label: "第一阶段处理跳变", value: "-8.4478" },
      { label: "聚类变量", value: "schlcode" },
      { label: "带宽内聚类簇数", value: "366" },
    ]))
    expect(result.metadata.analysisView.conclusion).toContain("连续性")
    expect(result.metadata.analysisView.conclusion).toContain("单调性")
  })

  test("Logit 结果区分对数几率系数与概率尺度平均边际效应", () => {
    const result = buildEngineToolResult({
      methodID: "logit_regression",
      payload: {
        success: true,
        rowsUsed: 277,
        covariance: "HC1",
        outcomeRate: 98 / 277,
        pseudoRSquared: 0.0356,
        primary: { term: "创新指数", estimate: -2.382415, stdError: 1.269445, pValue: 0.060554, confLow: -4.870481, confHigh: 0.10565 },
        primaryMarginalEffect: { term: "创新指数", estimate: -0.535699, stdError: 0.278569, pValue: 0.054475 },
        marginalEffects: [
          { term: "创新指数", estimate: -0.535699, stdError: 0.278569, pValue: 0.054475 },
          { term: "人口规模", estimate: -0.003727, stdError: 0.052299, pValue: 0.943183 },
        ],
      },
    })

    expect(result.output).toContain("对数几率尺度")
    expect(result.output).toContain("平均边际效应（概率尺度）")
    expect(result.output).toContain("创新指数=-0.5357")
    expect(result.output).toContain("McFadden 伪 R²=0.0356")
    expect(result.metadata.analysisView.results).toEqual(expect.arrayContaining([
      { label: "创新指数 对数几率系数", value: "-2.3824", visibility: undefined },
      { label: "核心解释变量平均边际效应（概率尺度）", value: "-0.5357", visibility: undefined },
      { label: "控制变量平均边际效应（概率尺度）", value: "人口规模=-0.0037，标准误=0.0523，p=0.943", visibility: undefined },
      { label: "平均边际效应 p 值", value: "0.054", visibility: undefined },
      { label: "McFadden 伪 R²", value: "0.0356", visibility: undefined },
    ]))
    expect(result.metadata.analysisView.conclusion).toContain("不自动构成因果效应")
  })

  test("Probit 结果的系数标注为潜变量尺度而非对数几率", () => {
    const result = buildEngineToolResult({
      methodID: "probit_regression",
      payload: {
        success: true,
        rowsUsed: 277,
        covariance: "HC1",
        outcomeRate: 0.35,
        primary: { term: "x", estimate: -1.2, stdError: 0.4, pValue: 0.003, confLow: -1.984, confHigh: -0.416 },
        primaryMarginalEffect: { term: "x", estimate: -0.3, stdError: 0.1, pValue: 0.002 },
        marginalEffects: [{ term: "x", estimate: -0.3, stdError: 0.1, pValue: 0.002 }],
      },
    })

    expect(result.output).toContain("潜变量尺度")
    expect(result.metadata.analysisView.results).toContainEqual({ label: "x 潜变量系数", value: "-1.2000", visibility: undefined })
    expect(result.metadata.analysisView.results).not.toContainEqual(expect.objectContaining({ label: "x 对数几率系数" }))
  })

  test("缺失 pseudo-R² 不输出字面 undefined", () => {
    const result = buildEngineToolResult({
      methodID: "logit_regression",
      payload: {
        success: true,
        rowsUsed: 100,
        covariance: "HC1",
        outcomeRate: 0.4,
        pseudoRSquared: null,
        primary: { term: "x", estimate: 0.2, stdError: 0.1, pValue: 0.04 },
      },
    })

    expect(result.output).not.toContain("McFadden 伪 R²=undefined")
  })

  test("IV 估计摘要向模型交付稳健第一阶段 Wald χ²，不误称为 F", () => {
    const result = buildEngineToolResult({
      methodID: "iv_2sls",
      payload: {
        success: true,
        rowsUsed: 4709,
        firstStageStatistic: 1.4315063565,
        firstStageStatisticDistribution: "chi2(1)",
        firstStagePValue: 0.2315,
        firstStagePartialRSquared: 0.0002816151,
        covariance: "robust",
        primary: { term: "did", estimate: 1.8688536, stdError: 0.42, pValue: 0.001 },
      },
    })

    expect(result.output).toContain("Wald χ²(1)")
    expect(result.output).toContain("1.4315063565")
    expect(result.output).toContain("相关性证据有限")
    expect(result.output).toContain("F<10")
    expect(result.output).not.toContain("第一阶段 F=")
    expect(result.output).toContain("内生性与过度识别诊断尚未运行")
    expect(result.output).toContain("iv_test")
  })

  test("IV 诊断摘要区分稳健 Wald χ²、不套 F<10，并呈现内生性与恰好识别边界", () => {
    const result = buildEngineToolResult({
      methodID: "iv_test",
      payload: {
        success: true,
        rowsUsed: 4709,
        identification: "just_identified",
        weakInstrument: {
          firstStageStatistic: 1.4315063565,
          firstStageStatisticDistribution: "chi2(1)",
          firstStageFStat: 1.4315063565,
          firstStagePValue: 0.2315,
          partialRSquared: 0.0002816151,
          threshold: null,
          criterion: "稳健第一阶段统计量服从 chi2(1)；F<10 经验规则不适用，不作阈值式二分类。",
          weak: null,
        },
        endogeneity: {
          primaryTest: "wooldridge_regression",
          wooldridgeRegression: { stat: 1.3, pValue: 0.25, df: 1 },
          endogenous: false,
        },
        overIdentification: {
          applicable: false,
          reason: "恰好识别：1 个工具变量对 1 个内生变量，过度识别检验没有自由度。",
          sargan: { stat: null, pValue: null, df: null },
          instrumentsRejected: null,
        },
      },
    })

    expect(result.output).toContain("Wald χ²(1)")
    expect(result.output).toContain("F<10")
    expect(result.output).toContain("相关性证据有限")
    expect(result.output).toContain("内生性")
    expect(result.output).toContain("Wooldridge")
    expect(result.output).toContain("恰好识别")
    expect(result.output).not.toMatch(/Sargan\s*=\s*[-\d.]+|Hansen\s*J\s*=\s*[-\d.]+/i)
  })
})
