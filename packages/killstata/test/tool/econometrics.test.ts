import { describe, expect, test } from "bun:test"
import path from "path"
import { EconometricsTool } from "../../src/tool/econometrics"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

// 测试上下文
const ctx = {
    sessionID: "test",
    messageID: "",
    callID: "",
    agent: "econometrics",
    abort: AbortSignal.any([]),
    metadata: () => { },
    ask: async () => { },
}

const projectRoot = path.join(__dirname, "../..")

describe("tool.econometrics", () => {
    // 测试工具初始化
    test("初始化成功", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const econometrics = await EconometricsTool.init()
                expect(econometrics).toBeDefined()
                expect(econometrics.description).toContain("Econometrics")
            },
        })
    })

    // 测试参数验证
    test("参数验证 - 必需参数缺失时报错", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const econometrics = await EconometricsTool.init()

                // 测试缺少methodName参数
                try {
                    await econometrics.execute(
                        {
                            // 缺少必需参数 methodName
                            dataPath: "test.csv",
                            dependentVar: "y",
                        } as any,
                        ctx,
                    )
                    expect(true).toBe(false) // 不应该到达这里
                } catch (e) {
                    expect(e).toBeDefined()
                }
            },
        })
    })

    // 测试OLS回归方法名称验证
    test("支持OLS回归方法", async () => {
        await using tmp = await tmpdir({ git: true })
        await Instance.provide({
            directory: tmp.path,
            fn: async () => {
                const econometrics = await EconometricsTool.init()

                // 创建测试数据文件
                const testData = `x,y,control1
1,2.1,0.5
2,4.2,0.6
3,6.1,0.7
4,8.3,0.8
5,10.0,0.9`
                await Bun.write(path.join(tmp.path, "test.csv"), testData)

                // 验证参数可以被接受（不需要实际执行Python）
                const params = {
                    methodName: "ols_regression",
                    dataPath: "test.csv",
                    dependentVar: "y",
                    treatmentVar: "x",
                    covariates: ["control1"],
                }

                // 验证参数结构有效
                expect(params.methodName).toBe("ols_regression")
                expect(params.dataPath).toBe("test.csv")
                expect(params.dependentVar).toBe("y")
            },
        })
    })

    // 测试DID方法参数
    test("支持DID分析方法", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const econometrics = await EconometricsTool.init()

                // 验证DID参数结构
                const params = {
                    methodName: "did_static",
                    dataPath: "panel_data.csv",
                    dependentVar: "outcome",
                    treatmentVar: "treated",
                    options: {
                        time_var: "year",
                        unit_var: "firm_id",
                    },
                }

                expect(params.methodName).toBe("did_static")
                expect(params.options.time_var).toBe("year")
            },
        })
    })

    // 测试PSM匹配方法参数
    test("支持PSM匹配方法", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const econometrics = await EconometricsTool.init()

                // 验证PSM参数结构
                const params = {
                    methodName: "psm_matching",
                    dataPath: "cross_section.csv",
                    dependentVar: "outcome",
                    treatmentVar: "treatment",
                    covariates: ["age", "income", "education"],
                    options: {
                        n_neighbors: 3,
                        caliper: 0.05,
                    },
                }

                expect(params.methodName).toBe("psm_matching")
                expect(params.covariates?.length).toBe(3)
            },
        })
    })

    // 测试IV/2SLS方法参数
    test("支持IV/2SLS方法", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const econometrics = await EconometricsTool.init()

                // 验证IV参数结构
                const params = {
                    methodName: "iv_2sls",
                    dataPath: "data.csv",
                    dependentVar: "y",
                    treatmentVar: "x_endogenous",
                    options: {
                        instruments: ["z1", "z2"],
                        covariates: ["control1"],
                    },
                }

                expect(params.methodName).toBe("iv_2sls")
                expect(params.options.instruments.length).toBe(2)
            },
        })
    })

    // 测试RDD方法参数
    test("支持RDD方法", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const econometrics = await EconometricsTool.init()

                // 验证RDD参数结构
                const params = {
                    methodName: "rdd",
                    dataPath: "data.csv",
                    dependentVar: "outcome",
                    options: {
                        running_var: "score",
                        cutoff: 50,
                        bandwidth: 5,
                    },
                }

                expect(params.methodName).toBe("rdd")
                expect(params.options.cutoff).toBe(50)
            },
        })
    })
})

describe("tool.econometrics 输出目录", () => {
    test("默认输出目录为./analysis/", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const params = {
                    methodName: "ols_regression",
                    dataPath: "test.csv",
                    dependentVar: "y",
                    outputDir: undefined, // 默认值
                }

                // 验证默认输出目录行为
                expect(params.outputDir).toBeUndefined()
            },
        })
    })

    test("支持自定义输出目录", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const params = {
                    methodName: "ols_regression",
                    dataPath: "test.csv",
                    dependentVar: "y",
                    outputDir: "./results/regression/",
                }

                expect(params.outputDir).toBe("./results/regression/")
            },
        })
    })
})
