import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { spawn, exec } from "child_process"
import DESCRIPTION from "./econometrics.txt"
import { Instance } from "../project/instance"
import * as os from "os"
import { Log } from "../util/log"
import { Tool } from "./tool"
import { Question } from "../question"
import {
  buildFileStamp,
  appendArtifact,
  finalOutputsPath,
  inferRunId,
  projectErrorsRoot,
  projectTempRoot,
  publishVisibleOutput,
  reportOutputPath,
  resolveArtifactInput,
} from "./analysis-state"
import { classifyToolFailure, persistToolReflection } from "./analysis-reflection"
import { AnalysisIntent } from "./analysis-intent"
import {
  createEconometricsNumericSnapshot,
  type NumericSnapshotDocument,
  snapshotPreview,
} from "./analysis-grounding"
import { generateRegressionTable } from "./regression-table"

const log = Log.create({ service: "econometrics-tool" })

// Python环境路径配置
let PYTHON_CMD = process.env.KILLSTATA_PYTHON
if (!PYTHON_CMD) {
  const configFile = path.join(os.homedir(), ".killstata", "config.json")
  if (fs.existsSync(configFile)) {
    try {
      const config = JSON.parse(fs.readFileSync(configFile, "utf-8"))
      if (config.python_executable) PYTHON_CMD = config.python_executable
    } catch (e) {}
  }
}
PYTHON_CMD = PYTHON_CMD ?? (process.platform === "win32" ? "python" : "python3")

const ECONOMETRICS_DIR = path.join(__dirname, "../../python/econometrics")
const PYTHON_RESULT_PREFIX = "__KILLSTATA_JSON__"

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
  throw new Error("Python produced no parseable output")
}

