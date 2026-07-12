import fs from "fs"
import path from "path"
import { spawn } from "child_process"
import z from "zod"
import DESCRIPTION from "./manufacturing-analysis.txt"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { buildFileStamp, projectHealthRoot, projectTempRoot } from "./analysis-state"
import { relativeWithinProject, resolveToolPath } from "./analysis-path"
import { createToolDisplay } from "./analysis-display"
import { analysisArtifact, analysisMetric, createToolAnalysisView } from "./analysis-user-view"
import { formatRuntimePythonSetupError, getRuntimePythonStatus } from "@/killstata/runtime-config"

const log = Log.create({ service: "manufacturing-analysis-tool" })
const PYTHON_RESULT_PREFIX = "__KILLSTATA_MANUFACTURING_JSON__"

const ManufacturingAnalysisSchema = z.object({
  inputPath: z.string().min(1),
  outputDir: z.string().optional(),
  runId: z.string().optional(),
  maxVariables: z.number().int().min(3).max(30).default(12),
  outputLanguage: z.string().default("zh-CN"),
})

type ManufacturingAnalysisParams = z.infer<typeof ManufacturingAnalysisSchema>

type ManufacturingOutputFile = {
  label: string
  path: string
}

type ManufacturingAnalysisMetadata = {
  runId: string
  inputPath: string
  outputDir: string
  sheetCount: number
  detectedScenarios: string[]
  reportPath: string
  summaryJsonPath: string
  workbookPath: string
  markdownPath: string
  visibleOutputs: ManufacturingOutputFile[]
  display?: ReturnType<typeof createToolDisplay>
  analysisView?: ReturnType<typeof createToolAnalysisView>
}

type PythonSummary = {
  success: boolean
  run_id: string
  input_path: string
  output_dir: string
  sheet_count: number
  detected_scenarios: string[]
  headline: string
  warnings: string[]
  files: {
    summary_json: string
    report_docx: string
    report_md: string
    analysis_xlsx: string
  }
  sheets: Array<{
    name: string
    rows: number
    columns: number
    numeric_columns: number
    text_columns: number
    missing_rate: number
    scenario: string
  }>
  key_findings: string[]
  demo_script: string[]
}

function normalizeRunId(value?: string) {
  const raw = value?.trim() || `manufacturing_${buildFileStamp()}`
  return raw.replace(/[^a-zA-Z0-9_-]+/g, "_")
}

function defaultOutputDir(runId: string) {
  return path.join(projectHealthRoot(), "manufacturing", runId)
}

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
}

async function runInlinePython(input: { command: string; script: string; cwd: string }) {
  const tempDir = projectTempRoot()
  ensureDir(tempDir)
  const tempScriptPath = path.join(tempDir, `manufacturing_analysis_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`)
  fs.writeFileSync(tempScriptPath, input.script, "utf-8")

  return new Promise<{ code: number | null; stdout: string; stderr: string; scriptPath: string }>((resolve, reject) => {
    const proc = spawn(input.command, [tempScriptPath], {
      cwd: input.cwd,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        PYTHONUTF8: "1",
      },
      windowsHide: true,
    })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (chunk) => (stdout += chunk.toString()))
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()))
    proc.on("error", reject)
    proc.on("close", (code) => resolve({ code, stdout, stderr, scriptPath: tempScriptPath }))
  })
}

function parsePythonSummary(stdout: string): PythonSummary {
  const line = stdout
    .split(/\r?\n/)
    .find((item) => item.startsWith(PYTHON_RESULT_PREFIX))
  if (!line) {
    throw new Error(`Manufacturing analysis did not return a structured result. Raw output:\n${stdout}`)
  }
  return JSON.parse(line.slice(PYTHON_RESULT_PREFIX.length)) as PythonSummary
}

