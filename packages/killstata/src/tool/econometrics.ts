import z from "zod"
import { Tool } from "./tool"
import { spawn } from "child_process"
import * as path from "path"
import * as fs from "fs"
import DESCRIPTION from "./econometrics.txt"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

const log = Log.create({ service: "econometrics-tool" })

// Python环境路径配置
const PYTHON_CMD = process.platform === "win32" ? "python" : "python3"
const ECONOMETRICS_DIR = path.join(__dirname, "../python/econometrics")

/**
 * 计量经济学工具
 * 通过调用Python计量方法库提供高级计量分析能力
 */
export const EconometricsTool = Tool.define("econometrics", {
    description: DESCRIPTION,
    parameters: z.object({
        methodName: z
            .string()
            .describe(
                "计量方法名称，可选: 'ols_regression', 'psm_matching', 'iv_2sls', 'did_static', 'did_staggered', 'did_event_study', 'rdd'"
            ),
        dataPath: z
            .string()
            .describe("数据文件路径(CSV格式),相对于当前工作目录"),
        dependentVar: z.string().describe("因变量名称"),
        treatmentVar: z.string().describe("处理变量/核心解释变量名称").optional(),
        covariates: z
            .array(z.string())
            .describe("控制变量列表")
            .optional(),
        options: z
            .object({}).passthrough()
            .describe("方法特定的额外参数,如聚类变量、固定效应、稳健标准误等")
            .optional(),
        outputDir: z
            .string()
            .describe("结果输出目录,默认为./analysis/")
            .optional(),
    }),
    async execute(params, ctx) {
        // 解析数据路径
        let dataPath = params.dataPath
        if (!path.isAbsolute(dataPath)) {
            dataPath = path.join(Instance.directory, dataPath)
        }

        // 检查数据文件是否存在
        if (!fs.existsSync(dataPath)) {
            throw new Error(`数据文件不存在: ${dataPath}`)
        }

        // 设置输出目录
        const outputDir = params.outputDir
            ? path.isAbsolute(params.outputDir)
                ? params.outputDir
                : path.join(Instance.directory, params.outputDir)
            : path.join(Instance.directory, "analysis", params.methodName)

        // 创建输出目录
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true })
        }

        // 请求权限
        await ctx.ask({
            permission: "bash",
            patterns: [`${PYTHON_CMD} *econometrics*`],
            always: [`${PYTHON_CMD}*`],
            metadata: {
                description: `执行计量分析: ${params.methodName}`,
            },
        })

        // 构建Python脚本参数
        const scriptArgs = {
            method: params.methodName,
            data_path: dataPath,
            dependent_var: params.dependentVar,
            treatment_var: params.treatmentVar,
            covariates: params.covariates || [],
            options: params.options || {},
            output_dir: outputDir,
        }

        // 创建临时参数文件
        const tempParamsPath = path.join(outputDir, `params_${Date.now()}.json`)
        fs.writeFileSync(tempParamsPath, JSON.stringify(scriptArgs, null, 2))

        log.info("执行计量分析", {
            method: params.methodName,
            dataPath,
            outputDir,
        })

        // 构建Python调用脚本
        const pythonScript = `
import sys
import json
import pandas as pd
import numpy as np
from pathlib import Path

# 添加econometrics模块路径
sys.path.insert(0, '${ECONOMETRICS_DIR.replace(/\\/g, "\\\\")}')

try:
    from econometric_algorithm import *
    from data_preprocess import get_column_info
except ImportError as e:
    print(json.dumps({
        "success": false,
        "error": f"导入计量模块失败: {str(e)}"
    }))
    sys.exit(1)

# 读取参数
with open('${tempParamsPath.replace(/\\/g, "\\\\")}', 'r') as f:
    params = json.load(f)

# 读取数据
try:
    df = pd.read_csv(params['data_path'])
except Exception as e:
    print(json.dumps({
        "success": false,
        "error": f"读取数据失败: {str(e)}"
    }))
    sys.exit(1)

# 准备变量
dependent_var = df[params['dependent_var']]
treatment_var = df[params['treatment_var']] if params.get('treatment_var') else None
covariates = df[params['covariates']] if params['covariates'] else None

# 执行对应的计量方法
result = {}
try:
    method = params['method']
    options = params['options']
    
    if method == 'ols_regression':
        model = ordinary_least_square_regression(
            dependent_var, 
            treatment_var, 
            covariates,
            cov_info=options.get('cov_type', 'nonrobust'),
            target_type='final_model',
            output_tables=True
        )
        result = {
            "success": True,
            "coefficient": float(model.params[treatment_var.name]),
            "std_error": float(model.bse[treatment_var.name]),
            "p_value": float(model.pvalues[treatment_var.name]),
            "r_squared": float(model.rsquared_adj)
        }
    
    elif method == 'did_static':
        # DID方法需要面板数据结构
        model = Static_Diff_in_Diff_regression(
            dependent_var,
            df[options['treatment_entity_dummy']],
            df[options['treatment_finished_dummy']],
            covariates,
            entity_effect=options.get('entity_effect', False),
            time_effect=options.get('time_effect', False),
            cov_type=options.get('cov_type', 'unadjusted'),
            target_type='final_model',
            output_tables=True
        )
        result = {
            "success": True,
            "ate": float(model.params['treatment_group_treated']),
            "std_error": float(model.std_errors['treatment_group_treated']),
            "p_value": float(model.pvalues['treatment_group_treated'])
        }
    
    else:
        result = {
            "success": False,
            "error": f"不支持的方法: {method}"
        }

except Exception as e:
    import traceback
    result = {
        "success": False,
        "error": str(e),
        "traceback": traceback.format_exc()
    }

# 输出结果
print(json.dumps(result, ensure_ascii=False, indent=2))

# 保存结果到文件
output_path = Path(params['output_dir']) / 'results.json'
with open(output_path, 'w') as f:
    json.dump(result, f, ensure_ascii=False, indent=2)
`

        // 执行Python脚本
        return new Promise((resolve, reject) => {
            const proc = spawn(PYTHON_CMD, ["-c", pythonScript], {
                cwd: Instance.directory,
                env: {
                    ...process.env,
                    PYTHONIOENCODING: "utf-8",
                },
            })

            let output = ""
            let errorOutput = ""

            proc.stdout?.on("data", (chunk) => {
                output += chunk.toString()
            })

            proc.stderr?.on("data", (chunk) => {
                errorOutput += chunk.toString()
            })

            proc.on("close", (code) => {
                // 清理临时文件
                try {
                    if (fs.existsSync(tempParamsPath)) {
                        fs.unlinkSync(tempParamsPath)
                    }
                } catch (e) {
                    log.warn("清理临时文件失败", { error: e })
                }

                if (code !== 0) {
                    log.error("Python脚本执行失败", {
                        code,
                        stderr: errorOutput,
                    })
                    reject(
                        new Error(
                            `计量分析失败 (exit code ${code}):\n${errorOutput}\n${output}`
                        )
                    )
                    return
                }

                try {
                    // 解析结果
                    const result = JSON.parse(output.trim().split("\n").pop() || "{}")

                    if (!result.success) {
                        reject(new Error(`分析失败: ${result.error}\n${result.traceback || ""}`))
                        return
                    }

                    // 构建输出消息
                    let resultMessage = `## 计量分析结果 - ${params.methodName}\n\n`
                    resultMessage += `**数据文件**: ${path.relative(Instance.directory, dataPath)}\n`
                    resultMessage += `**因变量**: ${params.dependentVar}\n`

                    if (params.treatmentVar) {
                        resultMessage += `**处理变量**: ${params.treatmentVar}\n`
                    }

                    if (params.covariates && params.covariates.length > 0) {
                        resultMessage += `**控制变量**: ${params.covariates.join(", ")}\n`
                    }

                    resultMessage += `\n### 估计结果\n\n`

                    if (result.coefficient !== undefined) {
                        resultMessage += `- **系数**: ${result.coefficient.toFixed(4)}\n`
                        resultMessage += `- **标准误**: ${result.std_error.toFixed(4)}\n`
                        resultMessage += `- **P值**: ${result.p_value.toFixed(4)} ${result.p_value < 0.01 ? "***" : result.p_value < 0.05 ? "**" : result.p_value < 0.1 ? "*" : ""}\n`
                    }

                    if (result.r_squared !== undefined) {
                        resultMessage += `- **调整R²**: ${result.r_squared.toFixed(4)}\n`
                    }

                    if (result.ate !== undefined) {
                        resultMessage += `- **平均处理效应(ATE)**: ${result.ate.toFixed(4)}\n`
                    }

                    resultMessage += `\n结果已保存到: ${path.relative(Instance.directory, outputDir)}/\n`

                    resolve({
                        title: `计量分析: ${params.methodName}`,
                        output: resultMessage,
                        metadata: {
                            method: params.methodName,
                            result,
                            outputDir: path.relative(Instance.directory, outputDir),
                        },
                    })
                } catch (e) {
                    reject(new Error(`解析结果失败: ${e}\n输出:\n${output}`))
                }
            })

            proc.on("error", (error) => {
                reject(new Error(`启动Python进程失败: ${error.message}`))
            })
        })
    },
})
