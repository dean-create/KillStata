import importlib.util
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pandas as pd


RUNNER_PATH = Path(__file__).parents[1] / "python" / "panel" / "runner.py"
SPEC = importlib.util.spec_from_file_location("killstata_panel_runner_contract", RUNNER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"无法加载面板随机效应执行器：{RUNNER_PATH}")
PANEL_RUNNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PANEL_RUNNER)


class PanelHausmanContractTests(unittest.TestCase):
    def test_no_positive_covariance_direction_is_not_reported_as_p_one(self):
        common = ["x"]
        fe = SimpleNamespace(
            params=pd.Series({"x": 1.0}),
            cov=pd.DataFrame([[1.0]], index=common, columns=common),
        )
        re = SimpleNamespace(
            params=pd.Series({"x": 0.5}),
            cov=pd.DataFrame([[2.0]], index=common, columns=common),
        )

        statistic, degrees_of_freedom, p_value = PANEL_RUNNER.hausman_statistic(fe, re, common)

        self.assertIsNone(statistic)
        self.assertEqual(degrees_of_freedom, 0)
        self.assertIsNone(p_value)

    def test_untestable_hausman_does_not_recommend_random_effects(self):
        rows = []
        for entity in range(12):
            for period in range(6):
                x = entity * 0.3 + period * 0.2 + ((entity * period) % 3) * 0.1
                y = entity * 0.5 + period * 0.1 + 1.3 * x + ((entity + period) % 4) * 0.2
                rows.append({"entity": entity, "period": period, "y": y, "x": x})

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            data_path = root / "panel.csv"
            pd.DataFrame(rows).to_csv(data_path, index=False)
            payload = {
                "method": "panel_random_effects",
                "dataPath": str(data_path),
                "outputDir": str(root / "results"),
                "dependentVar": "y",
                "treatmentVar": "x",
                "covariates": [],
                "entityVar": "entity",
                "timeVar": "period",
                "covariance": "robust",
            }

            with patch.object(PANEL_RUNNER, "hausman_statistic", return_value=(None, 0, None)):
                result = PANEL_RUNNER.build_result(payload)

        self.assertIsNone(result["hausman"]["statistic"])
        self.assertIsNone(result["hausman"]["pValue"])
        self.assertIsNone(result["hausman"]["rejectRe"])
        self.assertEqual(result["recommendation"]["preferred"], "undetermined")
        self.assertIn("无法据此", result["recommendation"]["reason"])
        self.assertTrue(any("不能据此" in warning for warning in result["warnings"]))


if __name__ == "__main__":
    unittest.main()