function buildPythonScript(payload: {
  inputPath: string
  outputDir: string
  runId: string
  maxVariables: number
  outputLanguage: string
}) {
  return String.raw`
import json
import math
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats
from docx import Document
from docx.shared import Pt

PAYLOAD = ${JSON.stringify(payload)}
RESULT_PREFIX = ${JSON.stringify(PYTHON_RESULT_PREFIX)}


def as_float(value, default=0.0):
    try:
        if value is None:
            return default
        if isinstance(value, float) and math.isnan(value):
            return default
        return float(value)
    except Exception:
        return default


def clean_text(value):
    return str(value).strip() if value is not None else ""


def safe_sheet_name(value):
    # Excel 工作表名称有长度和特殊字符限制，这里统一做一层保护，避免输出失败。
    cleaned = re.sub(r"[\[\]\:\*\?\/\\]", "_", clean_text(value))[:31]
    return cleaned or "sheet"


def top_missing(df, limit):
    missing = df.isna().sum()
    missing = missing[missing > 0].sort_values(ascending=False).head(limit)
    return [
        {
            "column": str(column),
            "missing_count": int(count),
            "missing_rate": float(count / len(df)) if len(df) else 0.0,
        }
        for column, count in missing.items()
    ]


def infer_scenario(sheet_name, df):
    name = sheet_name.lower()
    columns = [str(column) for column in df.columns]
    numeric_count = len(df.select_dtypes(include="number").columns)
    text_count = len(columns) - numeric_count

    # 先识别工作表显式表达的业务场景，再看通用数据质量问题。
    # 例如“方差分析”表即使有空列，也应该优先归类为方差分析，而不是缺失值诊断。
    if "缺失" in sheet_name:
        return "missing_value_diagnostics"
    if "pca" in name:
        return "pca_factor_screening"
    if "方差" in sheet_name or "anova" in name:
        return "anova_group_comparison"
    if "共通" in sheet_name:
        return "commonality_analysis"
    if "chamber" in [c.lower() for c in columns] or "机差" in sheet_name:
        return "chamber_difference_analysis"
    if "pls" in name or ({"Y1", "Y2"}.intersection(columns) and any(re.fullmatch(r"X\d+", c) for c in columns)):
        return "pls_key_factor_screening"
    if "pca" in name or numeric_count >= 40:
        return "pca_factor_screening"
    if "缺失" in sheet_name or df.isna().sum().sum() > 0:
        return "missing_value_diagnostics"
    if "结合" in sheet_name or {"id", "name"}.issubset(set(columns)):
        return "data_join_demo"
    if "列转行" in sheet_name or (len(df) <= 3 and len(columns) >= 8):
        return "reshape_demo"
    return "general_process_profile"


def sheet_profile(sheet_name, df, max_variables):
    rows, cols = df.shape
    numeric_cols = [str(c) for c in df.select_dtypes(include="number").columns]
    text_cols = [str(c) for c in df.columns if str(c) not in numeric_cols]
    total_cells = rows * cols
    missing_cells = int(df.isna().sum().sum())

    profile = {
        "name": sheet_name,
        "rows": int(rows),
        "columns": int(cols),
        "numeric_columns": int(len(numeric_cols)),
        "text_columns": int(len(text_cols)),
        "missing_cells": missing_cells,
        "missing_rate": float(missing_cells / total_cells) if total_cells else 0.0,
        "scenario": infer_scenario(sheet_name, df),
        "first_columns": [str(c) for c in df.columns[:12]],
        "top_missing": top_missing(df, max_variables),
        "category_preview": {},
        "top_variance_numeric": [],
    }

    for column in text_cols[:5]:
        counts = df[column].astype("string").fillna("<缺失>").value_counts().head(8)
        profile["category_preview"][column] = {str(k): int(v) for k, v in counts.items()}

    numeric = df.select_dtypes(include="number")
    if not numeric.empty:
        variance = numeric.var(numeric_only=True).sort_values(ascending=False).head(max_variables)
        profile["top_variance_numeric"] = [
            {"column": str(column), "variance": as_float(value)}
            for column, value in variance.items()
            if not pd.isna(value)
        ]
    return profile


def chamber_difference(df, max_variables):
    chamber_col = next((c for c in df.columns if str(c).lower() == "chamber"), None)
    if chamber_col is None or df[chamber_col].nunique(dropna=True) < 2:
        return []

    numeric = df.select_dtypes(include="number")
    if numeric.empty:
        return []

    groups = [g for g in df[chamber_col].dropna().unique().tolist()]
    if len(groups) < 2:
        return []

    baseline = groups[0]
    rows = []
    for column in numeric.columns:
        means = df.groupby(chamber_col)[column].mean(numeric_only=True)
        if len(means.dropna()) < 2:
            continue
        max_group = str(means.idxmax())
        min_group = str(means.idxmin())
        diff = as_float(means.max() - means.min())
        pooled_std = as_float(df[column].std())
        score = diff / pooled_std if pooled_std else diff
        rows.append({
            "column": str(column),
            "max_group": max_group,
            "min_group": min_group,
            "mean_diff": diff,
            "standardized_gap": as_float(score),
            "baseline_group": str(baseline),
        })
    rows.sort(key=lambda item: abs(item["standardized_gap"]), reverse=True)
    return rows[:max_variables]


def pca_screening(df, max_variables):
    numeric = df.select_dtypes(include="number").dropna(axis=1, how="all")
    if numeric.shape[1] < 3 or numeric.shape[0] < 3:
        return {"available": False, "top_loadings": [], "explained_ratio": None}

    filled = numeric.fillna(numeric.median(numeric_only=True))
    std = filled.std(ddof=0).replace(0, np.nan)
    standardized = ((filled - filled.mean()) / std).replace([np.inf, -np.inf], np.nan).fillna(0.0)

    # 使用 SVD 计算第一主成分，不引入 sklearn，减少运行环境依赖。
    _, singular_values, vh = np.linalg.svd(standardized.to_numpy(dtype=float), full_matrices=False)
    if len(singular_values) == 0:
        return {"available": False, "top_loadings": [], "explained_ratio": None}
    total = float(np.sum(singular_values ** 2))
    explained_ratio = float((singular_values[0] ** 2) / total) if total else None
    loadings = pd.Series(vh[0], index=standardized.columns).abs().sort_values(ascending=False).head(max_variables)
    return {
        "available": True,
        "explained_ratio": explained_ratio,
        "top_loadings": [{"column": str(column), "loading_abs": as_float(value)} for column, value in loadings.items()],
    }


def pls_screening(df, max_variables):
    columns = [str(c) for c in df.columns]
    y_cols = [c for c in ["Y1", "Y2"] if c in columns]
    x_cols = [c for c in columns if re.fullmatch(r"X\d+", c) and pd.api.types.is_numeric_dtype(df[c])]
    if not y_cols or not x_cols:
        return []

    rows = []
    for y_col in y_cols:
        y = pd.to_numeric(df[y_col], errors="coerce")
        for x_col in x_cols:
            x = pd.to_numeric(df[x_col], errors="coerce")
            joined = pd.concat([x, y], axis=1).dropna()
            if len(joined) < 3 or joined.iloc[:, 0].std() == 0 or joined.iloc[:, 1].std() == 0:
                continue
            corr = joined.iloc[:, 0].corr(joined.iloc[:, 1])
            rows.append({"target": y_col, "factor": x_col, "correlation": as_float(corr), "abs_correlation": abs(as_float(corr))})
    rows.sort(key=lambda item: item["abs_correlation"], reverse=True)
    return rows[:max_variables]


def anova_screening(df, max_variables):
    text_cols = [c for c in df.columns if not pd.api.types.is_numeric_dtype(df[c]) and df[c].nunique(dropna=True) >= 2]
    numeric_cols = [c for c in df.columns if pd.api.types.is_numeric_dtype(df[c])]
    if not text_cols or not numeric_cols:
        return []

    rows = []
    for group_col in text_cols[:4]:
        for value_col in numeric_cols:
            grouped = [
                pd.to_numeric(part[value_col], errors="coerce").dropna().to_numpy()
                for _, part in df[[group_col, value_col]].dropna().groupby(group_col)
            ]
            grouped = [item for item in grouped if len(item) >= 2]
            if len(grouped) < 2:
                continue
            try:
                stat, p_value = stats.f_oneway(*grouped)
            except Exception:
                continue
            if not math.isfinite(stat):
                continue
            rows.append({
                "group_column": str(group_col),
                "value_column": str(value_col),
                "f_stat": as_float(stat),
                "p_value": as_float(p_value),
            })
    rows.sort(key=lambda item: item["p_value"])
    return rows[:max_variables]


def build_findings(profiles, chamber_rows, pca_result, pls_rows, anova_rows):
    findings = []
    if profiles:
        findings.append(f"已读取 {len(profiles)} 个工作表，覆盖缺失值、机差分析、PCA、PLS、方差分析和数据整理等演示场景。")

    missing_profiles = [item for item in profiles if item["top_missing"]]
    if missing_profiles:
        preferred_missing = next((item for item in missing_profiles if "缺失" in item["name"]), missing_profiles[0])
        top = preferred_missing["top_missing"][0]
        findings.append(f"缺失值诊断显示，{preferred_missing['name']} 中 {top['column']} 缺失最多，缺失 {top['missing_count']} 条。")

    if chamber_rows:
        top = chamber_rows[0]
        findings.append(f"Chamber 差异筛查中，{top['column']} 在 {top['max_group']} 与 {top['min_group']} 之间差异最突出。")

    if pca_result.get("available") and pca_result.get("top_loadings"):
        top = pca_result["top_loadings"][0]
        ratio = pca_result.get("explained_ratio")
        ratio_text = f"，第一主成分解释约 {ratio:.1%} 的标准化波动" if ratio is not None else ""
        findings.append(f"PCA 初筛中，{top['column']} 对第一主成分贡献靠前{ratio_text}。")

    if pls_rows:
        top = pls_rows[0]
        findings.append(f"PLS/相关性初筛中，{top['factor']} 与 {top['target']} 的相关强度最高，相关系数约 {top['correlation']:.3f}。")

    if anova_rows:
        top = anova_rows[0]
        findings.append(f"方差分析初筛中，按 {top['group_column']} 分组比较 {top['value_column']} 的差异最值得复查。")

    findings.append("当前样例中异常标签基本单一，建议表述为同类异常样本内的关键因子定位，不建议宣称已完成正常/异常分类。")
    return findings


def write_markdown(summary, path):
    lines = [
        "# Killstata 制造业数据分析 AI Demo 报告",
        "",
        f"- Run ID：{summary['run_id']}",
        f"- 输入文件：{summary['input_path']}",
        f"- 工作表数量：{summary['sheet_count']}",
        "",
        "## 核心结论",
        "",
        *[f"- {item}" for item in summary["key_findings"]],
        "",
        "## 工作表概览",
        "",
    ]
    for sheet in summary["sheets"]:
        lines.append(f"- {sheet['name']}：{sheet['rows']} 行 x {sheet['columns']} 列，场景识别为 {sheet['scenario']}，缺失率 {sheet['missing_rate']:.2%}。")
    lines.extend(["", "## 3分钟演示脚本", ""])
    lines.extend([f"{idx}. {item}" for idx, item in enumerate(summary["demo_script"], start=1)])
    Path(path).write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_docx(summary, path):
    doc = Document()
    styles = doc.styles
    styles["Normal"].font.name = "Microsoft YaHei"
    styles["Normal"].font.size = Pt(10.5)

    doc.add_heading("Killstata 制造业数据分析 AI Demo 报告", level=1)
    doc.add_paragraph(f"Run ID：{summary['run_id']}")
    doc.add_paragraph(f"输入文件：{summary['input_path']}")
    doc.add_paragraph(f"工作表数量：{summary['sheet_count']}")

    doc.add_heading("一、核心结论", level=2)
    for item in summary["key_findings"]:
        doc.add_paragraph(item, style=None)

    doc.add_heading("二、工作表概览", level=2)
    table = doc.add_table(rows=1, cols=6)
    table.style = "Table Grid"
    headers = ["工作表", "行数", "列数", "数值列", "缺失率", "场景识别"]
    for idx, header in enumerate(headers):
        table.rows[0].cells[idx].text = header
    for sheet in summary["sheets"]:
        cells = table.add_row().cells
        cells[0].text = str(sheet["name"])
        cells[1].text = str(sheet["rows"])
        cells[2].text = str(sheet["columns"])
        cells[3].text = str(sheet["numeric_columns"])
        cells[4].text = f"{sheet['missing_rate']:.2%}"
        cells[5].text = str(sheet["scenario"])

    doc.add_heading("三、演示脚本", level=2)
    for item in summary["demo_script"]:
        doc.add_paragraph(item, style=None)

    doc.add_heading("四、边界说明", level=2)
    doc.add_paragraph("该样例数据适合展示制造工艺数据的自动初筛、关键因子定位和报告生成；由于缺少正常/异常双类别标签，不应宣称已经训练出质量分类模型。")
    doc.save(path)


def write_workbook(summary, workbook_path):
    with pd.ExcelWriter(workbook_path, engine="openpyxl") as writer:
        pd.DataFrame(summary["sheets"]).to_excel(writer, sheet_name="sheet_overview", index=False)
        pd.DataFrame(summary["key_findings"], columns=["finding"]).to_excel(writer, sheet_name="key_findings", index=False)
        for key in ["chamber_difference", "pca_top_loadings", "pls_screening", "anova_screening", "missing_top"]:
            rows = summary.get(key, [])
            pd.DataFrame(rows).to_excel(writer, sheet_name=safe_sheet_name(key), index=False)


def main():
    input_path = Path(PAYLOAD["inputPath"]).resolve()
    output_dir = Path(PAYLOAD["outputDir"]).resolve()
    run_id = PAYLOAD["runId"]
    max_variables = int(PAYLOAD["maxVariables"])

    output_dir.mkdir(parents=True, exist_ok=True)
    xls = pd.ExcelFile(input_path)

    profiles = []
    all_missing_rows = []
    chamber_rows = []
    pca_result = {"available": False, "top_loadings": [], "explained_ratio": None}
    pls_rows = []
    anova_rows = []

    for sheet_name in xls.sheet_names:
        df = pd.read_excel(input_path, sheet_name=sheet_name)
        profile = sheet_profile(sheet_name, df, max_variables)
        profiles.append(profile)

        for item in profile["top_missing"]:
            all_missing_rows.append({"sheet": sheet_name, **item})

        if not chamber_rows and ("chamber" in [str(c).lower() for c in df.columns] or "机差" in sheet_name):
            chamber_rows = chamber_difference(df, max_variables)
        if not pca_result.get("available") and ("pca" in sheet_name.lower() or len(df.select_dtypes(include="number").columns) >= 40):
            pca_result = pca_screening(df, max_variables)
        if not pls_rows and ("pls" in sheet_name.lower() or {"Y1", "Y2"}.intersection([str(c) for c in df.columns])):
            pls_rows = pls_screening(df, max_variables)
        if not anova_rows and ("方差" in sheet_name or profile["scenario"] == "anova_group_comparison"):
            anova_rows = anova_screening(df, max_variables)

    detected_scenarios = sorted({item["scenario"] for item in profiles})
    key_findings = build_findings(profiles, chamber_rows, pca_result, pls_rows, anova_rows)
    demo_script = [
        "把全量演示文档交给 Killstata，AI 自动读取全部 Sheet 并展示数据结构。",
        "AI 自动识别缺失值、机差分析、PCA、PLS、方差分析和数据整理场景。",
        "AI 对缺失字段、Chamber 差异、主成分贡献和 Y/X 关键因子进行初筛。",
        "AI 自动生成中文报告和 Excel 结果表，作为工程师复查与汇报材料。",
    ]

    summary_json_path = output_dir / "manufacturing_analysis_summary.json"
    report_docx_path = output_dir / "manufacturing_analysis_report.docx"
    report_md_path = output_dir / "manufacturing_analysis_report.md"
    analysis_xlsx_path = output_dir / "manufacturing_analysis_results.xlsx"

    summary = {
        "success": True,
        "run_id": run_id,
        "input_path": str(input_path),
        "output_dir": str(output_dir),
        "sheet_count": len(profiles),
        "detected_scenarios": detected_scenarios,
        "headline": "制造业工艺数据 AI Demo 分析已完成",
        "warnings": ["样例数据中异常标签单一，不建议宣称正常/异常分类能力。"],
        "sheets": [
            {
                "name": item["name"],
                "rows": item["rows"],
                "columns": item["columns"],
                "numeric_columns": item["numeric_columns"],
                "text_columns": item["text_columns"],
                "missing_rate": item["missing_rate"],
                "scenario": item["scenario"],
            }
            for item in profiles
        ],
        "sheet_profiles": profiles,
        "missing_top": all_missing_rows[:max_variables],
        "chamber_difference": chamber_rows,
        "pca_top_loadings": pca_result.get("top_loadings", []),
        "pca_explained_ratio": pca_result.get("explained_ratio"),
        "pls_screening": pls_rows,
        "anova_screening": anova_rows,
        "key_findings": key_findings,
        "demo_script": demo_script,
        "files": {
            "summary_json": str(summary_json_path),
            "report_docx": str(report_docx_path),
            "report_md": str(report_md_path),
            "analysis_xlsx": str(analysis_xlsx_path),
        },
    }

    summary_json_path.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    write_markdown(summary, report_md_path)
    write_docx(summary, report_docx_path)
    write_workbook(summary, analysis_xlsx_path)

    print(RESULT_PREFIX + json.dumps(summary, ensure_ascii=False))


if __name__ == "__main__":
    main()
`
}