async function runInlinePython(input: { command: string; script: string; cwd: string }) {
  const tempDir = projectTempRoot()
  fs.mkdirSync(tempDir, { recursive: true })
  const tempScriptPath = path.join(tempDir, `econometrics_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`)
  fs.writeFileSync(tempScriptPath, input.script, "utf-8")

  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const proc = spawn(input.command, [tempScriptPath], {
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

const SUPPORTED_METHODS = [
  "ols_regression",
  "panel_fe_regression",
  "baseline_regression",
  "psm_construction",
  "psm_matching",
  "psm_ipw",
  "psm_regression",
  "psm_double_robust",
  "psm_dr_ipw_ra",
  "psm_visualize",
  "iv_2sls",
  "iv_test",
  "did_static",
  "did_staggered",
  "did_event_study",
  "did_event_study_viz",
  "rdd_sharp",
  "rdd_fuzzy",
  "rdd_fuzzy_global",
] as const

type MethodName = (typeof SUPPORTED_METHODS)[number]

const MethodSchema = z.enum(SUPPORTED_METHODS)

const METHOD_REQUIRED_OPTIONS: Partial<Record<MethodName, string[]>> = {
  iv_2sls: ["iv_variable"],
  iv_test: ["iv_variable"],
  did_static: ["treatment_entity_dummy", "treatment_finished_dummy"],
  did_staggered: ["treatment_entity_dummy", "treatment_finished_dummy"],
  did_event_study: ["treatment_entity_dummy", "treatment_finished_dummy", "relative_time_variable"],
  did_event_study_viz: ["treatment_entity_dummy", "treatment_finished_dummy", "relative_time_variable"],
  rdd_sharp: ["running_variable"],
  rdd_fuzzy: ["running_variable"],
  rdd_fuzzy_global: ["running_variable"],
}

const METHOD_NEEDS_TREATMENT = new Set<MethodName>([
  "ols_regression",
  "panel_fe_regression",
  "baseline_regression",
  "psm_construction",
  "psm_matching",
  "psm_ipw",
  "psm_regression",
  "psm_double_robust",
  "psm_dr_ipw_ra",
  "psm_visualize",
  "iv_2sls",
  "iv_test",
  "rdd_sharp",
  "rdd_fuzzy",
  "rdd_fuzzy_global",
])

type PythonResult = {
  success: boolean
  error?: string
  traceback?: string
  error_log_path?: string
  method?: string
  coefficient?: number
  std_error?: number
  p_value?: number
  r_squared?: number
  ate?: number
  att?: number
  late?: number
  plot_path?: string
  output_path?: string
  coefficients_path?: string
  workbook_path?: string
  diagnostics_path?: string
  metadata_path?: string
  narrative_path?: string
  numeric_snapshot_path?: string
  qa_status?: string
  warnings?: string[]
  blocking_errors?: string[]
  suggested_repairs?: string[]
  backend?: string
  dropped_rows?: number
  cluster_var?: string
  test_results?: unknown
  dataset_id?: string
  stage_id?: string
  run_id?: string
  branch?: string
  academic_table_markdown_path?: string
  academic_table_latex_path?: string
  academic_table_workbook_path?: string
}

function resolveWithinProject(filePath: string) {
  if (path.isAbsolute(filePath)) return filePath
  return path.join(Instance.directory, filePath)
}

function relativeWithinProject(filePath: string) {
  return path.relative(Instance.directory, filePath)
}

function validateMethodOptions(params: {
  methodName: MethodName
  treatmentVar?: string
  options?: Record<string, unknown>
  entityVar?: string
  timeVar?: string
}) {
  if (METHOD_NEEDS_TREATMENT.has(params.methodName) && !params.treatmentVar) {
    throw new Error(`Method ${params.methodName} requires treatmentVar`)
  }

  if ((params.methodName === "panel_fe_regression" || params.methodName === "baseline_regression") && (!params.entityVar || !params.timeVar)) {
    throw new Error(`Method ${params.methodName} requires entityVar and timeVar`)
  }

  const required = METHOD_REQUIRED_OPTIONS[params.methodName] ?? []
  const missing = required.filter((key) => params.options?.[key] === undefined)
  if (missing.length) {
    throw new Error(`Method ${params.methodName} requires options: ${missing.join(", ")}`)
  }
}

function significanceStars(pValue: number | undefined) {
  if (pValue === undefined) return ""
  if (pValue < 0.01) return "***"
  if (pValue < 0.05) return "**"
  if (pValue < 0.1) return "*"
  return ""
}

function buildPanelFePythonScript(payloadB64: string) {
  return `
import base64
import json
import traceback
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

RESULT_PREFIX = "${PYTHON_RESULT_PREFIX}"
PROJECT_DIR = r"${Instance.directory.replace(/\\/g, "\\\\")}"
ERRORS_DIR = r"${projectErrorsRoot().replace(/\\/g, "\\\\")}"

def emit(result):
    print(f"{RESULT_PREFIX}{json.dumps(result, ensure_ascii=False)}")

def save_json(file_path, payload):
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

def safe_error_path(method_name):
    error_dir = Path(ERRORS_DIR)
    error_dir.mkdir(parents=True, exist_ok=True)
    from datetime import datetime
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    return str(error_dir / f"econometrics_{method_name}_{stamp}_error.json")

def read_table(file_path):
    suffix = Path(file_path).suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(file_path)
    if suffix in [".xlsx", ".xls"]:
        return pd.read_excel(file_path)
    if suffix == ".dta":
        return pd.read_stata(file_path, preserve_dtypes=False)
    if suffix == ".parquet":
        return pd.read_parquet(file_path)
    raise ValueError(f"Unsupported econometrics input format: {suffix}")

def build_model_qa(df, entity_var=None, time_var=None, cluster_var=None):
    warnings = []
    blocking_errors = []
    suggested_repairs = []
    duplicate_rows = 0
    cluster_count = None

    if entity_var and time_var:
        missing_keys = [item for item in [entity_var, time_var] if item not in df.columns]
        if missing_keys:
            blocking_errors.append(f"Panel identifiers not found: {missing_keys}")
        else:
            duplicate_rows = int(df.duplicated(subset=[entity_var, time_var]).sum())
            if duplicate_rows > 0:
                warnings.append(f"Found {duplicate_rows} duplicate entity-time rows")
                suggested_repairs.append("Aggregate or deduplicate entity-time rows before regression")

    if cluster_var and cluster_var in df.columns:
        cluster_count = int(df[cluster_var].nunique(dropna=True))
        if cluster_count < 10:
            warnings.append(f"Cluster count is low ({cluster_count}); clustered standard errors may be unstable")

    return {
        "warnings": warnings,
        "blocking_errors": blocking_errors,
        "suggested_repairs": suggested_repairs,
        "duplicate_entity_time_rows": duplicate_rows,
        "cluster_count": cluster_count,
    }

def vif_report(frame):
    clean = frame.dropna()
    if clean.empty or clean.shape[1] <= 1:
        return []
    matrix = np.column_stack([np.ones(len(clean)), clean.to_numpy(dtype=float)])
    result = []
    for idx, column in enumerate(clean.columns, start=1):
        target = matrix[:, idx]
        others = np.delete(matrix, idx, axis=1)
        beta = np.linalg.pinv(others.T @ others) @ (others.T @ target)
        fitted = others @ beta
        ssr = float(np.sum((target - fitted) ** 2))
        tss = float(np.sum((target - target.mean()) ** 2))
        vif_value = None if tss == 0 else float(1.0 / (1.0 - max(0.0, min(0.999999, 1 - ssr / tss))))
        result.append({"variable": column, "vif": vif_value})
    return result

def breusch_pagan(residuals, design_matrix):
    if design_matrix.shape[1] <= 1:
        return {"breusch_pagan_stat": 0.0, "breusch_pagan_pvalue": 1.0}
    target = residuals ** 2
    beta = np.linalg.pinv(design_matrix.T @ design_matrix) @ (design_matrix.T @ target)
    fitted = design_matrix @ beta
    tss = float(np.sum((target - target.mean()) ** 2))
    rss = float(np.sum((target - fitted) ** 2))
    r_squared = 0.0 if tss == 0 else max(0.0, min(0.999999, 1 - rss / tss))
    lm = len(residuals) * r_squared
    dof = max(design_matrix.shape[1] - 1, 1)
    return {
        "breusch_pagan_stat": float(lm),
        "breusch_pagan_pvalue": float(stats.chi2.sf(lm, dof)),
    }

def cluster_covariance(design_matrix, residuals, groups):
    xtx_inv = np.linalg.pinv(design_matrix.T @ design_matrix)
    meat = np.zeros((design_matrix.shape[1], design_matrix.shape[1]))
    unique_groups = np.unique(groups)
    for group in unique_groups:
        mask = groups == group
        xg = design_matrix[mask]
        ug = residuals[mask]
        score = xg.T @ ug
        meat += np.outer(score, score)
    n = design_matrix.shape[0]
    k = design_matrix.shape[1]
    g = len(unique_groups)
    correction = 1.0 if g <= 1 or n <= k else (g / (g - 1)) * ((n - 1) / (n - k))
    return correction * (xtx_inv @ meat @ xtx_inv)

def build_coefficient_table(term_names, beta, std_error, p_value, dof):
    critical = float(stats.t.ppf(0.975, dof)) if dof > 0 else 1.96
    rows = []
    for idx, term in enumerate(term_names):
        t_stat = None if std_error[idx] == 0 else float(beta[idx] / std_error[idx])
        rows.append({
            "term": term,
            "coefficient": float(beta[idx]),
            "std_error": float(std_error[idx]),
            "t_stat": t_stat,
            "p_value": float(p_value[idx]),
            "ci_lower": float(beta[idx] - critical * std_error[idx]),
            "ci_upper": float(beta[idx] + critical * std_error[idx]),
        })
    return pd.DataFrame(rows)

def adjusted_r_squared(outcome, residuals, n, k):
    tss = float(np.sum((outcome - outcome.mean()) ** 2))
    rss = float(np.sum(residuals ** 2))
    if tss == 0 or n <= k:
        return 0.0
    return float(1 - (rss / (n - k)) / (tss / (n - 1)))

payload = json.loads(base64.b64decode("${payloadB64}").decode("utf-8"))
method = payload["method"]

try:
    df = read_table(payload["data_path"])
    dependent_var = payload["dependent_var"]
    treatment_var = payload["treatment_var"]
    covariates = payload.get("covariates", [])
    entity_var = payload["entity_var"]
    time_var = payload["time_var"]
    cluster_var = payload.get("cluster_var") or entity_var

    required_columns = [dependent_var, treatment_var, entity_var, time_var] + covariates
    missing_columns = sorted(set([col for col in required_columns if col not in df.columns]))
    if missing_columns:
        raise ValueError(f"Missing columns in dataset: {missing_columns}")

    qa = build_model_qa(df, entity_var, time_var, cluster_var)
    model_columns = required_columns + ([cluster_var] if cluster_var not in required_columns else [])
    model_df = df[model_columns].copy()
    for column in [dependent_var, treatment_var, *covariates]:
        model_df[column] = pd.to_numeric(model_df[column], errors="coerce")

    rows_before = len(model_df)
    model_df = model_df.dropna(subset=[dependent_var, treatment_var, entity_var, time_var, *covariates])
    dropped_rows = int(rows_before - len(model_df))
    if dropped_rows > 0:
        qa["warnings"].append(f"Dropped {dropped_rows} rows with missing model variables")
    if model_df.empty:
        raise ValueError("No usable rows remain after dropping missing model variables")

    duplicate_rows = int(model_df.duplicated(subset=[entity_var, time_var]).sum())
    if duplicate_rows > 0:
        aggregations = {}
        for column in model_df.columns:
            if column in [entity_var, time_var]:
                continue
            if pd.api.types.is_numeric_dtype(model_df[column]):
                aggregations[column] = "mean"
            else:
                aggregations[column] = "first"
        model_df = model_df.groupby([entity_var, time_var], as_index=False).agg(aggregations)
        qa["warnings"].append(f"Aggregated {duplicate_rows} duplicate entity-time rows by panel key mean")

    main = model_df[[treatment_var, *covariates]].to_numpy(dtype=float)
    entity_dummies = pd.get_dummies(model_df[entity_var], prefix=entity_var, drop_first=True, dtype=float)
    time_dummies = pd.get_dummies(model_df[time_var], prefix=time_var, drop_first=True, dtype=float)
    term_names = ["const", treatment_var, *covariates, *entity_dummies.columns.tolist(), *time_dummies.columns.tolist()]
    matrix_parts = [np.ones((len(model_df), 1)), main]
    if not entity_dummies.empty:
        matrix_parts.append(entity_dummies.to_numpy(dtype=float))
    if not time_dummies.empty:
        matrix_parts.append(time_dummies.to_numpy(dtype=float))
    design_matrix = np.column_stack(matrix_parts)
    outcome = model_df[dependent_var].to_numpy(dtype=float)
    beta = np.linalg.pinv(design_matrix.T @ design_matrix) @ (design_matrix.T @ outcome)
    fitted = design_matrix @ beta
    residuals = outcome - fitted
    groups = pd.factorize(model_df[cluster_var])[0]
    covariance = cluster_covariance(design_matrix, residuals, groups)
    std_error = np.sqrt(np.clip(np.diag(covariance), a_min=0, a_max=None))
    dof = max(len(outcome) - design_matrix.shape[1], 1)
    t_stats = np.divide(beta, std_error, out=np.zeros_like(beta), where=std_error > 0)
    p_value = 2 * stats.t.sf(np.abs(t_stats), dof)

    coefficients = build_coefficient_table(term_names, beta, std_error, p_value, dof)
    output_dir = Path(payload["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    coefficients_path = output_dir / "coefficient_table.csv"
    workbook_path = output_dir / "coefficient_table.xlsx"
    diagnostics_path = output_dir / "diagnostics.json"
    metadata_path = output_dir / "model_metadata.json"
    narrative_path = output_dir / "narrative.md"
    output_path = output_dir / "results.json"
    summary_path = output_dir / "model_summary.txt"

    coefficients.to_csv(coefficients_path, index=False, encoding="utf-8-sig")
    with pd.ExcelWriter(workbook_path, engine="openpyxl") as writer:
        coefficients.to_excel(writer, sheet_name="coefficients", index=False)

    diagnostics = {
        "panel": {
            "entity_var": entity_var,
            "time_var": time_var,
            "cluster_var": cluster_var,
            "entity_count": int(model_df[entity_var].nunique(dropna=True)),
            "time_count": int(model_df[time_var].nunique(dropna=True)),
            "cluster_count": qa["cluster_count"],
            "duplicate_entity_time_rows": qa["duplicate_entity_time_rows"],
            "dropped_rows": dropped_rows,
        },
        "heteroskedasticity": breusch_pagan(residuals, design_matrix),
        "multicollinearity": vif_report(model_df[[treatment_var, *covariates]]),
        "residuals": {
            "mean": float(residuals.mean()),
            "std": float(residuals.std()),
            "min": float(residuals.min()),
            "max": float(residuals.max()),
        },
        "qa": {
            "warnings": qa["warnings"],
            "blocking_errors": qa["blocking_errors"],
            "suggested_repairs": qa["suggested_repairs"],
        },
    }
    metadata = {
        "method": method,
        "backend": "numpy_fe_cluster",
        "covariance": "cluster",
        "dependent_var": dependent_var,
        "treatment_var": treatment_var,
        "covariates": covariates,
        "entity_var": entity_var,
        "time_var": time_var,
        "cluster_var": cluster_var,
        "rows_used": int(len(model_df)),
        "rows_dropped": dropped_rows,
        "term_names": term_names,
    }
    treatment_idx = term_names.index(treatment_var)
    result = {
        "success": True,
        "method": "Panel FE",
        "dataset_id": payload.get("dataset_id"),
        "stage_id": payload.get("stage_id"),
        "branch": payload.get("branch"),
        "coefficient": float(beta[treatment_idx]),
        "std_error": float(std_error[treatment_idx]),
        "p_value": float(p_value[treatment_idx]),
        "r_squared": adjusted_r_squared(outcome, residuals, len(outcome), design_matrix.shape[1]),
        "output_path": str(output_path),
        "coefficients_path": str(coefficients_path),
        "workbook_path": str(workbook_path),
        "diagnostics_path": str(diagnostics_path),
        "metadata_path": str(metadata_path),
        "narrative_path": str(narrative_path),
        "qa_status": "warn" if qa["warnings"] else "pass",
        "warnings": qa["warnings"],
        "blocking_errors": qa["blocking_errors"],
        "suggested_repairs": qa["suggested_repairs"],
        "backend": "numpy_fe_cluster",
        "dropped_rows": dropped_rows,
        "cluster_var": cluster_var,
    }

    save_json(output_path, result)
    save_json(diagnostics_path, diagnostics)
    save_json(metadata_path, metadata)
    with open(summary_path, "w", encoding="utf-8") as f:
        f.write(coefficients.to_string(index=False))
    with open(narrative_path, "w", encoding="utf-8") as f:
        f.write("# Panel FE Regression Summary\\\\n\\\\n")
        f.write(f"- Dependent variable: {dependent_var}\\\\n")
        f.write(f"- Key regressor: {treatment_var}\\\\n")
        f.write(f"- Controls: {covariates}\\\\n")
        f.write(f"- Fixed effects: {entity_var}, {time_var}\\\\n")
        f.write(f"- Clustered SE: {cluster_var}\\\\n")
        f.write(f"- Coefficient: {result['coefficient']:.6f}\\\\n")
        f.write(f"- Std. error: {result['std_error']:.6f}\\\\n")
        f.write(f"- P-value: {result['p_value']:.6f}\\\\n")
        f.write(f"- Adjusted R-squared: {result['r_squared']:.6f}\\\\n")
    emit(result)

except Exception as e:
    result = {
        "success": False,
        "error": str(e),
        "traceback": traceback.format_exc(),
    }
    error_path = safe_error_path(method)
    result["error_log_path"] = error_path
    save_json(error_path, result)
    emit(result)
`
}

export const EconometricsTool = Tool.define("econometrics", async () => ({
  description: DESCRIPTION,
  parameters: z.object({
    methodName: MethodSchema,
    dataPath: z.string().optional(),
    datasetId: z.string().optional(),
    stageId: z.string().optional(),
    runId: z.string().optional(),
    branch: z.string().optional(),
    dependentVar: z.string(),
    treatmentVar: z.string().optional(),
    covariates: z.array(z.string()).optional(),
    entityVar: z.string().optional(),
    timeVar: z.string().optional(),
    clusterVar: z.string().optional(),
    options: z.object({}).passthrough().optional(),
    outputDir: z.string().optional(),
  }),
  async execute(params, ctx) {
    if (ctx.agent === "analyst") {
      const analystState = AnalysisIntent.getAnalyst(ctx.sessionID)
      if (!analystState.asked) {
        const answers = await Question.ask({
          sessionID: ctx.sessionID,
          questions: [
            {
              header: "Analysis Plan",
              question: "Before I run the econometric analysis, do you want me to list a plan first and then execute it?",
              custom: false,
              options: [
                { label: "Yes", description: "List a concise econometric plan first, then execute" },
                { label: "No", description: "Skip the plan and run the analysis directly" },
              ],
            },
          ],
          tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
        })

        const preference = answers[0]?.[0] === "Yes" ? "plan_first" : "direct"
        AnalysisIntent.setAnalyst(ctx.sessionID, {
          asked: true,
          preference,
          blockedOnce: preference === "plan_first" ? false : true,
        })
      }

      const refreshed = AnalysisIntent.getAnalyst(ctx.sessionID)
      if (refreshed.preference === "plan_first" && refreshed.blockedOnce === false) {
        AnalysisIntent.setAnalyst(ctx.sessionID, {
          ...refreshed,
          blockedOnce: true,
        })
        throw new Error("User requested a plan first. Present a concise econometric plan, then retry the econometrics step.")
      }
    }

    validateMethodOptions({
      methodName: params.methodName,
      treatmentVar: params.treatmentVar,
      options: params.options,
      entityVar: params.entityVar,
      timeVar: params.timeVar,
    })

    const artifactInput = resolveArtifactInput({
      datasetId: params.datasetId,
      stageId: params.stageId,
      inputPath: params.dataPath ? resolveWithinProject(params.dataPath) : undefined,
    })
    const dataPath = artifactInput.resolvedInputPath
    if (!dataPath) {
      throw new Error("Econometrics requires dataPath or datasetId/stageId")
    }
    if (!fs.existsSync(dataPath)) {
      throw new Error(`Data file not found: ${dataPath}`)
    }

    const datasetManifest = artifactInput.manifest
    const sourceStage = artifactInput.stage
    const branch = params.branch ?? sourceStage?.branch ?? "main"
    const runId = inferRunId({
      requestedRunId: params.runId,
      stage: sourceStage,
    })
    const outputStamp = buildFileStamp()
    const outputDir = params.outputDir
      ? resolveWithinProject(params.outputDir)
      : datasetManifest
        ? reportOutputPath({
          datasetId: datasetManifest.datasetId,
          action: params.methodName,
          stageId: params.stageId ?? sourceStage?.stageId,
          branch,
          format: "json",
          stamp: outputStamp,
        }).replace(/\.json$/, "")
      : path.join(Instance.directory, "analysis", params.methodName)
    fs.mkdirSync(outputDir, { recursive: true })

    await ctx.ask({
      permission: "bash",
      patterns: [`${PYTHON_CMD} *econometrics*`],
      always: [`${PYTHON_CMD}*`],
      metadata: {
        description: `Run econometric method: ${params.methodName}`,
      },
    })

    const payload = {
      method: params.methodName,
      data_path: dataPath,
      dependent_var: params.dependentVar,
      treatment_var: params.treatmentVar ?? null,
      covariates: params.covariates ?? [],
      entity_var: params.entityVar ?? null,
      time_var: params.timeVar ?? null,
      cluster_var: params.clusterVar ?? params.entityVar ?? null,
      dataset_id: datasetManifest?.datasetId ?? params.datasetId ?? null,
      stage_id: params.stageId ?? sourceStage?.stageId ?? null,
      run_id: runId,
      branch,
      options: params.options ?? {},
      output_dir: outputDir,
      install_command: `${PYTHON_CMD} -m pip install pandas statsmodels linearmodels openpyxl scipy matplotlib pyarrow`,
    }

    const payloadB64 = encodePythonPayload(payload)

    const pythonScript = params.methodName === "panel_fe_regression" || params.methodName === "baseline_regression"
      ? buildPanelFePythonScript(payloadB64)
      : `
import base64
import json
import sys
import traceback
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

RESULT_PREFIX = "${PYTHON_RESULT_PREFIX}"
ERRORS_DIR = r"${projectErrorsRoot().replace(/\\/g, "\\\\")}"

def emit(result):
    print(f"{RESULT_PREFIX}{json.dumps(result, ensure_ascii=False)}")

sys.path.insert(0, r"${ECONOMETRICS_DIR.replace(/\\/g, "\\\\")}")

try:
    from econometric_algorithm import *
except Exception as e:
    emit({"success": False, "error": f"Failed to import econometric_algorithm: {str(e)}"})
    raise SystemExit(0)

payload = json.loads(base64.b64decode("${payloadB64}").decode("utf-8"))
method = payload["method"]
options = payload.get("options", {})

required_option_columns = {
    "iv_2sls": ["iv_variable"],
    "iv_test": ["iv_variable"],
    "did_static": ["treatment_entity_dummy", "treatment_finished_dummy"],
    "did_staggered": ["treatment_entity_dummy", "treatment_finished_dummy"],
    "did_event_study": ["treatment_entity_dummy", "treatment_finished_dummy", "relative_time_variable"],
    "did_event_study_viz": ["treatment_entity_dummy", "treatment_finished_dummy", "relative_time_variable"],
    "rdd_sharp": ["running_variable"],
    "rdd_fuzzy": ["running_variable"],
    "rdd_fuzzy_global": ["running_variable"],
}

def save_json(file_path, payload):
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

def safe_error_path(method_name):
    error_dir = Path(ERRORS_DIR)
    error_dir.mkdir(parents=True, exist_ok=True)
    from datetime import datetime
    stamp = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    return str(error_dir / f"econometrics_{method_name}_{stamp}_error.json")

def q(name):
    return 'Q("' + str(name).replace('"', '\\"') + '")'

def build_model_qa(df, entity_var=None, time_var=None, cluster_var=None):
    warnings = []
    blocking_errors = []
    suggested_repairs = []
    duplicate_rows = 0
    cluster_count = None

    if entity_var and time_var:
        missing_keys = [item for item in [entity_var, time_var] if item not in df.columns]
        if missing_keys:
            blocking_errors.append(f"Panel identifiers not found: {missing_keys}")
        else:
            duplicate_rows = int(df.duplicated(subset=[entity_var, time_var]).sum())
            if duplicate_rows > 0:
                blocking_errors.append(f"Found {duplicate_rows} duplicate entity-time rows")
                suggested_repairs.append("Deduplicate entity-time rows before regression")

    if cluster_var and cluster_var in df.columns:
        cluster_count = int(df[cluster_var].nunique(dropna=True))
        if cluster_count < 10:
            warnings.append(f"Cluster count is low ({cluster_count}); clustered standard errors may be unstable")

    return {
        "warnings": warnings,
        "blocking_errors": blocking_errors,
        "suggested_repairs": suggested_repairs,
        "duplicate_entity_time_rows": duplicate_rows,
        "cluster_count": cluster_count,
    }

def vif_report(frame):
    clean = frame.dropna()
    if clean.empty or clean.shape[1] <= 1:
        return []
    matrix = np.column_stack([np.ones(len(clean)), clean.to_numpy(dtype=float)])
    result = []
    for idx, column in enumerate(clean.columns, start=1):
        target = matrix[:, idx]
        others = np.delete(matrix, idx, axis=1)
        beta = np.linalg.pinv(others.T @ others) @ (others.T @ target)
        fitted = others @ beta
        ssr = float(np.sum((target - fitted) ** 2))
        tss = float(np.sum((target - target.mean()) ** 2))
        if tss == 0:
            vif_value = None
        else:
            r_squared = max(0.0, min(0.999999, 1 - ssr / tss))
            vif_value = float(1.0 / (1.0 - r_squared))
        result.append({"variable": column, "vif": vif_value})
    return result

def breusch_pagan(residuals, design_matrix):
    if design_matrix.shape[1] <= 1:
        return {"breusch_pagan_stat": 0.0, "breusch_pagan_pvalue": 1.0}
    target = residuals ** 2
    beta = np.linalg.pinv(design_matrix.T @ design_matrix) @ (design_matrix.T @ target)
    fitted = design_matrix @ beta
    tss = float(np.sum((target - target.mean()) ** 2))
    rss = float(np.sum((target - fitted) ** 2))
    r_squared = 0.0 if tss == 0 else max(0.0, min(0.999999, 1 - rss / tss))
    lm = len(residuals) * r_squared
    dof = max(design_matrix.shape[1] - 1, 1)
    return {
        "breusch_pagan_stat": float(lm),
        "breusch_pagan_pvalue": float(stats.chi2.sf(lm, dof)),
    }

def cluster_covariance(design_matrix, residuals, groups):
    xtx_inv = np.linalg.pinv(design_matrix.T @ design_matrix)
    meat = np.zeros((design_matrix.shape[1], design_matrix.shape[1]))
    unique_groups = np.unique(groups)
    for group in unique_groups:
        mask = groups == group
        xg = design_matrix[mask]
        ug = residuals[mask]
        score = xg.T @ ug
        meat += np.outer(score, score)
    n = design_matrix.shape[0]
    k = design_matrix.shape[1]
    g = len(unique_groups)
    correction = 1.0
    if g > 1 and n > k:
        correction = (g / (g - 1)) * ((n - 1) / (n - k))
    return correction * (xtx_inv @ meat @ xtx_inv)

def build_coefficient_table(term_names, beta, std_error, p_value, dof):
    critical = float(stats.t.ppf(0.975, dof)) if dof > 0 else 1.96
    rows = []
    for idx, term in enumerate(term_names):
        t_stat = None if std_error[idx] == 0 else float(beta[idx] / std_error[idx])
        rows.append({
            "term": term,
            "coefficient": float(beta[idx]),
            "std_error": float(std_error[idx]),
            "t_stat": t_stat,
            "p_value": float(p_value[idx]),
            "ci_lower": float(beta[idx] - critical * std_error[idx]),
            "ci_upper": float(beta[idx] + critical * std_error[idx]),
        })
    return pd.DataFrame(rows)

def design_matrix_with_fixed_effects(model_df, treatment_var, covariates, entity_var, time_var):
    main = model_df[[treatment_var, *covariates]].to_numpy(dtype=float)
    entity_dummies = pd.get_dummies(model_df[entity_var], prefix=entity_var, drop_first=True, dtype=float)
    time_dummies = pd.get_dummies(model_df[time_var], prefix=time_var, drop_first=True, dtype=float)
    intercept = np.ones((len(model_df), 1))
    matrix_parts = [intercept, main]
    term_names = ["const", treatment_var, *covariates]
    if not entity_dummies.empty:
        matrix_parts.append(entity_dummies.to_numpy(dtype=float))
        term_names.extend(entity_dummies.columns.tolist())
    if not time_dummies.empty:
        matrix_parts.append(time_dummies.to_numpy(dtype=float))
        term_names.extend(time_dummies.columns.tolist())
    return np.column_stack(matrix_parts), term_names

def adjusted_r_squared(outcome, residuals, n, k):
    tss = float(np.sum((outcome - outcome.mean()) ** 2))
    rss = float(np.sum(residuals ** 2))
    if tss == 0 or n <= k:
        return 0.0
    return float(1 - (rss / (n - k)) / (tss / (n - 1)))

def run_panel_fe(df, payload):
    dependent_var = payload["dependent_var"]
    treatment_var = payload["treatment_var"]
    covariates = payload.get("covariates", [])
    entity_var = payload["entity_var"]
    time_var = payload["time_var"]
    cluster_var = payload.get("cluster_var") or entity_var

    required_columns = [dependent_var, treatment_var, entity_var, time_var] + covariates
    missing_columns = sorted(set([col for col in required_columns if col not in df.columns]))
    if missing_columns:
        raise ValueError(f"Missing columns in dataset: {missing_columns}")

    qa = build_model_qa(df, entity_var, time_var, cluster_var)
    if qa["blocking_errors"]:
        return {
            "success": False,
            "error": "; ".join(qa["blocking_errors"]),
            "warnings": qa["warnings"],
            "blocking_errors": qa["blocking_errors"],
            "suggested_repairs": qa["suggested_repairs"],
        }

    model_columns = required_columns + ([cluster_var] if cluster_var not in required_columns else [])
    model_df = df[model_columns].copy()
    for column in [dependent_var, treatment_var, *covariates]:
        model_df[column] = pd.to_numeric(model_df[column], errors="coerce")

    rows_before = len(model_df)
    model_df = model_df.dropna(subset=[dependent_var, treatment_var, entity_var, time_var, *covariates])
    dropped_rows = int(rows_before - len(model_df))
    if dropped_rows > 0:
        qa["warnings"].append(f"Dropped {dropped_rows} rows with missing model variables")

    if model_df.empty:
        raise ValueError("No usable rows remain after dropping missing model variables")

    outcome = model_df[dependent_var].to_numpy(dtype=float)
    design_matrix, term_names = design_matrix_with_fixed_effects(model_df, treatment_var, covariates, entity_var, time_var)
    beta = np.linalg.pinv(design_matrix.T @ design_matrix) @ (design_matrix.T @ outcome)
    fitted = design_matrix @ beta
    residuals = outcome - fitted
    groups = pd.factorize(model_df[cluster_var])[0]
    covariance = cluster_covariance(design_matrix, residuals, groups)
    std_error = np.sqrt(np.clip(np.diag(covariance), a_min=0, a_max=None))
    dof = max(len(outcome) - design_matrix.shape[1], 1)
    t_stats = np.divide(beta, std_error, out=np.zeros_like(beta), where=std_error > 0)
    p_value = 2 * stats.t.sf(np.abs(t_stats), dof)

    coefficients = build_coefficient_table(term_names, beta, std_error, p_value, dof)
    coefficients_path = Path(payload["output_dir"]) / "coefficient_table.csv"
    workbook_path = Path(payload["output_dir"]) / "coefficient_table.xlsx"
    diagnostics_path = Path(payload["output_dir"]) / "diagnostics.json"
    metadata_path = Path(payload["output_dir"]) / "model_metadata.json"
    narrative_path = Path(payload["output_dir"]) / "narrative.md"
    output_path = Path(payload["output_dir"]) / "results.json"
    summary_path = Path(payload["output_dir"]) / "model_summary.txt"

    coefficients.to_csv(coefficients_path, index=False, encoding="utf-8-sig")
    with pd.ExcelWriter(workbook_path, engine="openpyxl") as writer:
        coefficients.to_excel(writer, sheet_name="coefficients", index=False)

    diagnostics = {
        "panel": {
            "entity_var": entity_var,
            "time_var": time_var,
            "cluster_var": cluster_var,
            "entity_count": int(model_df[entity_var].nunique(dropna=True)),
            "time_count": int(model_df[time_var].nunique(dropna=True)),
            "cluster_count": qa["cluster_count"],
            "duplicate_entity_time_rows": qa["duplicate_entity_time_rows"],
            "dropped_rows": dropped_rows,
        },
        "heteroskedasticity": breusch_pagan(residuals, design_matrix),
        "multicollinearity": vif_report(model_df[[treatment_var, *covariates]]),
        "residuals": {
            "mean": float(residuals.mean()),
            "std": float(residuals.std()),
            "min": float(residuals.min()),
            "max": float(residuals.max()),
        },
        "qa": {
            "warnings": qa["warnings"],
            "blocking_errors": qa["blocking_errors"],
            "suggested_repairs": qa["suggested_repairs"],
        },
    }
    metadata = {
        "method": method,
        "backend": "numpy_fe_cluster",
        "covariance": "cluster",
        "dependent_var": dependent_var,
        "treatment_var": treatment_var,
        "covariates": covariates,
        "entity_var": entity_var,
        "time_var": time_var,
        "cluster_var": cluster_var,
        "rows_used": int(len(model_df)),
        "rows_dropped": dropped_rows,
        "term_names": term_names,
    }
    treatment_idx = term_names.index(treatment_var)
    result = {
        "success": True,
        "method": "Panel FE",
        "coefficient": float(beta[treatment_idx]),
        "std_error": float(std_error[treatment_idx]),
        "p_value": float(p_value[treatment_idx]),
        "r_squared": adjusted_r_squared(outcome, residuals, len(outcome), design_matrix.shape[1]),
        "output_path": str(output_path),
        "coefficients_path": str(coefficients_path),
        "workbook_path": str(workbook_path),
        "diagnostics_path": str(diagnostics_path),
        "metadata_path": str(metadata_path),
        "narrative_path": str(narrative_path),
        "qa_status": "warn" if qa["warnings"] else "pass",
        "warnings": qa["warnings"],
        "blocking_errors": qa["blocking_errors"],
        "suggested_repairs": qa["suggested_repairs"],
        "backend": "numpy_fe_cluster",
        "dropped_rows": dropped_rows,
        "cluster_var": cluster_var,
    }

    save_json(output_path, result)
    save_json(diagnostics_path, diagnostics)
    save_json(metadata_path, metadata)
    with open(summary_path, "w", encoding="utf-8") as f:
        f.write(coefficients.to_string(index=False))
    with open(narrative_path, "w", encoding="utf-8") as f:
        f.write("# Panel FE Regression Summary\\n\\n")
        f.write(f"- Dependent variable: {dependent_var}\\n")
        f.write(f"- Key regressor: {treatment_var}\\n")
        f.write(f"- Controls: {covariates}\\n")
        f.write(f"- Fixed effects: {entity_var}, {time_var}\\n")
        f.write(f"- Clustered SE: {cluster_var}\\n")
        f.write(f"- Coefficient: {result['coefficient']:.6f}\\n")
        f.write(f"- Std. error: {result['std_error']:.6f}\\n")
        f.write(f"- P-value: {result['p_value']:.6f}\\n")
        f.write(f"- Adjusted R-squared: {result['r_squared']:.6f}\\n")
    return result

try:
    df = read_table(payload["data_path"])

    if method in ["panel_fe_regression", "baseline_regression"]:
        result = run_panel_fe(df, payload)
        if not result.get("success"):
            error_path = safe_error_path(method)
            result["error_log_path"] = error_path
            save_json(error_path, result)
        emit(result)
        raise SystemExit(0)

    try:
        from econometric_algorithm import *
    except Exception as e:
        result = {
            "success": False,
            "error": f"Failed to import econometric_algorithm: {str(e)}",
        }
        error_path = safe_error_path(method)
        result["error_log_path"] = error_path
        save_json(error_path, result)
        emit(result)
        raise SystemExit(0)

    required_columns = [payload["dependent_var"]]
    if payload.get("treatment_var"):
        required_columns.append(payload["treatment_var"])
    required_columns.extend(payload.get("covariates", []))

    for opt_key in required_option_columns.get(method, []):
        col = options.get(opt_key)
        if isinstance(col, str):
            required_columns.append(col)

    missing_columns = sorted(set([c for c in required_columns if c not in df.columns]))
    if missing_columns:
        result = {
            "success": False,
            "error": f"Missing columns in dataset: {missing_columns}",
        }
        error_path = safe_error_path(method)
        result["error_log_path"] = error_path
        save_json(error_path, result)
        emit(result)
        raise SystemExit(0)

    dependent_var = df[payload["dependent_var"]]
    treatment_name = payload.get("treatment_var")
    treatment_var = df[treatment_name] if treatment_name else None

    covariate_names = payload.get("covariates", [])
    covariates = df[covariate_names] if covariate_names else None

    result = {}

    if method == "ols_regression":
        model = ordinary_least_square_regression(
            dependent_var,
            treatment_var,
            covariates,
            cov_info=options.get("cov_type", "nonrobust"),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "coefficient": float(model.params[treatment_var.name]),
            "std_error": float(model.bse[treatment_var.name]),
            "p_value": float(model.pvalues[treatment_var.name]),
            "r_squared": float(model.rsquared_adj),
            "method": "OLS",
        }

    elif method == "did_static":
        model = Static_Diff_in_Diff_regression(
            dependent_var,
            df[options["treatment_entity_dummy"]],
            df[options["treatment_finished_dummy"]],
            covariates,
            entity_effect=options.get("entity_effect", False),
            time_effect=options.get("time_effect", False),
            cov_type=options.get("cov_type", "unadjusted"),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "ate": float(model.params["treatment_group_treated"]),
            "std_error": float(model.std_errors["treatment_group_treated"]),
            "p_value": float(model.pvalues["treatment_group_treated"]),
            "method": "Static DID",
        }

    elif method == "psm_matching":
        ps = propensity_score_construction(treatment_var, covariates)
        ate, att = propensity_score_matching(
            dependent_var,
            treatment_var,
            ps,
            matched_num=options.get("matched_num", 1),
            target_type=options.get("target_type", "ATE"),
        )
        result = {
            "success": True,
            "ate": float(ate) if ate is not None else None,
            "att": float(att) if att is not None else None,
            "method": "PSM",
        }

    elif method == "psm_ipw":
        ps = propensity_score_construction(treatment_var, covariates)
        ate = propensity_score_inverse_probability_weighting(
            dependent_var,
            treatment_var,
            ps,
            target_type=options.get("target_type", "ATE"),
        )
        result = {
            "success": True,
            "ate": float(ate),
            "method": "IPW",
        }

    elif method == "psm_double_robust":
        ps = propensity_score_construction(treatment_var, covariates)
        ate = propensity_score_double_robust_estimator_augmented_IPW(
            dependent_var,
            treatment_var,
            ps,
            covariates,
            cov_type=options.get("cov_type", None),
        )
        result = {
            "success": True,
            "ate": float(ate),
            "method": "Double Robust AIPW",
        }

    elif method == "iv_2sls":
        iv_var = df[options["iv_variable"]]
        model = IV_2SLS_regression(
            dependent_var,
            treatment_var,
            iv_var,
            covariates,
            cov_info=options.get("cov_type", "nonrobust"),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "coefficient": float(model.params[treatment_var.name]),
            "std_error": float(model.bse[treatment_var.name]),
            "p_value": float(model.pvalues[treatment_var.name]),
            "method": "IV-2SLS",
        }

    elif method == "iv_test":
        iv_var = df[options["iv_variable"]]
        test_result = IV_2SLS_IV_setting_test(
            dependent_var,
            treatment_var,
            iv_var,
            covariates,
            cov_type=options.get("cov_type", None),
        )
        result = {
            "success": True,
            "test_results": test_result,
            "method": "IV validity test",
        }

    elif method == "did_staggered":
        model = Staggered_Diff_in_Diff_regression(
            dependent_var,
            df[options["treatment_entity_dummy"]],
            df[options["treatment_finished_dummy"]],
            covariates,
            entity_effect=options.get("entity_effect", None),
            time_effect=options.get("time_effect", None),
            cov_type=options.get("cov_type", "unadjusted"),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "ate": float(model.params["treatment_group_treated"]),
            "std_error": float(model.std_errors["treatment_group_treated"]),
            "p_value": float(model.pvalues["treatment_group_treated"]),
            "method": "Staggered DID",
        }

    elif method == "did_event_study":
        model = Staggered_Diff_in_Diff_Event_Study_regression(
            dependent_var,
            df[options["treatment_entity_dummy"]],
            df[options["treatment_finished_dummy"]],
            df[options["relative_time_variable"]],
            covariates,
            entity_effect=options.get("entity_effect", None),
            time_effect=options.get("time_effect", None),
            cov_type=options.get("cov_type", "unadjusted"),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "coefficients": {k: float(v) for k, v in model.params.items()},
            "std_errors": {k: float(v) for k, v in model.std_errors.items()},
            "p_values": {k: float(v) for k, v in model.pvalues.items()},
            "method": "Event-study DID",
        }

    elif method == "rdd_sharp":
        running_var = df[options["running_variable"]]
        cutoff = options.get("cutoff", 0)
        late = Sharp_Regression_Discontinuity_Design_regression(
            dependent_var,
            treatment_var,
            running_var,
            covariates,
            cutoff=cutoff,
            bandwidth=options.get("bandwidth", None),
            cov_info=options.get("cov_type", "nonrobust"),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "late": float(late),
            "method": "Sharp RDD",
        }

    elif method == "rdd_fuzzy":
        running_var = df[options["running_variable"]]
        cutoff = options.get("cutoff", 0)
        late = Fuzzy_Regression_Discontinuity_Design_regression(
            dependent_var,
            treatment_var,
            running_var,
            covariates,
            cutoff=cutoff,
            bandwidth=options.get("bandwidth", None),
            cov_info=options.get("cov_type", "nonrobust"),
            target_type="estimator",
            output_tables=True,
        )
        result = {
            "success": True,
            "late": float(late),
            "method": "Fuzzy RDD",
        }

    elif method == "psm_construction":
        ps = propensity_score_construction(treatment_var, covariates)
        result = {
            "success": True,
            "propensity_scores": ps.to_dict(),
            "mean_treated": float(ps[treatment_var == 1].mean()),
            "mean_control": float(ps[treatment_var == 0].mean()),
            "method": "Propensity score construction",
        }

    elif method == "psm_regression":
        ps = propensity_score_construction(treatment_var, covariates)
        model = propensity_score_regression(
            dependent_var,
            treatment_var,
            ps,
            cov_type=options.get("cov_type", None),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "coefficient": float(model.params[treatment_var.name]),
            "std_error": float(model.bse[treatment_var.name]),
            "p_value": float(model.pvalues[treatment_var.name]),
            "method": "PS regression adjustment",
        }

    elif method == "psm_dr_ipw_ra":
        ps = propensity_score_construction(treatment_var, covariates)
        model = propensity_score_double_robust_estimator_IPW_regression_adjustment(
            dependent_var,
            treatment_var,
            covariates,
            ps,
            cov_type=options.get("cov_type", None),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "coefficient": float(model.params[treatment_var.name]),
            "std_error": float(model.bse[treatment_var.name]),
            "p_value": float(model.pvalues[treatment_var.name]),
            "method": "Double robust IPW-RA",
        }

    elif method == "psm_visualize":
        ps = propensity_score_construction(treatment_var, covariates)
        output_path = Path(payload["output_dir"]) / "ps_distribution.png"
        propensity_score_visualize_propensity_score_distribution(treatment_var, ps)
        plt.savefig(output_path, dpi=300, bbox_inches="tight")
        plt.close()
        result = {
            "success": True,
            "plot_path": str(output_path),
            "method": "PS distribution",
        }

    elif method == "did_event_study_viz":
        model = Staggered_Diff_in_Diff_Event_Study_regression(
            dependent_var,
            df[options["treatment_entity_dummy"]],
            df[options["treatment_finished_dummy"]],
            df[options["relative_time_variable"]],
            covariates,
            entity_effect=options.get("entity_effect", None),
            time_effect=options.get("time_effect", None),
            cov_type=options.get("cov_type", "unadjusted"),
            target_type="final_model",
            output_tables=True,
        )
        output_path = Path(payload["output_dir"]) / "event_study.png"
        Staggered_Diff_in_Diff_Event_Study_visualization(
            model,
            see_back_length=options.get("see_back_length", 4),
            see_forward_length=options.get("see_forward_length", 3),
        )
        plt.savefig(output_path, dpi=300, bbox_inches="tight")
        plt.close()
        result = {
            "success": True,
            "plot_path": str(output_path),
            "method": "Event-study visualization",
        }

    elif method == "rdd_fuzzy_global":
        running_var = df[options["running_variable"]]
        cutoff = options.get("cutoff", 0)
        polynomial_degree = options.get("polynomial_degree", 3)
        model = Fuzzy_RDD_Global_Polynomial_Estimator_regression(
            dependent_var,
            treatment_var,
            running_var,
            covariates,
            cutoff=cutoff,
            polynomial_degree=polynomial_degree,
            cov_info=options.get("cov_type", "nonrobust"),
            target_type="final_model",
            output_tables=True,
        )
        result = {
            "success": True,
            "late": float(model.params["treatment"]),
            "std_error": float(model.bse["treatment"]),
            "p_value": float(model.pvalues["treatment"]),
            "method": "Fuzzy RDD global polynomial",
        }

    else:
        result = {
            "success": False,
            "error": f"Unsupported method: {method}",
        }

    output_path = Path(payload["output_dir"]) / "results.json"
    if isinstance(result, dict):
        result["dataset_id"] = payload.get("dataset_id")
        result["stage_id"] = payload.get("stage_id")
        result["branch"] = payload.get("branch")
    save_json(output_path, result)

    result["output_path"] = str(output_path)
    emit(result)

except Exception as e:
    result = {
        "success": False,
        "error": str(e),
        "traceback": traceback.format_exc(),
    }
    error_path = safe_error_path(method)
    result["error_log_path"] = error_path
    save_json(error_path, result)
    emit(result)
`

    log.info("run econometrics", {
      method: params.methodName,
      dataPath,
      outputDir,
    })

    const { code, stdout, stderr } = await runInlinePython({
      command: PYTHON_CMD,
      script: pythonScript,
      cwd: Instance.directory,
    })

    if (code !== 0) {
      log.error("python failed", { code, stderr })
      throw new Error(`Econometrics failed (exit code ${code})\n${stderr}\n${stdout}`)
    }

    let result: PythonResult
    try {
      result = parsePythonResult<PythonResult>(stdout)
    } catch (error) {
      throw new Error(`Failed to parse python result: ${error}\nRaw output:\n${stdout}\nStderr:\n${stderr}`)
    }
    const effectiveRunId = inferRunId({
      requestedRunId: result.run_id ?? runId,
      stage: sourceStage,
    })
    result.run_id = effectiveRunId

    if (!result.success) {
      const reflection = classifyToolFailure({
        toolName: "econometrics",
        error: result.error ?? "unknown error",
        input: {
          methodName: params.methodName,
          dataPath: params.dataPath,
          datasetId: params.datasetId,
          stageId: params.stageId,
          dependentVar: params.dependentVar,
          treatmentVar: params.treatmentVar,
        },
      })
      const reflectionPath = persistToolReflection(reflection)
      await ctx.metadata({
        metadata: {
          reflection: {
            ...reflection,
            reflectionPath: relativeWithinProject(reflectionPath),
          },
        },
      })
      let message = `Econometrics analysis failed: ${result.error ?? "unknown error"}`
      if (result.error_log_path) message += `\nError log: ${relativeWithinProject(result.error_log_path)}`
      message += `\nReflection log: ${relativeWithinProject(reflectionPath)}`
      if (result.traceback) message += `\n${result.traceback}`
      throw new Error(message)
    }

    const visibleOutputs: Array<{ label: string; relativePath: string }> = []

    if ((params.methodName === "panel_fe_regression" || params.methodName === "baseline_regression") && result.output_path) {
      try {
        const tableResult = await generateRegressionTable({
          title: params.methodName === "baseline_regression" ? "回归结果表" : "固定效应回归结果表",
          modelDirs: [outputDir],
          columnLabels: ["(1)"],
          columnSubtitles: [params.methodName === "baseline_regression" ? "基准回归" : "固定效应回归"],
          variables: [params.treatmentVar!, ...(params.covariates ?? [])],
          notes: undefined,
          formats: ["markdown", "latex", "xlsx"],
          outputDir,
          branch,
          runId: effectiveRunId,
        })
        if (tableResult.success) {
          result.academic_table_markdown_path = tableResult.markdown_path
          result.academic_table_latex_path = tableResult.latex_path
          result.academic_table_workbook_path = tableResult.workbook_path
        }
      } catch (error) {
        log.warn("failed to generate academic table", {
          method: params.methodName,
          error: String(error),
        })
      }
    }

    let numericSnapshot: NumericSnapshotDocument | undefined
    if (result.output_path) {
      numericSnapshot = createEconometricsNumericSnapshot({
        outputDir,
        methodName: params.methodName,
        result: {
          ...result,
          treatment_var: params.treatmentVar,
        },
        coefficientsPath: result.coefficients_path,
        diagnosticsPath: result.diagnostics_path,
        metadataPath: result.metadata_path,
        datasetId: datasetManifest?.datasetId ?? result.dataset_id ?? params.datasetId,
        stageId: params.stageId ?? sourceStage?.stageId ?? result.stage_id,
        runId: effectiveRunId,
      })
      result.numeric_snapshot_path = numericSnapshot.snapshotPath
    }

    if (datasetManifest) {
      appendArtifact(datasetManifest, {
        artifactId: `${params.methodName}_${Date.now()}`,
        runId: effectiveRunId,
        stageId: params.stageId ?? sourceStage?.stageId,
        branch,
        action: params.methodName,
        outputPath: result.output_path ?? path.join(outputDir, "results.json"),
        workbookPath: result.workbook_path,
        summaryPath: result.metadata_path,
        logPath: result.narrative_path,
        createdAt: new Date().toISOString(),
        metadata: {
          runId: effectiveRunId,
          numeric_snapshot_path: result.numeric_snapshot_path,
          qa_status: result.qa_status,
          warnings: result.warnings,
          blocking_errors: result.blocking_errors,
          suggested_repairs: result.suggested_repairs,
        },
      })

      const publish = (key: string, label: string, sourcePath?: string, metadata?: Record<string, unknown>) => {
        if (!sourcePath) return
        const visiblePath = publishVisibleOutput({
          manifest: datasetManifest,
          key,
          label,
          sourcePath,
          runId: effectiveRunId,
          branch: path.join("econometrics", params.methodName),
          stageId: params.stageId ?? sourceStage?.stageId,
          metadata,
        })
        visibleOutputs.push({
          label,
          relativePath: relativeWithinProject(visiblePath),
        })
      }

      publish(`${params.methodName}_results`, `${params.methodName}_results`, result.output_path, { method: params.methodName })
      publish(`${params.methodName}_coefficients_csv`, `${params.methodName}_coefficients`, result.coefficients_path, { method: params.methodName })
      publish(`${params.methodName}_coefficients_xlsx`, `${params.methodName}_workbook`, result.workbook_path, { method: params.methodName })
      publish(`${params.methodName}_diagnostics`, `${params.methodName}_diagnostics`, result.diagnostics_path, { method: params.methodName })
      publish(`${params.methodName}_narrative`, `${params.methodName}_summary`, result.narrative_path, { method: params.methodName })
      publish(`${params.methodName}_academic_markdown`, `${params.methodName}_table_markdown`, result.academic_table_markdown_path, { method: params.methodName })
      publish(`${params.methodName}_academic_latex`, `${params.methodName}_table_latex`, result.academic_table_latex_path, { method: params.methodName })
      publish(`${params.methodName}_academic_xlsx`, `${params.methodName}_table_workbook`, result.academic_table_workbook_path, { method: params.methodName })
    }

    const visibleManifestPath = datasetManifest ? finalOutputsPath(datasetManifest.sourcePath, effectiveRunId) : undefined

    let output = `## Econometrics result - ${params.methodName}\n\n`
    if (datasetManifest?.datasetId ?? result.dataset_id) output += `Dataset: ${datasetManifest?.datasetId ?? result.dataset_id}\n`
    output += `Run ID: ${effectiveRunId}\n`
    if (params.stageId ?? result.stage_id) output += `Stage: ${params.stageId ?? result.stage_id}\n`
    output += `Branch: ${branch}\n`
    output += `Data file: ${relativeWithinProject(dataPath)}\n`
    output += `Dependent variable: ${params.dependentVar}\n`
    if (params.treatmentVar) output += `Treatment variable: ${params.treatmentVar}\n`
    if (params.covariates?.length) output += `Covariates: ${params.covariates.join(", ")}\n`
    if (params.entityVar) output += `Entity FE: ${params.entityVar}\n`
    if (params.timeVar) output += `Time FE: ${params.timeVar}\n`
    if (params.clusterVar ?? result.cluster_var) output += `Clustered SE: ${params.clusterVar ?? result.cluster_var}\n`

    output += `\n### Estimates\n`

    if (result.coefficient !== undefined) {
      output += `- Coefficient: ${result.coefficient.toFixed(4)}\n`
      if (result.std_error !== undefined) output += `- Std. error: ${result.std_error.toFixed(4)}\n`
      if (result.p_value !== undefined) {
        output += `- P-value: ${result.p_value.toFixed(4)} ${significanceStars(result.p_value)}\n`
      }
    }

    if (result.r_squared !== undefined) {
      output += `- Adj. R2: ${result.r_squared.toFixed(4)}\n`
    }

    if (result.ate !== undefined) output += `- ATE: ${result.ate.toFixed(4)}\n`
    if (result.att !== undefined) output += `- ATT: ${result.att.toFixed(4)}\n`
    if (result.late !== undefined) output += `- LATE: ${result.late.toFixed(4)}\n`
    if (result.backend) output += `- Backend: ${result.backend}\n`
    if (result.dropped_rows !== undefined) output += `- Rows dropped before estimation: ${result.dropped_rows}\n`
    if (result.qa_status) output += `- QA status: ${result.qa_status}\n`
    if (result.warnings?.length) output += `- Warnings: ${result.warnings.join(" | ")}\n`
    if (result.plot_path) output += `- Plot: ${relativeWithinProject(result.plot_path)}\n`
    if (result.coefficients_path) output += `- Coefficients CSV: ${relativeWithinProject(result.coefficients_path)}\n`
    if (result.workbook_path) output += `- Coefficients workbook: ${relativeWithinProject(result.workbook_path)}\n`
    if (result.diagnostics_path) output += `- Diagnostics JSON: ${relativeWithinProject(result.diagnostics_path)}\n`
    if (result.metadata_path) output += `- Model metadata: ${relativeWithinProject(result.metadata_path)}\n`
    if (result.narrative_path) output += `- Narrative summary: ${relativeWithinProject(result.narrative_path)}\n`
    if (result.numeric_snapshot_path) output += `- Numeric snapshot: ${relativeWithinProject(result.numeric_snapshot_path)}\n`
    if (result.academic_table_markdown_path) output += `- Three-line table Markdown: ${relativeWithinProject(result.academic_table_markdown_path)}\n`
    if (result.academic_table_latex_path) output += `- Three-line table LaTeX: ${relativeWithinProject(result.academic_table_latex_path)}\n`
    if (result.academic_table_workbook_path) output += `- Three-line table Excel: ${relativeWithinProject(result.academic_table_workbook_path)}\n`
    if (result.output_path) output += `- Result JSON: ${relativeWithinProject(result.output_path)}\n`
    if (visibleOutputs.length) {
      output += `\nVisible outputs:\n`
      for (const item of visibleOutputs) {
        output += `- ${item.label}: ${item.relativePath}\n`
      }
    }
    if (visibleManifestPath) output += `Final outputs manifest: ${relativeWithinProject(visibleManifestPath)}\n`

    output += `\nResults directory: ${relativeWithinProject(outputDir)}/\n`

    return {
      title: `Econometrics: ${params.methodName}`,
      output,
      metadata: {
        method: params.methodName,
        result,
        runId: effectiveRunId,
        numericSnapshotPath: result.numeric_snapshot_path ? relativeWithinProject(result.numeric_snapshot_path) : undefined,
        numericSnapshot: numericSnapshot,
        numericSnapshotPreview: numericSnapshot ? snapshotPreview(numericSnapshot) : undefined,
        groundingScope: "regression",
        outputDir: relativeWithinProject(outputDir),
        visibleOutputs,
        finalOutputsPath: visibleManifestPath ? relativeWithinProject(visibleManifestPath) : undefined,
      },
    }
  },
}))



