import { describe, expect, test } from "bun:test"
import { normalizeKnownCrossToolFields, normalizeDirectMethodEnvelope } from "@/session/prompt/tools"

describe("跨工具参数规范化", () => {
  test("仅从非导入工具移除已声明的 preserveLabels 导入字段", () => {
    const estimatorInput = {
      datasetId: "did_demo",
      stageId: "stage_000",
      dependentVar: "创新指数",
      treatmentVar: "高质量发展指数",
      preserveLabels: true,
      unexpectedField: "必须继续由严格 schema 拒绝",
    }

    expect(normalizeKnownCrossToolFields("panel_fe_regression", estimatorInput)).toEqual({
      datasetId: "did_demo",
      stageId: "stage_000",
      dependentVar: "创新指数",
      treatmentVar: "高质量发展指数",
      unexpectedField: "必须继续由严格 schema 拒绝",
    })
  })

  test("保留 data_import 自己的 preserveLabels 参数", () => {
    const importInput = { action: "import", inputPath: "did.xlsx", preserveLabels: true }

    expect(normalizeKnownCrossToolFields("data_import", importInput)).toEqual(importInput)
  })

  test("稳定计量路由的外层未知字段不能被跨工具兼容规则吞掉", () => {
    const routeInput = {
      methodID: "ols_regression",
      arguments: { dependentVar: "创新指数" },
      preserveLabels: true,
    }

    expect(normalizeKnownCrossToolFields("econometrics_execute", routeInput)).toEqual(routeInput)
  })

  test("模型把稳定路由外壳错套到同名计量工具时只解包同名且无额外字段的调用", () => {
    const inner = { datasetId: "gf_demo", stageId: "stage_000", dependentVar: "绿色金融指数", treatmentVar: "绿色信贷" }

    expect(normalizeDirectMethodEnvelope("panel_fe_regression", {
      methodID: "panel_fe_regression",
      arguments: inner,
    })).toEqual(inner)
    expect(normalizeDirectMethodEnvelope("panel_fe_regression", {
      methodID: "ols_regression",
      arguments: inner,
    })).toEqual({
      methodID: "ols_regression",
      arguments: inner,
    })
    expect(normalizeDirectMethodEnvelope("panel_fe_regression", {
      methodID: "panel_fe_regression",
      arguments: inner,
      unexpected: true,
    })).toEqual({
      methodID: "panel_fe_regression",
      arguments: inner,
      unexpected: true,
    })
  })

  test("计量方法数组包装交给 Python Pydantic，TS 不复制方法契约", () => {
    expect(normalizeKnownCrossToolFields("panel_fe_regression", {
      covariates: "[]",
      entityVar: "地区",
    })).toEqual({
      covariates: "[]",
      entityVar: "地区",
    })

    // 非 JSON 字符串仍交给严格 schema 报错，不能用宽松分隔符猜测列名。
    expect(normalizeKnownCrossToolFields("panel_fe_regression", {
      covariates: "地区,年份",
    })).toEqual({ covariates: "地区,年份" })
  })

  test("空字符串协变量仍交给 Python Pydantic 解释", () => {
    expect(normalizeKnownCrossToolFields("panel_fe_regression", {
      covariates: "",
      entityVar: "地区",
      timeVar: "年份",
    })).toEqual({
      covariates: "",
      entityVar: "地区",
      timeVar: "年份",
    })
  })

  test("计量角色别名由 Python Pydantic 统一处理，TS 不改研究参数", () => {
    expect(normalizeKnownCrossToolFields("ols_regression", {
      dependent_var: "高质量发展指数",
      independent_vars: ["创新指数"],
      covariates: "",
      robust_se: true,
    })).toEqual({
      dependent_var: "高质量发展指数",
      independent_vars: ["创新指数"],
      covariates: "",
      robust_se: true,
    })
  })

  test("多个 independent_vars 不自动猜核心解释变量", () => {
    expect(normalizeKnownCrossToolFields("ols_regression", {
      dependent_var: "y",
      independent_vars: ["x1", "x2"],
    })).toEqual({ dependent_var: "y", independent_vars: ["x1", "x2"] })
  })

  test("OLS 稳健标准误和置信水平等价转换由 Python Pydantic 处理", () => {
    expect(normalizeKnownCrossToolFields("ols_regression", {
      dependentVar: "高质量发展指数",
      treatmentVar: "创新指数",
      covariates: "",
      robust_se: "true",
      confidence_level: "0.95",
    })).toEqual({ dependentVar: "高质量发展指数", treatmentVar: "创新指数", covariates: "", robust_se: "true", confidence_level: "0.95" })
  })

  test("非空协变量字符串仍交给严格 schema，不猜测列名", () => {
    expect(normalizeKnownCrossToolFields("panel_fe_regression", {
      covariates: "绿色投资",
    })).toEqual({ covariates: "绿色投资" })
  })

  test("数组 item 包装由 Python Pydantic 处理", () => {
    expect(normalizeKnownCrossToolFields("hdfe_regression", {
      covariates: { item: ["控制变量"] },
      fixedEffects: { item: ["地区", "年份"] },
      clusterVars: { item: "地区" },
    })).toEqual({ covariates: { item: ["控制变量"] }, fixedEffects: { item: ["地区", "年份"] }, clusterVars: { item: "地区" } })
  })

  test("HDFE 实体时间与协方差兼容由 Python Pydantic 处理", () => {
    expect(normalizeKnownCrossToolFields("hdfe_regression", {
      dependentVar: "y",
      treatmentVar: "x",
      entityVar: "省份_地区",
      timeVar: "年份",
      clusterVar: "省份_地区",
      covariance: "clustered",
    })).toEqual({ dependentVar: "y", treatmentVar: "x", entityVar: "省份_地区", timeVar: "年份", clusterVar: "省份_地区", covariance: "clustered" })
  })

  test("面板固定效应字段不由 TS 删除，交给 Python Pydantic 校验", () => {
    expect(normalizeKnownCrossToolFields("panel_fe_regression", {
      entityVar: "地区",
      timeVar: "年份",
      fixedEffects: ["地区", "年份"],
    })).toEqual({ entityVar: "地区", timeVar: "年份", fixedEffects: ["地区", "年份"] })

    expect(normalizeKnownCrossToolFields("panel_fe_regression", {
      entityVar: "地区",
      timeVar: "年份",
      fixedEffects: ["省份", "年份"],
    })).toEqual({ entityVar: "地区", timeVar: "年份", fixedEffects: ["省份", "年份"] })
  })

  test("面板 entity/time 占位符由 Python Pydantic 处理", () => {
    expect(normalizeKnownCrossToolFields("panel_fe_regression", {
      entityVar: "省份_地区",
      timeVar: "年份",
      fixedEffects: ["entity", "time"],
    })).toEqual({ entityVar: "省份_地区", timeVar: "年份", fixedEffects: ["entity", "time"] })
  })

  test("数据预处理兼容字段为空字符串时按未提供处理", () => {
    expect(normalizeKnownCrossToolFields("data_preprocess", {
      method: "combine_columns",
      columns: ["省份", "地区"],
      options: { output_column: "实体键" },
      operator: "",
      right_column: "",
      right_value: "",
      output_column: "",
    })).toEqual({
      method: "combine_columns",
      columns: ["省份", "地区"],
      options: { output_column: "实体键" },
    })
  })

  test("create_column 同时收到 right_column 与 null right_value 时保留有效列比较", () => {
    expect(normalizeKnownCrossToolFields("data_preprocess", {
      method: "create_column",
      columns: ["year"],
      options: { operator: "gte", right_column: "time", right_value: null, output_column: "post" },
    })).toEqual({
      method: "create_column",
      columns: ["year"],
      options: { operator: "gte", right_column: "time", output_column: "post" },
    })
  })
})