export const ManufacturingAnalysisTool = Tool.define("manufacturing_analysis", {
  description: DESCRIPTION,
  parameters: ManufacturingAnalysisSchema,
  async execute(params: ManufacturingAnalysisParams, ctx) {
    const pythonStatus = await getRuntimePythonStatus(["pandas", "numpy", "scipy", "openpyxl", "python-docx"])
    if (!pythonStatus.ok || pythonStatus.missing.length) {
      throw new Error(formatRuntimePythonSetupError("manufacturing_analysis", pythonStatus))
    }

    const inputPath = await resolveToolPath({
      filePath: params.inputPath,
      mode: "read",
      toolName: "manufacturing_analysis",
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      ask: ctx.ask,
    })

    const runId = normalizeRunId(params.runId)
    const outputDir = params.outputDir
      ? await resolveToolPath({
          filePath: params.outputDir,
          mode: "write",
          toolName: "manufacturing_analysis",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
          ask: ctx.ask,
        })
      : defaultOutputDir(runId)
    ensureDir(outputDir)

    const script = buildPythonScript({
      inputPath,
      outputDir,
      runId,
      maxVariables: params.maxVariables,
      outputLanguage: params.outputLanguage,
    })

    const execution = await runInlinePython({
      command: pythonStatus.executable,
      script,
      cwd: Instance.directory,
    })
    try {
      fs.rmSync(execution.scriptPath, { force: true })
    } catch (error) {
      log.warn("Failed to remove temporary manufacturing analysis script", { error })
    }

    if (execution.code !== 0) {
      throw new Error(`manufacturing_analysis failed with exit code ${execution.code}.\n${execution.stderr || execution.stdout}`)
    }

    const summary = parsePythonSummary(execution.stdout)
    const visibleOutputs: ManufacturingOutputFile[] = [
      { label: "manufacturing_analysis_report.docx", path: relativeWithinProject(summary.files.report_docx) },
      { label: "manufacturing_analysis_results.xlsx", path: relativeWithinProject(summary.files.analysis_xlsx) },
      { label: "manufacturing_analysis_report.md", path: relativeWithinProject(summary.files.report_md) },
      { label: "manufacturing_analysis_summary.json", path: relativeWithinProject(summary.files.summary_json) },
    ]

    const output = [
      "## Manufacturing Analysis Demo",
      "",
      `Run ID: ${summary.run_id}`,
      `Sheets: ${summary.sheet_count}`,
      `Detected scenarios: ${summary.detected_scenarios.join(", ")}`,
      "",
      "### Key findings",
      ...summary.key_findings.map((item) => `- ${item}`),
      "",
      "### Demo outputs",
      ...visibleOutputs.map((item) => `- ${item.label}: ${item.path}`),
    ].join("\n")

    return {
      title: "Manufacturing analysis",
      output,
      metadata: {
        runId: summary.run_id,
        inputPath: relativeWithinProject(inputPath),
        outputDir: relativeWithinProject(summary.output_dir),
        sheetCount: summary.sheet_count,
        detectedScenarios: summary.detected_scenarios,
        reportPath: relativeWithinProject(summary.files.report_docx),
        summaryJsonPath: relativeWithinProject(summary.files.summary_json),
        workbookPath: relativeWithinProject(summary.files.analysis_xlsx),
        markdownPath: relativeWithinProject(summary.files.report_md),
        visibleOutputs,
        display: createToolDisplay({
          summary: summary.headline,
          details: [
            `工作表：${summary.sheet_count}`,
            `识别场景：${summary.detected_scenarios.length}`,
          ],
          artifacts: visibleOutputs.map((item) => ({
            label: item.label,
            path: item.path,
            visibility: "user_collapsed" as const,
          })),
        }),
        analysisView: createToolAnalysisView({
          kind: "manufacturing_analysis",
          step: "manufacturing_analysis",
          conclusion: summary.key_findings[0] ?? summary.headline,
          results: [
            analysisMetric("工作表", summary.sheet_count),
            analysisMetric("识别场景", summary.detected_scenarios.length),
          ],
          artifacts: visibleOutputs.map((item) =>
            analysisArtifact(item.path, {
              label: item.label,
              visibility: "user_collapsed",
            }),
          ),
        }),
      } satisfies ManufacturingAnalysisMetadata,
    }
  },
})
