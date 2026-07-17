import { execFileSync } from "child_process"

export type LinearmodelsReport = { version: string; datasets: string[] }

function pythonCommand() {
  return process.env.KILLSTATA_PYTHON?.trim() || "/Users/cw/.killstata/venv/bin/python"
}

export function inspectLinearmodelsDatasets(): LinearmodelsReport {
  const script = [
    "import json, pkgutil, linearmodels, linearmodels.datasets as datasets",
    "print(json.dumps({'version': linearmodels.__version__, 'datasets': sorted(m.name for m in pkgutil.iter_modules(datasets.__path__))}))",
  ].join("; ")
  return JSON.parse(
    execFileSync(pythonCommand(), ["-c", script], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }),
  ) as LinearmodelsReport
}
