import * as fs from "fs"
import * as path from "path"
import { spawn } from "child_process"
import z from "zod"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { Tool } from "./tool"
import {
  finalOutputsPath,
  inferRunId,
  projectErrorsRoot,
  projectTempRoot,
  publishVisibleOutput,
  readDatasetManifest,
  resolveFinalOutputsPath,
} from "./analysis-state"
import { relativeWithinProject, resolveToolPath } from "./analysis-path"
import type { Tool as ToolNamespace } from "./tool"

const log = Log.create({ service: "regression-table-tool" })
const PYTHON_RESULT_PREFIX = "__KILLSTATA_JSON__"
const PYTHON_CMD = process.env.KILLSTATA_PYTHON ?? (process.platform === "win32" ? "python" : "python3")

const TABLE_FORMATS = ["markdown", "latex", "xlsx"] as const
type TableFormat = (typeof TABLE_FORMATS)[number]

export type RegressionTableResult = {
  success: boolean
  error?: string
  traceback?: string
  error_log_path?: string
  output_dir?: string
  markdown_path?: string
  latex_path?: string
  workbook_path?: string
  dataset_id?: string
  run_id?: string
  branch?: string
  model_count?: number
  row_count?: number
}

export const RegressionTableInputSchema = z.object({
  title: z.string().describe("Table title, e.g. 表1: 双重差分估计结果"),
  modelDirs: z.array(z.string()).min(1).describe("Regression result directories or result files to combine"),
  columnLabels: z.array(z.string()).optional().describe("Top header labels, e.g. (1), (2), (3)"),
  columnSubtitles: z.array(z.string()).optional().describe("Second header labels, e.g. 基准回归, 控制宏观"),
  variables: z.array(z.string()).optional().describe("Coefficient order to display; defaults to treatment + covariates"),
  variableLabels: z.record(z.string(), z.string()).optional().describe("Map raw variable names to paper-friendly labels"),
  notes: z.string().optional().describe("Custom table notes"),
  formats: z.array(z.enum(TABLE_FORMATS)).optional().describe("Output formats; defaults to markdown, latex, xlsx"),
  outputDir: z.string().optional().describe("Optional output directory for generated tables"),
  branch: z.string().optional().describe("Visible output branch label when publishing table artifacts"),
  runId: z.string().optional().describe("Optional run id for visible output publishing"),
})

type RegressionTableInput = z.infer<typeof RegressionTableInputSchema>

function encodePythonPayload(payload: unknown) {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64")
}

function parsePythonResult<T>(stdout: string, prefix = PYTHON_RESULT_PREFIX): T {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const line = lines[idx]
    if (!line.startsWith(prefix)) continue
    return JSON.parse(line.slice(prefix.length)) as T
  }

  const trimmed = stdout.trim()
  if (trimmed) return JSON.parse(trimmed) as T
  throw new Error("Python produced no parseable regression table output")
}

async function runInlinePython(input: { script: string; cwd: string }) {
  const tempDir = projectTempRoot()
  fs.mkdirSync(tempDir, { recursive: true })
  const tempScriptPath = path.join(tempDir, `regression_table_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`)
  fs.writeFileSync(tempScriptPath, input.script, "utf-8")

  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(PYTHON_CMD, [tempScriptPath], {
      cwd: input.cwd,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    })

    let stdout = ""
    let stderr = ""

    proc.stdout?.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    proc.on("error", (error) => {
      fs.rmSync(tempScriptPath, { force: true })
      reject(error)
    })
    proc.on("close", (code) => {
      fs.rmSync(tempScriptPath, { force: true })
      resolve({ code, stdout, stderr })
    })
  })
}

function defaultOutputDir(firstModelPath: string) {
  const resolved = path.isAbsolute(firstModelPath) ? firstModelPath : path.join(Instance.directory, firstModelPath)
  const modelDir = fs.existsSync(resolved) && fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved)
  return path.join(modelDir, "academic_table")
}

