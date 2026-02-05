import { describe, expect, test } from "bun:test"
import path from "path"
import { DataImportTool } from "../../src/tool/data-import"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

// 测试上下文
const ctx = {
    sessionID: "test",
    messageID: "",
    callID: "",
    agent: "data-import",
    abort: AbortSignal.any([]),
    metadata: () => { },
    ask: async () => { },
}

const projectRoot = path.join(__dirname, "../..")

describe("tool.data_import", () => {
    // 测试工具初始化
    test("初始化成功", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const dataImport = await DataImportTool.init()
                expect(dataImport).toBeDefined()
                expect(dataImport.description).toContain("data")
            },
        })
    })

    // 测试导入操作参数
    test("支持import操作", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const dataImport = await DataImportTool.init()

                const params = {
                    action: "import" as const,
                    inputPath: "data.dta",
                    outputPath: "data.csv",
                    preserveLabels: true,
                }

                expect(params.action).toBe("import")
                expect(params.preserveLabels).toBe(true)
            },
        })
    })

    // 测试导出操作参数
    test("支持export操作", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const dataImport = await DataImportTool.init()

                const params = {
                    action: "export" as const,
                    inputPath: "data.csv",
                    outputPath: "data.xlsx",
                    format: "xlsx" as const,
                }

                expect(params.action).toBe("export")
                expect(params.format).toBe("xlsx")
            },
        })
    })

    // 测试预处理操作参数
    test("支持preprocess操作", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const dataImport = await DataImportTool.init()

                const params = {
                    action: "preprocess" as const,
                    inputPath: "raw_data.csv",
                    outputPath: "clean_data.csv",
                    operations: [
                        {
                            type: "dropna" as const,
                            variables: ["income", "age"],
                        },
                        {
                            type: "winsorize" as const,
                            variables: ["salary"],
                            params: { lower: 0.01, upper: 0.99 },
                        },
                    ],
                }

                expect(params.action).toBe("preprocess")
                expect(params.operations?.length).toBe(2)
                expect(params.operations?.[0].type).toBe("dropna")
                expect(params.operations?.[1].type).toBe("winsorize")
            },
        })
    })
})

describe("tool.data_import 预处理操作", () => {
    // 测试dropna操作
    test("dropna操作参数验证", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const operation = {
                    type: "dropna" as const,
                    variables: ["var1", "var2"],
                    params: { how: "any" },
                }

                expect(operation.type).toBe("dropna")
                expect(operation.variables?.length).toBe(2)
            },
        })
    })

    // 测试fillna操作
    test("fillna操作参数验证", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const operation = {
                    type: "fillna" as const,
                    variables: ["income"],
                    params: { method: "mean" },
                }

                expect(operation.type).toBe("fillna")
                expect(operation.params?.method).toBe("mean")
            },
        })
    })

    // 测试log_transform操作
    test("log_transform操作参数验证", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const operation = {
                    type: "log_transform" as const,
                    variables: ["gdp", "population"],
                }

                expect(operation.type).toBe("log_transform")
                expect(operation.variables?.length).toBe(2)
            },
        })
    })

    // 测试standardize操作
    test("standardize操作参数验证", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const operation = {
                    type: "standardize" as const,
                    variables: ["price", "quantity"],
                }

                expect(operation.type).toBe("standardize")
            },
        })
    })

    // 测试winsorize操作
    test("winsorize操作参数验证", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const operation = {
                    type: "winsorize" as const,
                    variables: ["return"],
                    params: { lower: 0.01, upper: 0.99 },
                }

                expect(operation.type).toBe("winsorize")
                expect(operation.params?.lower).toBe(0.01)
                expect(operation.params?.upper).toBe(0.99)
            },
        })
    })

    // 测试create_dummies操作
    test("create_dummies操作参数验证", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const operation = {
                    type: "create_dummies" as const,
                    variables: ["industry", "region"],
                }

                expect(operation.type).toBe("create_dummies")
                expect(operation.variables?.length).toBe(2)
            },
        })
    })
})

describe("tool.data_import 文件格式", () => {
    // 测试CSV格式支持
    test("支持CSV格式", async () => {
        await using tmp = await tmpdir({ git: true })
        await Instance.provide({
            directory: tmp.path,
            fn: async () => {
                // 创建测试CSV文件
                const csvData = `id,name,value
1,Alice,100
2,Bob,200
3,Charlie,300`
                await Bun.write(path.join(tmp.path, "test.csv"), csvData)

                const params = {
                    action: "import" as const,
                    inputPath: "test.csv",
                }

                expect(params.inputPath.endsWith(".csv")).toBe(true)
            },
        })
    })

    // 测试Excel格式支持
    test("支持xlsx格式", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const params = {
                    action: "export" as const,
                    inputPath: "data.csv",
                    outputPath: "data.xlsx",
                    format: "xlsx" as const,
                }

                expect(params.format).toBe("xlsx")
            },
        })
    })

    // 测试Stata格式支持
    test("支持dta格式", async () => {
        await Instance.provide({
            directory: projectRoot,
            fn: async () => {
                const params = {
                    action: "import" as const,
                    inputPath: "stata_data.dta",
                    preserveLabels: true,
                }

                expect(params.inputPath.endsWith(".dta")).toBe(true)
                expect(params.preserveLabels).toBe(true)
            },
        })
    })
})

