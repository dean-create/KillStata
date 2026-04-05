import fs from "fs"
import path from "path"
import { spawn } from "child_process"
import z from "zod"
import DESCRIPTION from "./heterogeneity-runner.txt"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Log } from "../util/log"
import { createEconometricsNumericSnapshot } from "./analysis-grounding"
import { loadResultBundle, generatedArtifactRoot } from "./analysis-artifacts"
import {
  finalOutputsPath,
  inferRunId,
  projectErrorsRoot,
  projectTempRoot,
  publishVisibleOutput,
  readDatasetManifest,
  resolveArtifactInput,
} from "./analysis-state"
import { relativeWithinProject, resolveToolPath } from "./analysis-path"
import { generateRegressionTable } from "./regression-table"

const log = Log.create({ service: "heterogeneity-runner-tool" })
const PYTHON_RESULT_PREFIX = "__KILLSTATA_JSON__"
const PYTHON_CMD = process.env.KILLSTATA_PYTHON ?? (process.platform === "win32" ? "python" : "python3")

const MethodFamilySchema = z.enum(["fe", "did", "iv", "psm", "rdd"])

const AlternativeSpecificationSchema = z
  .object({
    name: z.string(),
    dependentVar: z.string().optional(),
    treatmentVar: z.string().optional(),
    covariates: z.array(z.string()).optional(),
    notes: z.string().optional(),
  })
  .passthrough()

const PlaceboSchema = z.union([
  z.boolean(),
  z
    .object({
      variables: z.array(z.string()).optional(),
      policyTimes: z.array(z.string()).optional(),
      notes: z.string().optional(),
    })
    .passthrough(),
])

export const HeterogeneityRunnerInputSchema = z.object({
  datasetId: z.string().optional(),
  stageId: z.string().optional(),
  baselineResultDir: z.string().optional(),
  baselineOutputKey: z.string().optional(),
  directResultPath: z.string().optional(),
  methodFamily: MethodFamilySchema,
  dependentVar: z.string(),
  treatmentVar: z.string(),
  entityVar: z.string().optional(),
  timeVar: z.string().optional(),
  clusterVar: z.string().optional(),
  covariates: z.array(z.string()).default([]),
  heterogeneityVars: z.array(z.string()).default([]),
  mechanismVars: z.array(z.string()).default([]),
  placebo: PlaceboSchema.optional(),
  alternativeSpecifications: z.array(AlternativeSpecificationSchema).default([]),
  runId: z.string().optional(),
  branch: z.string().default("main"),
  outputDir: z.string().optional(),
})

export type HeterogeneityRunnerInput = z.infer<typeof HeterogeneityRunnerInputSchema>

export type HeterogeneitySpecResult = {
  spec_id: string
  spec_type: "heterogeneity" | "mechanism" | "placebo" | "alternative_spec"
  status: "success" | "failed" | "skipped"
  result_dir?: string
  result_path?: string
  diagnostics_path?: string
  metadata_path?: string
  coefficients_path?: string
  narrative_path?: string
  changed_specification: string
  key_effect_direction?: "positive" | "negative" | "zeroish"
  key_effect_significance?: "p<0.01" | "p<0.05" | "p<0.1" | "not_significant" | "unavailable"
  grounded_numbers?: {
    coefficient?: number
    std_error?: number
    p_value?: number
    r_squared?: number
    rows_used?: number
  }
  diagnostic_flags: string[]
  primary_term?: string
  raw_primary_term?: string
  title?: string
  warning?: string
  error?: string
}

type PythonRunnerResult = {
  success: boolean
  output_dir: string
  warnings?: string[]
  specs: HeterogeneitySpecResult[]
  error?: string
  traceback?: string
  error_log_path?: string
}

function encodePythonPayload(payload: unknown) {
  return Buffer.from(JSON.stringify(payload), "utf-8").toString("base64")
}

function parsePythonResult<T>(stdout: string) {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    const line = lines[idx]
    if (!line.startsWith(PYTHON_RESULT_PREFIX)) continue
    return JSON.parse(line.slice(PYTHON_RESULT_PREFIX.length)) as T
  }
  throw new Error(`Python produced no parseable output.\n${stdout}`)
}