export async function generateRegressionTable(
  input: RegressionTableInput,
  ctx?: Pick<ToolNamespace.Context, "sessionID" | "messageID" | "callID">,
) {
  const resolvedModelDirs = ctx
    ? await Promise.all(
        input.modelDirs.map((item) =>
          resolveToolPath({
            filePath: item,
            mode: "read",
            toolName: "regression_table",
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            callID: ctx.callID,
          }),
        ),
      )
    : input.modelDirs.map((item) => (path.isAbsolute(item) ? item : path.join(Instance.directory, item)))
  const outputDir = input.outputDir
    ? ctx
      ? await resolveToolPath({
          filePath: input.outputDir,
          mode: "write",
          toolName: "regression_table",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
        })
      : path.isAbsolute(input.outputDir)
        ? input.outputDir
        : path.join(Instance.directory, input.outputDir)
    : defaultOutputDir(resolvedModelDirs[0]!)
  fs.mkdirSync(outputDir, { recursive: true })

  const payload = {
    title: input.title,
    model_dirs: resolvedModelDirs,
    column_labels: input.columnLabels ?? [],
    column_subtitles: input.columnSubtitles ?? [],
    variables: input.variables ?? [],
    variable_labels: input.variableLabels ?? {},
    notes: input.notes ?? null,
    formats: input.formats ?? ["markdown", "latex", "xlsx"],
    output_dir: outputDir,
  }

  const payloadB64 = encodePythonPayload(payload)
  const pythonScript = `
import base64
import json
from datetime import datetime
from pathlib import Path
import traceback

import pandas as pd

RESULT_PREFIX = "${PYTHON_RESULT_PREFIX}"
ERRORS_DIR = r"${projectErrorsRoot().replace(/\\/g, "\\\\")}"

def emit(result):
    print(f"{RESULT_PREFIX}{json.dumps(result, ensure_ascii=False)}")

def save_json(file_path, payload):
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

def safe_error_path():
    error_dir = Path(ERRORS_DIR)
    error_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    return str(error_dir / f"regression_table_{stamp}_error.json")

def resolve_model_dir(value):
    candidate = Path(value)
    if candidate.is_dir():
        return candidate
    return candidate.parent

def load_json(file_path):
    if not file_path.exists():
        return {}
    with open(file_path, "r", encoding="utf-8") as f:
        return json.load(f)

def stars(p_value):
    if p_value is None:
        return ""
    if p_value < 0.01:
        return "***"
    if p_value < 0.05:
        return "**"
    if p_value < 0.1:
        return "*"
    return ""

def fmt_coef(value, p_value):
    if value is None or pd.isna(value):
        return ""
    return f"{float(value):.3f}{stars(p_value)}"

def fmt_se(value):
    if value is None or pd.isna(value):
        return ""
    return f"({float(value):.3f})"

def yes_no(flag):
    return "Yes" if flag else "No"

def build_default_note(models):
    cluster_vars = [item.get("metadata", {}).get("cluster_var") for item in models if item.get("metadata", {}).get("cluster_var")]
    cluster_text = f"按{cluster_vars[0]}聚类稳健标准误" if cluster_vars else "稳健标准误"
    return f"注：括号内为{cluster_text}。*p<0.1, **p<0.05, ***p<0.01"

def load_model(model_dir):
    coefficients_path = model_dir / "coefficient_table.csv"
    if not coefficients_path.exists():
      raise FileNotFoundError(f"Missing coefficient_table.csv in {model_dir}")
    coefficients = pd.read_csv(coefficients_path)
    metadata = load_json(model_dir / "model_metadata.json")
    result = load_json(model_dir / "results.json")
    return {
        "dir": str(model_dir),
        "coefficients": coefficients,
        "metadata": metadata,
        "result": result,
        "dataset_id": result.get("dataset_id"),
        "branch": result.get("branch"),
    }

def build_variable_order(models, explicit_variables):
    if explicit_variables:
        return explicit_variables
    ordered = []
    for model in models:
        metadata = model.get("metadata", {})
        for variable in [metadata.get("treatment_var"), *(metadata.get("covariates") or [])]:
            if variable and variable not in ordered:
                ordered.append(variable)
    return ordered

def model_lookup(model, variable):
    coefficients = model["coefficients"]
    if "term" not in coefficients.columns:
        return None
    matches = coefficients.loc[coefficients["term"] == variable]
    if matches.empty:
        return None
    row = matches.iloc[0]
    return {
        "coefficient": row.get("coefficient"),
        "std_error": row.get("std_error"),
        "p_value": row.get("p_value"),
    }

def build_rows(models, variables, variable_labels):
    rows = []
    for variable in variables:
        label = variable_labels.get(variable, variable)
        coef_row = [label]
        se_row = [""]
        for model in models:
            entry = model_lookup(model, variable)
            if entry is None:
                coef_row.append("")
                se_row.append("")
            else:
                coef_row.append(fmt_coef(entry["coefficient"], entry["p_value"]))
                se_row.append(fmt_se(entry["std_error"]))
        rows.append(coef_row)
        rows.append(se_row)

    def stat_row(label, values):
        rows.append([label, *values])
    stat_row("控制变量", [yes_no(bool((model.get("metadata", {}).get("covariates") or []))) for model in models])
    stat_row("个体固定效应", [yes_no(bool(model.get("metadata", {}).get("entity_var"))) for model in models])
    stat_row("时间固定效应", [yes_no(bool(model.get("metadata", {}).get("time_var"))) for model in models])
    stat_row("N", [f"{int(model.get('metadata', {}).get('rows_used', 0)):,}" if model.get("metadata", {}).get("rows_used") is not None else "" for model in models])
    stat_row("R-squared", [f"{float(model.get('result', {}).get('r_squared')):.3f}" if model.get("result", {}).get("r_squared") is not None else "" for model in models])
    return rows

def markdown_table(title, header, subheader, rows, notes):
    lines = [f"# {title}", ""]
    lines.append("| " + " | ".join(header) + " |")
    lines.append("|" + "|".join(["---"] * len(header)) + "|")
    if subheader:
        lines.append("| " + " | ".join(subheader) + " |")
    for row in rows:
        lines.append("| " + " | ".join(row) + " |")
    lines.extend(["", notes])
    return "\\n".join(lines)

def latex_table(title, header, subheader, rows, notes):
    cols = "l" + "c" * (len(header) - 1)
    lines = [
        "\\\\begin{table}[htbp]",
        "\\\\centering",
        f"\\\\caption{{{title}}}",
        f"\\\\begin{{tabular}}{{{cols}}}",
        "\\\\toprule",
        " & ".join(header) + " \\\\\\\\",
    ]
    if subheader:
        lines.append(" & ".join(subheader) + " \\\\\\\\")
    lines.append("\\\\midrule")
    for row in rows:
        lines.append(" & ".join(row) + " \\\\\\\\")
    lines.extend([
        "\\\\bottomrule",
        "\\\\end{tabular}",
        "{\\footnotesize " + notes + "}",
        "\\\\end{table}",
    ])
    return "\\n".join(lines)

payload = json.loads(base64.b64decode("${payloadB64}").decode("utf-8"))

try:
    model_dirs = [resolve_model_dir(item) for item in payload["model_dirs"]]
    models = [load_model(item) for item in model_dirs]
    if not models:
        raise ValueError("No model directories provided")

    variable_labels = payload.get("variable_labels") or {}
    variables = build_variable_order(models, payload.get("variables") or [])
    if not variables:
        raise ValueError("No coefficients available to render in the regression table")

    labels = payload.get("column_labels") or []
    if labels and len(labels) != len(models):
        raise ValueError("column_labels length must match number of models")
    if not labels:
        labels = [f"({idx + 1})" for idx in range(len(models))]

    subtitles = payload.get("column_subtitles") or []
    if subtitles and len(subtitles) != len(models):
        raise ValueError("column_subtitles length must match number of models")

    header = ["", *labels]
    subheader = ["", *subtitles] if subtitles else []
    rows = build_rows(models, variables, variable_labels)
    notes = payload.get("notes") or build_default_note(models)

    output_dir = Path(payload["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)

    markdown_path = None
    latex_path = None
    workbook_path = None

    if "markdown" in payload.get("formats", []):
        markdown_path = output_dir / "three_line_table.md"
        markdown_path.write_text(markdown_table(payload["title"], header, subheader, rows, notes), encoding="utf-8")

    if "latex" in payload.get("formats", []):
        latex_path = output_dir / "three_line_table.tex"
        latex_path.write_text(latex_table(payload["title"], header, subheader, rows, notes), encoding="utf-8")

    if "xlsx" in payload.get("formats", []):
        workbook_path = output_dir / "three_line_table.xlsx"
        workbook_rows = [[payload["title"]], [], header]
        if subheader:
            workbook_rows.append(subheader)
        workbook_rows.extend(rows)
        workbook_rows.extend([[], [notes]])
        table_df = pd.DataFrame(workbook_rows)
        with pd.ExcelWriter(workbook_path, engine="openpyxl") as writer:
            table_df.to_excel(writer, sheet_name="table", index=False, header=False)

    emit({
        "success": True,
        "output_dir": str(output_dir),
        "markdown_path": str(markdown_path) if markdown_path else None,
        "latex_path": str(latex_path) if latex_path else None,
        "workbook_path": str(workbook_path) if workbook_path else None,
        "dataset_id": models[0].get("dataset_id"),
        "branch": models[0].get("branch"),
        "model_count": len(models),
        "row_count": len(rows),
    })
except Exception as e:
    result = {
        "success": False,
        "error": str(e),
        "traceback": traceback.format_exc(),
    }
    error_path = safe_error_path()
    result["error_log_path"] = error_path
    save_json(error_path, result)
    emit(result)
`

  log.info("generate regression table", { outputDir, modelDirs: resolvedModelDirs })
  const { code, stdout, stderr } = await runInlinePython({
    script: pythonScript,
    cwd: Instance.directory,
  })

  if (code !== 0) {
    throw new Error(`Regression table generator failed (exit code ${code})\n${stderr}\n${stdout}`)
  }

  return parsePythonResult<RegressionTableResult>(stdout)
}

