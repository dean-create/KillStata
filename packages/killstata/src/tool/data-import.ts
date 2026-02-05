import z from "zod"
import { Tool } from "./tool"
import { spawn } from "child_process"
import * as path from "path"
import * as fs from "fs"
import DESCRIPTION from "./data-import.txt"
import { Instance } from "../project/instance"
import { Log } from "../util/log"

const log = Log.create({ service: "data-import-tool" })

// Python环境路径配置
const PYTHON_CMD = process.platform === "win32" ? "python" : "python3"
const ECONOMETRICS_DIR = path.join(__dirname, "../python/econometrics")

/**
 * 数据导入/转换工具
 * 支持Excel、Stata DTA与CSV之间的互转
 * 提供数据预处理能力
 */
export const DataImportTool = Tool.define("data_import", {
    description: DESCRIPTION,
    parameters: z.object({
        action: z
            .enum(["import", "export", "preprocess"])
            .describe("操作类型: import(导入), export(导出), preprocess(预处理)"),
        inputPath: z.string().describe("输入文件路径"),
        outputPath: z.string().describe("输出文件路径").optional(),
        format: z
            .enum(["csv", "xlsx", "dta"])
            .describe("目标格式(用于export操作)")
            .optional(),
        preserveLabels: z
            .boolean()
            .describe("是否保留变量标签(适用于import操作)")
            .default(true),
        operations: z
            .array(
                z.object({
                    type: z
                        .enum([
                            "dropna",
                            "fillna",
                            "log_transform",
                            "standardize",
                            "winsorize",
                            "create_dummies",
                        ])
                        .describe("预处理操作类型"),
                    variables: z.array(z.string()).describe("目标变量列表").optional(),
                    params: z.object({}).passthrough().describe("操作特定参数").optional(),
                })
            )
            .describe("预处理操作序列(用于preprocess操作)")
            .optional(),
    }),
    async execute(params, ctx) {
        // 解析输入路径
        let inputPath = params.inputPath
        if (!path.isAbsolute(inputPath)) {
            inputPath = path.join(Instance.directory, inputPath)
        }

        // 检查输入文件是否存在
        if (!fs.existsSync(inputPath)) {
            throw new Error(`输入文件不存在: ${inputPath}`)
        }

        // 解析输出路径
        let outputPath = params.outputPath
        if (!outputPath) {
            // 自动生成输出路径
            const ext = path.extname(inputPath)
            const basename = path.basename(inputPath, ext)
            const dirname = path.dirname(inputPath)

            if (params.action === "import") {
                // 导入时默认输出到cleaned目录
                const cleanedDir = path.join(Instance.directory, "data", "cleaned")
                if (!fs.existsSync(cleanedDir)) {
                    fs.mkdirSync(cleanedDir, { recursive: true })
                }
                outputPath = path.join(cleanedDir, `${basename}.csv`)
            } else if (params.action === "export") {
                const targetExt = params.format === "xlsx" ? ".xlsx" : params.format === "dta" ? ".dta" : ".csv"
                outputPath = path.join(dirname, `${basename}${targetExt}`)
            } else if (params.action === "preprocess") {
                outputPath = path.join(dirname, `${basename}_processed.csv`)
            }
        } else if (!path.isAbsolute(outputPath)) {
            outputPath = path.join(Instance.directory, outputPath)
        }

        // 确保输出目录存在
        const outputDir = path.dirname(outputPath)
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true })
        }

        // 请求权限
        await ctx.ask({
            permission: "bash",
            patterns: [`${PYTHON_CMD} *data*`],
            always: [`${PYTHON_CMD}*`],
            metadata: {
                description: `数据${params.action === "import" ? "导入" : params.action === "export" ? "导出" : "预处理"}`,
            },
        })

        log.info("执行数据操作", {
            action: params.action,
            inputPath,
            outputPath,
        })

        // 构建Python脚本
        const pythonScript = `
import sys
import json
import pandas as pd
import numpy as np
from pathlib import Path

# 添加econometrics模块路径
sys.path.insert(0, '${ECONOMETRICS_DIR.replace(/\\/g, "\\\\")}')

try:
    from data_preprocess import get_column_info
except ImportError as e:
    print(json.dumps({
        "success": False,
        "error": f"导入模块失败: {str(e)}"
    }))
    sys.exit(1)

input_path = '${inputPath.replace(/\\/g, "\\\\")}'
output_path = '${outputPath.replace(/\\/g, "\\\\")}'
action = '${params.action}'

result = {}

try:
    if action == 'import':
        # 读取不同格式的文件
        input_ext = Path(input_path).suffix.lower()
        
        if input_ext == '.csv':
            df = pd.read_csv(input_path)
            metadata = {}
        elif input_ext == '.xlsx' or input_ext == '.xls':
            df = pd.read_excel(input_path)
            metadata = {"source_format": "excel"}
        elif input_ext == '.dta':
            # 读取Stata文件,保留标签
            df = pd.read_stata(input_path, preserve_dtypes=False)
            # 提取变量标签
            try:
                stata_reader = pd.io.stata.StataReader(input_path)
                var_labels = stata_reader.variable_labels()
                metadata = {
                    "source_format": "stata",
                    "variable_labels": var_labels
                }
            except:
                metadata = {"source_format": "stata"}
        else:
            raise ValueError(f"不支持的输入格式: {input_ext}")
        
        # 保存为CSV
        df.to_csv(output_path, index=False, encoding='utf-8-sig')
        
        # 保存元数据
        if ${params.preserveLabels ? "True" : "False"}:
            metadata_path = output_path.replace('.csv', '_metadata.json')
            with open(metadata_path, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, ensure_ascii=False, indent=2)
        
        # 获取列信息
        column_info = get_column_info(df)
        
        result = {
            "success": True,
            "action": "import",
            "rows": len(df),
            "columns": len(df.columns),
            "column_info": column_info,
            "output_path": output_path,
            "metadata_saved": ${params.preserveLabels ? "True" : "False"}
        }
    
    elif action == 'export':
        # 读取CSV
        df = pd.read_csv(input_path)
        
        # 尝试读取元数据
        metadata_path = input_path.replace('.csv', '_metadata.json')
        metadata = {}
        if Path(metadata_path).exists():
            with open(metadata_path, 'r', encoding='utf-8') as f:
                metadata = json.load(f)
        
        # 导出到目标格式
        export_format = '${params.format || "csv"}'
        
        if export_format == 'xlsx':
            df.to_excel(output_path, index=False, engine='openpyxl')
        elif export_format == 'dta':
            # 恢复变量标签(如果有)
            if 'variable_labels' in metadata:
                # Stata格式导出时应用标签
                df.to_stata(output_path, 
                           write_index=False,
                           variable_labels=metadata.get('variable_labels', {}))
            else:
                df.to_stata(output_path, write_index=False)
        elif export_format == 'csv':
            df.to_csv(output_path, index=False, encoding='utf-8-sig')
        else:
            raise ValueError(f"不支持的导出格式: {export_format}")
        
        result = {
            "success": True,
            "action": "export",
            "format": export_format,
            "rows": len(df),
            "columns": len(df.columns),
            "output_path": output_path
        }
    
    elif action == 'preprocess':
        # 读取CSV
        df = pd.read_csv(input_path)
        
        operations = ${JSON.stringify(params.operations || [])}
        log_entries = []
        
        for op in operations:
            op_type = op['type']
            variables = op.get('variables', [])
            op_params = op.get('params', {})
            
            if op_type == 'dropna':
                before = len(df)
                if variables:
                    df = df.dropna(subset=variables)
                else:
                    df = df.dropna()
                log_entries.append(f"删除缺失值: {before - len(df)} 行被删除")
            
            elif op_type == 'fillna':
                fill_value = op_params.get('value', 0)
                for var in variables:
                    df[var].fillna(fill_value, inplace=True)
                log_entries.append(f"填充缺失值: {', '.join(variables)} 使用值 {fill_value}")
            
            elif op_type == 'log_transform':
                for var in variables:
                    df[f'log_{var}'] = np.log(df[var] + 1)  # log(x+1)避免log(0)
                log_entries.append(f"对数变换: {', '.join(variables)}")
            
            elif op_type == 'standardize':
                for var in variables:
                    mean = df[var].mean()
                    std = df[var].std()
                    df[f'{var}_std'] = (df[var] - mean) / std
                log_entries.append(f"标准化: {', '.join(variables)}")
            
            elif op_type == 'winsorize':
                from scipy.stats.mstats import winsorize
                limits = op_params.get('limits', [0.01, 0.01])
                for var in variables:
                    df[var] = winsorize(df[var], limits=limits)
                log_entries.append(f"Winsorize: {', '.join(variables)} at {limits}")
            
            elif op_type == 'create_dummies':
                for var in variables:
                    dummies = pd.get_dummies(df[var], prefix=var, drop_first=True)
                    df = pd.concat([df, dummies], axis=1)
                log_entries.append(f"创建虚拟变量: {', '.join(variables)}")
        
        # 保存处理后的数据
        df.to_csv(output_path, index=False, encoding='utf-8-sig')
        
        # 保存处理日志
        log_path = output_path.replace('.csv', '_log.md')
        with open(log_path, 'w', encoding='utf-8') as f:
            f.write(f"# 数据预处理日志\\n\\n")
            f.write(f"**输入文件**: {input_path}\\n")
            f.write(f"**输出文件**: {output_path}\\n")
            f.write(f"**处理时间**: {pd.Timestamp.now()}\\n\\n")
            f.write(f"## 处理步骤\\n\\n")
            for i, entry in enumerate(log_entries, 1):
                f.write(f"{i}. {entry}\\n")
        
        column_info = get_column_info(df)
        
        result = {
            "success": True,
            "action": "preprocess",
            "operations_count": len(operations),
            "rows": len(df),
            "columns": len(df.columns),
            "column_info": column_info,
            "output_path": output_path,
            "log_path": log_path
        }
    
    else:
        raise ValueError(f"不支持的操作: {action}")

except Exception as e:
    import traceback
    result = {
        "success": False,
        "error": str(e),
        "traceback": traceback.format_exc()
    }

print(json.dumps(result, ensure_ascii=False, indent=2))
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
                if (code !== 0) {
                    log.error("Python脚本执行失败", {
                        code,
                        stderr: errorOutput,
                    })
                    reject(
                        new Error(
                            `数据操作失败 (exit code ${code}):\n${errorOutput}\n${output}`
                        )
                    )
                    return
                }

                try {
                    const result = JSON.parse(output.trim().split("\n").pop() || "{}")

                    if (!result.success) {
                        reject(
                            new Error(`操作失败: ${result.error}\n${result.traceback || ""}`)
                        )
                        return
                    }

                    // 构建输出消息
                    let resultMessage = `## 数据${params.action === "import" ? "导入" : params.action === "export" ? "导出" : "预处理"}完成\n\n`

                    resultMessage += `**输入文件**: ${path.relative(Instance.directory, inputPath)}\n`
                    resultMessage += `**输出文件**: ${path.relative(Instance.directory, result.output_path)}\n`
                    resultMessage += `**数据规模**: ${result.rows} 行 × ${result.columns} 列\n\n`

                    if (params.action === "import" && result.column_info) {
                        resultMessage += `### 变量类型分布\n\n`
                        const colInfo = result.column_info
                        if (colInfo.Numeric && colInfo.Numeric.length > 0) {
                            resultMessage += `- **数值型**: ${colInfo.Numeric.length} 个\n`
                        }
                        if (colInfo.Category && colInfo.Category.length > 0) {
                            resultMessage += `- **分类型**: ${colInfo.Category.length} 个\n`
                        }
                        if (colInfo.Datetime && colInfo.Datetime.length > 0) {
                            resultMessage += `- **日期型**: ${colInfo.Datetime.length} 个\n`
                        }

                        if (result.metadata_saved) {
                            resultMessage += `\n变量标签已保存到元数据文件\n`
                        }
                    }

                    if (params.action === "preprocess" && result.operations_count) {
                        resultMessage += `### 处理操作\n\n`
                        resultMessage += `共执行 ${result.operations_count} 个预处理步骤\n`
                        resultMessage += `\n详细日志: ${path.relative(Instance.directory, result.log_path)}\n`
                    }

                    if (params.action === "export") {
                        resultMessage += `\n数据已导出为 **${result.format.toUpperCase()}** 格式\n`
                    }

                    resolve({
                        title: `数据${params.action === "import" ? "导入" : params.action === "export" ? "导出" : "预处理"}`,
                        output: resultMessage,
                        metadata: {
                            action: params.action,
                            result,
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