async function runInlinePython(input: { script: string; cwd: string }) {
  const tempDir = projectTempRoot()
  fs.mkdirSync(tempDir, { recursive: true })
  const tempScriptPath = path.join(
    tempDir,
    `heterogeneity_runner_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.py`,
  )
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

function significanceLabel(pValue?: number) {
  if (pValue === undefined || !Number.isFinite(pValue)) return "unavailable" as const
  if (pValue < 0.01) return "p<0.01" as const
  if (pValue < 0.05) return "p<0.05" as const
  if (pValue < 0.1) return "p<0.1" as const
  return "not_significant" as const
}

function effectDirection(coefficient?: number) {
  if (coefficient === undefined || !Number.isFinite(coefficient)) return undefined
  if (Math.abs(coefficient) < 1e-10) return "zeroish" as const
  return coefficient > 0 ? "positive" : "negative"
}

function assertBaselineHealthy(bundle: ReturnType<typeof loadResultBundle>) {
  const resultBlocking = Array.isArray(bundle.results.blocking_errors) ? bundle.results.blocking_errors : []
  if (bundle.results.qa_status === "fail" || resultBlocking.length > 0) {
    throw new Error(`Baseline result has blocking QA issues: ${resultBlocking.join(" | ") || "qa_status=fail"}`)
  }
  const fromDiagnostics = Array.isArray(bundle.diagnostics?.post_estimation_gates)
    ? bundle.diagnostics.post_estimation_gates
    : []
  const fromResult = Array.isArray(bundle.results.post_estimation_gates) ? bundle.results.post_estimation_gates : []
  const blockingGate = [...fromDiagnostics, ...fromResult].find(
    (gate: any) => gate && gate.passed === false && gate.severity === "blocking",
  )
  if (blockingGate) {
    throw new Error(`Baseline result has blocking post-estimation gate: ${String(blockingGate.gate ?? "unknown")}`)
  }
}

function resolveAnalysisDataPath(input: {
  datasetId?: string
  stageId?: string
  baselineBundle: ReturnType<typeof loadResultBundle>
}) {
  const datasetId = input.datasetId ?? input.baselineBundle.datasetId
  if (datasetId) {
    const artifact = resolveArtifactInput({
      datasetId,
      stageId: input.stageId ?? input.baselineBundle.stageId,
    })
    if (artifact.resolvedInputPath) return artifact.resolvedInputPath
  }
  const fromBundle = input.baselineBundle.sourcePath
  if (fromBundle && fs.existsSync(fromBundle)) return fromBundle
  throw new Error("Unable to resolve canonical analysis dataset for heterogeneity_runner.")
}

function renderNarrative(title: string, specs: HeterogeneitySpecResult[]) {
  const lines = [`# ${title}`, ""]
  if (specs.length === 0) {
    lines.push("- No eligible specifications were executed for this section.")
    lines.push("")
    return lines.join("\n")
  }
  for (const spec of specs) {
    lines.push(`## ${spec.title ?? spec.spec_id}`)
    lines.push(`- Status: ${spec.status}`)
    lines.push(`- Changed specification: ${spec.changed_specification}`)
    if (spec.status === "success" && spec.grounded_numbers) {
      lines.push(
        `- Grounded result: coefficient=${spec.grounded_numbers.coefficient?.toFixed(6) ?? "NA"}, p-value=${spec.grounded_numbers.p_value?.toFixed(6) ?? "NA"}, rows=${spec.grounded_numbers.rows_used ?? "NA"}.`,
      )
      lines.push(
        `- Interpretation: primary effect is ${spec.key_effect_direction ?? "unavailable"} and ${spec.key_effect_significance ?? "unavailable"}.`,
      )
    }
    if (spec.diagnostic_flags.length) lines.push(`- Diagnostic flags: ${spec.diagnostic_flags.join(" | ")}`)
    if (spec.warning) lines.push(`- Warning: ${spec.warning}`)
    if (spec.error) lines.push(`- Error: ${spec.error}`)
    lines.push("")
  }
  return lines.join("\n")
}

function relativeSpec(spec: HeterogeneitySpecResult) {
  return {
    ...spec,
    result_dir: spec.result_dir ? relativeWithinProject(spec.result_dir) : undefined,
    result_path: spec.result_path ? relativeWithinProject(spec.result_path) : undefined,
    diagnostics_path: spec.diagnostics_path ? relativeWithinProject(spec.diagnostics_path) : undefined,
    metadata_path: spec.metadata_path ? relativeWithinProject(spec.metadata_path) : undefined,
    coefficients_path: spec.coefficients_path ? relativeWithinProject(spec.coefficients_path) : undefined,
    narrative_path: spec.narrative_path ? relativeWithinProject(spec.narrative_path) : undefined,
  }
}

function buildPythonScript(payloadB64: string) {
  return `
import base64
import json
from datetime import datetime
from pathlib import Path
import traceback

import numpy as np
import pandas as pd
import statsmodels.formula.api as smf

RESULT_PREFIX = "${PYTHON_RESULT_PREFIX}"
ERRORS_DIR = r"${projectErrorsRoot().replace(/\\/g, "\\\\")}"
PAYLOAD = json.loads(base64.b64decode("${payloadB64}").decode("utf-8"))

def emit(result):
    print(f"{RESULT_PREFIX}{json.dumps(result, ensure_ascii=False)}")

def save_json(file_path, payload):
    Path(file_path).parent.mkdir(parents=True, exist_ok=True)
    with open(file_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

def q(name):
    escaped = str(name).replace("\\\\", "\\\\\\\\").replace('"', '\\\\\\"')
    return f'Q("{escaped}")'

def read_table(file_path):
    suffix = Path(file_path).suffix.lower()
    if suffix == ".csv":
        return pd.read_csv(file_path)
    if suffix in [".xlsx", ".xls"]:
        return pd.read_excel(file_path)
    if suffix == ".dta":
        return pd.read_stata(file_path)
    if suffix == ".parquet":
        return pd.read_parquet(file_path)
    raise ValueError(f"Unsupported input format: {suffix}")

def to_numeric_if_possible(series):
    converted = pd.to_numeric(series, errors="coerce")
    if converted.notna().sum() >= max(1, int(len(series) * 0.6)):
        return converted
    return series

def load_df():
    df = read_table(PAYLOAD["data_path"]).copy()
    for column in df.columns:
        df[column] = to_numeric_if_possible(df[column])
    return df

def significance_label(p_value):
    if p_value is None or pd.isna(p_value):
        return "unavailable"
    p_value = float(p_value)
    if p_value < 0.01:
        return "p<0.01"
    if p_value < 0.05:
        return "p<0.05"
    if p_value < 0.1:
        return "p<0.1"
    return "not_significant"

def direction_label(value):
    if value is None or pd.isna(value):
        return None
    value = float(value)
    if abs(value) < 1e-10:
        return "zeroish"
    return "positive" if value > 0 else "negative"

def build_formula(dependent_var, terms, entity_var=None, time_var=None):
    rhs = [term for term in terms if term]
    if entity_var:
        rhs.append(f"C({q(entity_var)})")
    if time_var:
        rhs.append(f"C({q(time_var)})")
    return f"{q(dependent_var)} ~ " + " + ".join(rhs)

def fit_formula(df, dependent_var, treatment_var, covariates, primary_term, entity_var=None, time_var=None, cluster_var=None, extra_terms=None):
    needed = [dependent_var, treatment_var, *covariates]
    if entity_var:
        needed.append(entity_var)
    if time_var:
        needed.append(time_var)
    if cluster_var:
        needed.append(cluster_var)
    missing = sorted({col for col in needed if col and col not in df.columns})
    if missing:
        raise ValueError(f"Missing columns: {missing}")

    work = df[needed].copy()
    for column in [dependent_var, treatment_var, *covariates]:
        work[column] = pd.to_numeric(work[column], errors="coerce")
    if extra_terms:
        for name, series in extra_terms.items():
            work[name] = series
    subset = [dependent_var, treatment_var, *covariates]
    if extra_terms:
        subset.extend(extra_terms.keys())
    work = work.dropna(subset=subset)
    if len(work) < 20:
        raise ValueError("Too few usable rows after dropping missing values")

    terms = [q(treatment_var), *[q(item) for item in covariates]]
    if extra_terms:
        terms.extend(extra_terms.keys())
    formula = build_formula(dependent_var, terms, entity_var=entity_var, time_var=time_var)

    fit_kwargs = {}
    cov_type = "HC1"
    if cluster_var and cluster_var in work.columns and work[cluster_var].nunique(dropna=True) > 1:
        cov_type = "cluster"
        fit_kwargs = {"cov_kwds": {"groups": work[cluster_var]}}
    model = smf.ols(formula, data=work).fit(cov_type=cov_type, **fit_kwargs)
    if primary_term not in model.params.index:
        raise ValueError(f"Primary term not found in fitted model: {primary_term}")
    return model, work, cov_type

def persist_spec(spec_dir, spec, model, work, cov_type, dependent_var, treatment_var, covariates, primary_term, raw_primary_term):
    spec_dir.mkdir(parents=True, exist_ok=True)
    conf_int = model.conf_int()
    rows = []
    for term in model.params.index:
        display_term = "primary_term" if term == primary_term else term
        rows.append({
            "term": display_term,
            "raw_term": term,
            "coefficient": float(model.params[term]),
            "std_error": float(model.bse[term]),
            "p_value": float(model.pvalues[term]),
            "ci_lower": float(conf_int.loc[term, 0]),
            "ci_upper": float(conf_int.loc[term, 1]),
        })
    coeff_df = pd.DataFrame(rows)
    coefficients_path = spec_dir / "coefficient_table.csv"
    coeff_df.to_csv(coefficients_path, index=False, encoding="utf-8-sig")

    diagnostics = {
        "core": {
            "covariance_type": cov_type,
            "cluster_var": spec.get("cluster_var"),
            "cluster_count": int(work[spec["cluster_var"]].nunique()) if spec.get("cluster_var") and spec["cluster_var"] in work.columns else None,
        },
        "qa": {
            "warnings": [],
            "blocking_errors": [],
            "rows_used": int(len(work)),
        },
        "post_estimation_gates": [],
    }
    metadata = {
        "dependent_var": dependent_var,
        "treatment_var": "primary_term",
        "raw_treatment_var": treatment_var,
        "covariates": covariates,
        "entity_var": spec.get("entity_var"),
        "time_var": spec.get("time_var"),
        "cluster_var": spec.get("cluster_var"),
        "rows_used": int(len(work)),
        "spec_id": spec["spec_id"],
        "spec_type": spec["spec_type"],
        "raw_primary_term": raw_primary_term,
        "output_kind": "regression",
    }

    result = {
        "success": True,
        "method": PAYLOAD["method_family"],
        "dataset_id": PAYLOAD.get("dataset_id"),
        "stage_id": PAYLOAD.get("stage_id"),
        "run_id": PAYLOAD.get("run_id"),
        "branch": PAYLOAD.get("branch"),
        "dependent_var": dependent_var,
        "treatment_var": "primary_term",
        "raw_treatment_var": treatment_var,
        "coefficient": float(model.params[primary_term]),
        "std_error": float(model.bse[primary_term]),
        "p_value": float(model.pvalues[primary_term]),
        "r_squared": float(model.rsquared),
        "rows_used": int(len(work)),
        "qa_status": "pass",
        "warnings": [],
        "blocking_errors": [],
        "spec_id": spec["spec_id"],
        "spec_type": spec["spec_type"],
        "changed_specification": spec["changed_specification"],
        "output_path": str(spec_dir / "results.json"),
        "coefficients_path": str(coefficients_path),
        "diagnostics_path": str(spec_dir / "diagnostics.json"),
        "metadata_path": str(spec_dir / "model_metadata.json"),
        "narrative_path": str(spec_dir / "narrative.md"),
    }
    summary_line = f"{spec['title']}: coefficient={result['coefficient']:.6f}, p-value={result['p_value']:.6f}, rows={result['rows_used']}"
    with open(result["narrative_path"], "w", encoding="utf-8") as f:
        f.write("# Specification Narrative\\n\\n")
        f.write(f"- Title: {spec['title']}\\n")
        f.write(f"- Changed specification: {spec['changed_specification']}\\n")
        f.write(f"- Grounded result: {summary_line}\\n")
    save_json(result["diagnostics_path"], diagnostics)
    save_json(result["metadata_path"], metadata)
    save_json(result["output_path"], result)
    return result

def safe_spec(spec, runner):
    spec_dir = Path(PAYLOAD["output_dir"]) / "specs" / spec["spec_id"]
    try:
        outcome = spec["dependent_var"]
        treatment = spec["treatment_var"]
        covariates = spec.get("covariates") or []
        model, work, cov_type, primary_term, raw_primary_term = runner(outcome, treatment, covariates, spec)
        result = persist_spec(spec_dir, spec, model, work, cov_type, outcome, treatment, covariates, primary_term, raw_primary_term)
        return {
            "spec_id": spec["spec_id"],
            "spec_type": spec["spec_type"],
            "status": "success",
            "result_dir": str(spec_dir),
            "result_path": result["output_path"],
            "diagnostics_path": result["diagnostics_path"],
            "metadata_path": result["metadata_path"],
            "coefficients_path": result["coefficients_path"],
            "narrative_path": result["narrative_path"],
            "changed_specification": spec["changed_specification"],
            "key_effect_direction": direction_label(result["coefficient"]),
            "key_effect_significance": significance_label(result["p_value"]),
            "grounded_numbers": {
                "coefficient": result["coefficient"],
                "std_error": result["std_error"],
                "p_value": result["p_value"],
                "r_squared": result["r_squared"],
                "rows_used": result["rows_used"],
            },
            "diagnostic_flags": [],
            "primary_term": "primary_term",
            "raw_primary_term": raw_primary_term,
            "title": spec["title"],
        }
    except Exception as exc:
        return {
            "spec_id": spec["spec_id"],
            "spec_type": spec["spec_type"],
            "status": "failed",
            "changed_specification": spec["changed_specification"],
            "diagnostic_flags": ["execution_failed"],
            "title": spec["title"],
            "error": str(exc),
        }

def base_runner(df):
    def run(outcome, treatment, covariates, spec):
        extra_terms = {}
        primary_term = q(treatment)
        raw_primary_term = treatment
        if spec["spec_type"] == "heterogeneity" and spec.get("mode") == "interaction":
            extra_terms = spec["extra_terms"]
            primary_term = spec["primary_term"]
            raw_primary_term = spec["raw_primary_term"]
        model, work, cov_type = fit_formula(
            df,
            dependent_var=outcome,
            treatment_var=treatment,
            covariates=covariates,
            primary_term=primary_term,
            entity_var=spec.get("entity_var"),
            time_var=spec.get("time_var"),
            cluster_var=spec.get("cluster_var"),
            extra_terms=extra_terms,
        )
        return model, work, cov_type, primary_term, raw_primary_term
    return run

def interaction_spec(df, heter_var, template):
    if heter_var not in df.columns:
        return [{"spec_id": f"heter_interaction_{heter_var}", "spec_type": "heterogeneity", "status": "skipped", "changed_specification": f"interaction term for {heter_var}", "diagnostic_flags": ["missing_variable"], "title": f"Interaction: {heter_var}", "warning": f"Variable not found: {heter_var}"}]
    series = df[heter_var]
    numeric = pd.to_numeric(series, errors="coerce")
    if numeric.notna().sum() >= max(10, int(len(series) * 0.6)):
        centered = numeric - float(numeric.median())
        extra_name = f"int_{heter_var}"
        return [{
            **template,
            "spec_id": f"heter_interaction_{heter_var}",
            "spec_type": "heterogeneity",
            "mode": "interaction",
            "title": f"Interaction: {heter_var}",
            "changed_specification": f"Add treatment × {heter_var} interaction",
            "extra_terms": {extra_name: df[template["treatment_var"]] * centered},
            "primary_term": extra_name,
            "raw_primary_term": f"{template['treatment_var']} × centered({heter_var})",
        }]
    levels = [item for item in pd.Series(series).dropna().astype(str).unique().tolist()][:6]
    if len(levels) == 2:
        focal = levels[1]
        dummy_name = f"int_{heter_var}"
        dummy = pd.Series(np.where(series.astype(str) == focal, 1.0, 0.0), index=df.index)
        return [{
            **template,
            "spec_id": f"heter_interaction_{heter_var}",
            "spec_type": "heterogeneity",
            "mode": "interaction",
            "title": f"Interaction: {heter_var}",
            "changed_specification": f"Add treatment × 1[{heter_var}={focal}] interaction",
            "extra_terms": {dummy_name: df[template["treatment_var"]] * dummy},
            "primary_term": dummy_name,
            "raw_primary_term": f"{template['treatment_var']} × 1[{heter_var}={focal}]",
        }]
    return [{
        "spec_id": f"heter_interaction_{heter_var}",
        "spec_type": "heterogeneity",
        "status": "skipped",
        "changed_specification": f"interaction term for {heter_var}",
        "diagnostic_flags": ["unsupported_interaction_shape"],
        "title": f"Interaction: {heter_var}",
        "warning": f"Skipped interaction for {heter_var}: only binary or mostly numeric variables are supported in v1.",
    }]

def subsample_specs(df, heter_var, template):
    if heter_var not in df.columns:
        return [{"spec_id": f"heter_split_{heter_var}", "spec_type": "heterogeneity", "status": "skipped", "changed_specification": f"subsample split on {heter_var}", "diagnostic_flags": ["missing_variable"], "title": f"Split: {heter_var}", "warning": f"Variable not found: {heter_var}"}]
    series = df[heter_var]
    numeric = pd.to_numeric(series, errors="coerce")
    specs = []
    if numeric.notna().sum() >= max(10, int(len(series) * 0.6)):
        threshold = float(numeric.median())
        for side, mask in [("low", numeric <= threshold), ("high", numeric > threshold)]:
            specs.append({
                **template,
                "spec_id": f"heter_split_{heter_var}_{side}",
                "spec_type": "heterogeneity",
                "title": f"Split {heter_var}: {side}",
                "changed_specification": f"Estimate on subsample {heter_var} {'<=' if side == 'low' else '>'} median({threshold:.6f})",
                "row_filter": mask.fillna(False).tolist(),
            })
        return specs
    levels = [item for item in pd.Series(series).dropna().astype(str).unique().tolist()][:4]
    for level in levels:
        specs.append({
            **template,
            "spec_id": f"heter_split_{heter_var}_{str(level).replace(' ', '_')}",
            "spec_type": "heterogeneity",
            "title": f"Split {heter_var}: {level}",
            "changed_specification": f"Estimate on subsample {heter_var}={level}",
            "row_filter": (series.astype(str) == str(level)).fillna(False).tolist(),
        })
    return specs

def main():
    output_dir = Path(PAYLOAD["output_dir"])
    output_dir.mkdir(parents=True, exist_ok=True)
    df = load_df()
    template = {
        "dependent_var": PAYLOAD["dependent_var"],
        "treatment_var": PAYLOAD["treatment_var"],
        "covariates": PAYLOAD.get("covariates") or [],
        "entity_var": PAYLOAD.get("entity_var"),
        "time_var": PAYLOAD.get("time_var"),
        "cluster_var": PAYLOAD.get("cluster_var"),
    }
    warnings = []
    specs = []
    runner = base_runner(df)

    for heter_var in PAYLOAD.get("heterogeneity_vars") or []:
        for spec in subsample_specs(df, heter_var, template):
            if spec.get("status") == "skipped":
                specs.append(spec)
                continue
            mask = pd.Series(spec.pop("row_filter"), index=df.index)
            scoped_df = df.loc[mask].copy()
            specs.append(safe_spec(spec, base_runner(scoped_df)))
        for spec in interaction_spec(df, heter_var, template):
            if spec.get("status") == "skipped":
                specs.append(spec)
                continue
            specs.append(safe_spec(spec, runner))

    for mechanism_var in PAYLOAD.get("mechanism_vars") or []:
        spec = {
            **template,
            "spec_id": f"mechanism_{mechanism_var}",
            "spec_type": "mechanism",
            "title": f"Mechanism: {mechanism_var}",
            "dependent_var": mechanism_var,
            "changed_specification": f"Replace dependent variable with mechanism variable {mechanism_var}",
        }
        specs.append(safe_spec(spec, runner))

    placebo = PAYLOAD.get("placebo") or False
    placebo_vars = []
    if isinstance(placebo, dict):
        placebo_vars = placebo.get("variables") or []
        if placebo.get("policyTimes"):
            warnings.append("policyTimes placebo placeholders were provided but are not executed in v1; variable placebos only.")
    elif placebo is True:
        warnings.append("placebo=true received without explicit variables; skipped.")
    for placebo_var in placebo_vars:
        spec = {
            **template,
            "spec_id": f"placebo_{placebo_var}",
            "spec_type": "placebo",
            "title": f"Placebo: {placebo_var}",
            "treatment_var": placebo_var,
            "changed_specification": f"Use placebo treatment variable {placebo_var}",
        }
        specs.append(safe_spec(spec, runner))

    for alt in PAYLOAD.get("alternative_specifications") or []:
        spec = {
            **template,
            "spec_id": f"alternative_{str(alt.get('name', 'spec')).replace(' ', '_')}",
            "spec_type": "alternative_spec",
            "title": f"Alternative: {alt.get('name', 'spec')}",
            "dependent_var": alt.get("dependentVar") or template["dependent_var"],
            "treatment_var": alt.get("treatmentVar") or template["treatment_var"],
            "covariates": alt.get("covariates") or template["covariates"],
            "changed_specification": f"Alternative specification: {alt.get('name', 'spec')}",
        }
        specs.append(safe_spec(spec, runner))

    emit({"success": True, "output_dir": str(output_dir), "warnings": warnings, "specs": specs})

try:
    main()
except Exception as exc:
    error_dir = Path(ERRORS_DIR)
    error_dir.mkdir(parents=True, exist_ok=True)
    error_path = error_dir / f"heterogeneity_runner_{datetime.utcnow().strftime('%Y%m%d-%H%M%S')}_error.json"
    payload = {"success": False, "error": str(exc), "traceback": traceback.format_exc(), "error_log_path": str(error_path)}
    save_json(error_path, payload)
    emit(payload)
`
}

export const HeterogeneityRunnerTool = Tool.define("heterogeneity_runner", {
  description: DESCRIPTION,
  parameters: HeterogeneityRunnerInputSchema,
  async execute(params, ctx) {
    const baselineBundle = loadResultBundle({
      datasetId: params.datasetId,
      resultDir: params.baselineResultDir,
      outputKey: params.baselineOutputKey,
      directResultPath: params.directResultPath,
      runId: params.runId,
    })
    assertBaselineHealthy(baselineBundle)

    const manifest = params.datasetId ? readDatasetManifest(params.datasetId) : baselineBundle.manifest
    const stage = manifest?.datasetId
      ? resolveArtifactInput({
          datasetId: manifest.datasetId,
          stageId: params.stageId ?? baselineBundle.stageId,
        }).stage
      : undefined
    const runId = inferRunId({
      requestedRunId: params.runId ?? baselineBundle.runId,
      stage,
    })

    const dataPath = resolveAnalysisDataPath({
      datasetId: params.datasetId,
      stageId: params.stageId,
      baselineBundle,
    })

    const outputDir = params.outputDir
      ? await resolveToolPath({
          filePath: params.outputDir,
          mode: "write",
          toolName: "heterogeneity_runner",
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          callID: ctx.callID,
        })
      : generatedArtifactRoot({
          module: "heterogeneity_runner",
          runId,
          branch: params.branch,
        })
    fs.mkdirSync(outputDir, { recursive: true })

    const payload = {
      data_path: dataPath,
      dataset_id: manifest?.datasetId ?? baselineBundle.datasetId ?? params.datasetId ?? null,
      stage_id: params.stageId ?? baselineBundle.stageId ?? null,
      run_id: runId,
      branch: params.branch,
      method_family: params.methodFamily,
      dependent_var: params.dependentVar,
      treatment_var: params.treatmentVar,
      entity_var:
        params.entityVar ??
        (typeof baselineBundle.metadata?.entity_var === "string" ? baselineBundle.metadata.entity_var : null),
      time_var:
        params.timeVar ??
        (typeof baselineBundle.metadata?.time_var === "string" ? baselineBundle.metadata.time_var : null),
      cluster_var:
        params.clusterVar ??
        (typeof baselineBundle.metadata?.cluster_var === "string" ? baselineBundle.metadata.cluster_var : null),
      covariates: params.covariates,
      heterogeneity_vars: params.heterogeneityVars,
      mechanism_vars: params.mechanismVars,
      placebo: params.placebo ?? false,
      alternative_specifications: params.alternativeSpecifications,
      output_dir: outputDir,
    }

    log.info("run heterogeneity runner", {
      datasetId: payload.dataset_id,
      stageId: payload.stage_id,
      outputDir,
      methodFamily: params.methodFamily,
    })

    const { code, stdout, stderr } = await runInlinePython({
      script: buildPythonScript(encodePythonPayload(payload)),
      cwd: Instance.directory,
    })
    if (code !== 0) {
      throw new Error(`heterogeneity_runner failed (exit code ${code})\n${stderr}\n${stdout}`)
    }
    const result = parsePythonResult<PythonRunnerResult>(stdout)
    if (!result.success) {
      throw new Error(`heterogeneity_runner failed: ${result.error ?? "unknown error"}\n${result.traceback ?? ""}`)
    }

    const finalizedSpecs: HeterogeneitySpecResult[] = []
    for (const spec of result.specs) {
      if (
        spec.status !== "success" ||
        !spec.result_dir ||
        !spec.result_path ||
        !spec.coefficients_path ||
        !spec.metadata_path
      ) {
        finalizedSpecs.push(spec)
        continue
      }
      const resultsPayload = JSON.parse(fs.readFileSync(spec.result_path, "utf-8")) as Record<string, any>
      const numericSnapshot = createEconometricsNumericSnapshot({
        outputDir: spec.result_dir,
        methodName: `heterogeneity_${spec.spec_type}`,
        result: {
          ...resultsPayload,
          treatment_var: "primary_term",
        },
        coefficientsPath: spec.coefficients_path,
        diagnosticsPath: spec.diagnostics_path,
        metadataPath: spec.metadata_path,
        datasetId: manifest?.datasetId ?? baselineBundle.datasetId ?? params.datasetId,
        stageId: params.stageId ?? baselineBundle.stageId,
        runId,
      })
      resultsPayload.numeric_snapshot_path = numericSnapshot.snapshotPath
      fs.writeFileSync(spec.result_path, JSON.stringify(resultsPayload, null, 2), "utf-8")
      finalizedSpecs.push({
        ...spec,
        grounded_numbers: spec.grounded_numbers ?? {
          coefficient: resultsPayload.coefficient,
          std_error: resultsPayload.std_error,
          p_value: resultsPayload.p_value,
          r_squared: resultsPayload.r_squared,
          rows_used: resultsPayload.rows_used,
        },
        key_effect_direction: spec.key_effect_direction ?? effectDirection(resultsPayload.coefficient),
        key_effect_significance: spec.key_effect_significance ?? significanceLabel(resultsPayload.p_value),
      })
    }

    const heterogeneitySpecs = finalizedSpecs.filter((item) => item.spec_type === "heterogeneity")
    const mechanismSpecs = finalizedSpecs.filter((item) => item.spec_type === "mechanism")
    const robustnessSpecs = finalizedSpecs.filter(
      (item) => item.spec_type === "placebo" || item.spec_type === "alternative_spec",
    )
    const tableSpecs = finalizedSpecs.filter(
      (item) => item.status === "success" && item.spec_type !== "mechanism" && item.result_dir,
    )

    let heterogeneityTablePaths: { markdown?: string; latex?: string; xlsx?: string } = {}
    if (tableSpecs.length > 0) {
      const tableResult = await generateRegressionTable(
        {
          title: "Heterogeneity, Placebo, and Alternative Specifications",
          modelDirs: tableSpecs.map((item) => item.result_dir!),
          columnLabels: tableSpecs.map((_, idx) => `(${idx + 1})`),
          columnSubtitles: tableSpecs.map((item) => item.title ?? item.spec_id),
          variables: ["primary_term"],
          variableLabels: { primary_term: "Primary effect" },
          notes: "Notes: each column reports the primary effect of that specification. Standard errors come from the structured outputs of the corresponding model.",
          formats: ["markdown", "latex", "xlsx"],
          outputDir: path.join(outputDir, "publication_table"),
        },
        ctx,
      )
      if (tableResult.success) {
        if (tableResult.markdown_path) {
          const target = path.join(outputDir, "heterogeneity_table.md")
          fs.copyFileSync(tableResult.markdown_path, target)
          heterogeneityTablePaths.markdown = target
        }
        if (tableResult.latex_path) {
          const target = path.join(outputDir, "heterogeneity_table.tex")
          fs.copyFileSync(tableResult.latex_path, target)
          heterogeneityTablePaths.latex = target
        }
        if (tableResult.workbook_path) {
          const target = path.join(outputDir, "heterogeneity_table.xlsx")
          fs.copyFileSync(tableResult.workbook_path, target)
          heterogeneityTablePaths.xlsx = target
        }
      }
    }

    const heterogeneitySummaryPath = path.join(outputDir, "heterogeneity_summary.json")
    const mechanismSummaryPath = path.join(outputDir, "mechanism_summary.json")
    const robustnessSummaryPath = path.join(outputDir, "robustness_extension_summary.json")
    const heterogeneityNarrativePath = path.join(outputDir, "heterogeneity_narrative.md")
    const mechanismNarrativePath = path.join(outputDir, "mechanism_narrative.md")
    const combinedBundlePath = path.join(outputDir, "combined_publication_bundle.json")

    const heterogeneitySummary = {
      baseline_result_dir: relativeWithinProject(baselineBundle.resultDir),
      baseline_result_path: relativeWithinProject(baselineBundle.resultPath),
      specs: heterogeneitySpecs.map(relativeSpec),
    }
    const mechanismSummary = {
      baseline_result_dir: relativeWithinProject(baselineBundle.resultDir),
      specs: mechanismSpecs.map(relativeSpec),
    }
    const robustnessSummary = {
      baseline_result_dir: relativeWithinProject(baselineBundle.resultDir),
      specs: robustnessSpecs.map(relativeSpec),
    }

    fs.writeFileSync(heterogeneitySummaryPath, JSON.stringify(heterogeneitySummary, null, 2), "utf-8")
    fs.writeFileSync(mechanismSummaryPath, JSON.stringify(mechanismSummary, null, 2), "utf-8")
    fs.writeFileSync(robustnessSummaryPath, JSON.stringify(robustnessSummary, null, 2), "utf-8")
    fs.writeFileSync(
      heterogeneityNarrativePath,
      renderNarrative("Heterogeneity Narrative", [...heterogeneitySpecs, ...robustnessSpecs]),
      "utf-8",
    )
    fs.writeFileSync(mechanismNarrativePath, renderNarrative("Mechanism Narrative", mechanismSpecs), "utf-8")

    const combinedBundle = {
      datasetId: manifest?.datasetId ?? baselineBundle.datasetId ?? params.datasetId,
      stageId: params.stageId ?? baselineBundle.stageId,
      runId,
      branch: params.branch,
      baseline: {
        resultDir: relativeWithinProject(baselineBundle.resultDir),
        resultPath: relativeWithinProject(baselineBundle.resultPath),
        numericSnapshotPath: baselineBundle.numericSnapshot?.snapshotPath
          ? relativeWithinProject(baselineBundle.numericSnapshot.snapshotPath)
          : undefined,
      },
      heterogeneity_summary_path: relativeWithinProject(heterogeneitySummaryPath),
      mechanism_summary_path: relativeWithinProject(mechanismSummaryPath),
      robustness_extension_summary_path: relativeWithinProject(robustnessSummaryPath),
      heterogeneity_narrative_path: relativeWithinProject(heterogeneityNarrativePath),
      mechanism_narrative_path: relativeWithinProject(mechanismNarrativePath),
      heterogeneity_table: {
        markdown: heterogeneityTablePaths.markdown ? relativeWithinProject(heterogeneityTablePaths.markdown) : undefined,
        latex: heterogeneityTablePaths.latex ? relativeWithinProject(heterogeneityTablePaths.latex) : undefined,
        xlsx: heterogeneityTablePaths.xlsx ? relativeWithinProject(heterogeneityTablePaths.xlsx) : undefined,
      },
      specs: finalizedSpecs.map(relativeSpec),
      warnings: result.warnings ?? [],
    }
    fs.writeFileSync(combinedBundlePath, JSON.stringify(combinedBundle, null, 2), "utf-8")

    const visibleOutputs: Array<{ label: string; relativePath: string }> = []
    if (manifest) {
      const publish = (key: string, label: string, sourcePath?: string) => {
        if (!sourcePath || !fs.existsSync(sourcePath)) return
        const visiblePath = publishVisibleOutput({
          manifest,
          key,
          label,
          sourcePath,
          runId,
          branch: path.join("heterogeneity_runner", params.branch),
          stageId: params.stageId ?? baselineBundle.stageId,
          metadata: { module: "heterogeneity_runner", methodFamily: params.methodFamily },
        })
        visibleOutputs.push({ label, relativePath: relativeWithinProject(visiblePath) })
      }
      publish("heterogeneity_summary_json", "heterogeneity_summary_json", heterogeneitySummaryPath)
      publish("heterogeneity_narrative_md", "heterogeneity_narrative_md", heterogeneityNarrativePath)
      publish("mechanism_summary_json", "mechanism_summary_json", mechanismSummaryPath)
      publish("mechanism_narrative_md", "mechanism_narrative_md", mechanismNarrativePath)
      publish("robustness_extension_summary_json", "robustness_extension_summary_json", robustnessSummaryPath)
      publish("combined_publication_bundle_json", "combined_publication_bundle_json", combinedBundlePath)
      publish("heterogeneity_table_markdown", "heterogeneity_table_markdown", heterogeneityTablePaths.markdown)
      publish("heterogeneity_table_latex", "heterogeneity_table_latex", heterogeneityTablePaths.latex)
      publish("heterogeneity_table_xlsx", "heterogeneity_table_xlsx", heterogeneityTablePaths.xlsx)
    }

    const manifestPath = manifest ? finalOutputsPath(manifest.sourcePath, runId) : undefined
    const output = [
      "## Heterogeneity Runner Completed",
      "",
      `Run ID: ${runId}`,
      `Baseline result: ${relativeWithinProject(baselineBundle.resultPath)}`,
      `Output directory: ${relativeWithinProject(outputDir)}`,
      `Successful specs: ${finalizedSpecs.filter((item) => item.status === "success").length}`,
      `Failed or skipped specs: ${finalizedSpecs.filter((item) => item.status !== "success").length}`,
      `Combined bundle: ${relativeWithinProject(combinedBundlePath)}`,
      manifestPath ? `Final outputs manifest: ${relativeWithinProject(manifestPath)}` : "",
    ]
      .filter(Boolean)
      .join("\n")

    return {
      title: "Heterogeneity Runner",
      output,
      metadata: {
        datasetId: manifest?.datasetId ?? baselineBundle.datasetId ?? params.datasetId,
        stageId: params.stageId ?? baselineBundle.stageId,
        runId,
        outputDir: relativeWithinProject(outputDir),
        combinedBundlePath: relativeWithinProject(combinedBundlePath),
        summaryPaths: {
          heterogeneity: relativeWithinProject(heterogeneitySummaryPath),
          mechanism: relativeWithinProject(mechanismSummaryPath),
          robustness: relativeWithinProject(robustnessSummaryPath),
        },
        narrativePaths: {
          heterogeneity: relativeWithinProject(heterogeneityNarrativePath),
          mechanism: relativeWithinProject(mechanismNarrativePath),
        },
        tablePaths: {
          markdown: heterogeneityTablePaths.markdown ? relativeWithinProject(heterogeneityTablePaths.markdown) : undefined,
          latex: heterogeneityTablePaths.latex ? relativeWithinProject(heterogeneityTablePaths.latex) : undefined,
          xlsx: heterogeneityTablePaths.xlsx ? relativeWithinProject(heterogeneityTablePaths.xlsx) : undefined,
        },
        visibleOutputs,
        finalOutputsPath: manifestPath ? relativeWithinProject(manifestPath) : undefined,
      },
    }
  },
})