export const RegressionTableTool = Tool.define("regression_table", async () => ({
  description:
    "Generate academic three-line regression tables from one or more econometrics result directories. Outputs Markdown, LaTeX, and Excel files suitable for papers.",
  parameters: RegressionTableInputSchema,
  async execute(params, ctx) {
    const result = await generateRegressionTable(params, ctx)
    if (!result.success) {
      let message = `Regression table generation failed: ${result.error ?? "unknown error"}`
      if (result.error_log_path) message += `\nError log: ${relativeWithinProject(result.error_log_path)}`
      if (result.traceback) message += `\n${result.traceback}`
      throw new Error(message)
    }

    const visibleOutputs: Array<{ label: string; relativePath: string }> = []
    if (result.dataset_id) {
      try {
        const manifest = readDatasetManifest(result.dataset_id)
        const runId = inferRunId({ requestedRunId: params.runId ?? result.run_id })
        const branch = params.branch ?? result.branch ?? "tables"
        const publish = (key: string, label: string, sourcePath?: string) => {
          if (!sourcePath) return
          const visiblePath = publishVisibleOutput({
            manifest,
            key,
            label,
            sourcePath,
            runId,
            branch,
            metadata: { title: params.title, modelCount: result.model_count },
          })
          visibleOutputs.push({ label, relativePath: relativeWithinProject(visiblePath) })
        }
        publish("regression_table_markdown", "regression_table_markdown", result.markdown_path)
        publish("regression_table_latex", "regression_table_latex", result.latex_path)
        publish("regression_table_xlsx", "regression_table_workbook", result.workbook_path)
      } catch {}
    }

    const manifestPath = result.dataset_id
      ? (() => {
          try {
            const manifest = readDatasetManifest(result.dataset_id)
            return params.runId ? finalOutputsPath(manifest.sourcePath, params.runId) : resolveFinalOutputsPath(manifest.sourcePath)
          } catch {
            return undefined
          }
        })()
      : undefined

    let output = `## Regression Table Generated\n\n`
    output += `Title: ${params.title}\n`
    output += `Models: ${result.model_count ?? params.modelDirs.length}\n`
    if (result.markdown_path) output += `- Markdown: ${relativeWithinProject(result.markdown_path)}\n`
    if (result.latex_path) output += `- LaTeX: ${relativeWithinProject(result.latex_path)}\n`
    if (result.workbook_path) output += `- Excel: ${relativeWithinProject(result.workbook_path)}\n`
    if (visibleOutputs.length) {
      output += `\nVisible outputs:\n`
      for (const item of visibleOutputs) output += `- ${item.label}: ${item.relativePath}\n`
    }
    if (manifestPath) output += `Final outputs manifest: ${relativeWithinProject(manifestPath)}\n`

    return {
      title: "Regression Table",
      output,
      metadata: {
        result,
        visibleOutputs,
        finalOutputsPath: manifestPath ? relativeWithinProject(manifestPath) : undefined,
      },
    }
  },
}))
