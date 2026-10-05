import tempfile
import unittest
from pathlib import Path

from killstata_econometrics_engine.protocol import handle_request


ROOT = Path(__file__).parent
FIXTURE = ROOT / "fixtures" / "card1995.csv"


def execute_iv_test(covariance: str, instruments: tuple[str, ...] = ("nearc4",)) -> tuple[dict, str]:
    with tempfile.TemporaryDirectory() as directory:
        response = handle_request({
            "protocol_version": 1,
            "request_id": f"iv-statistic-{covariance}-{'-'.join(instruments)}",
            "operation": "execute",
            "payload": {
                "method_id": "iv_test",
                "data_path": str(FIXTURE),
                "output_dir": directory,
                "arguments": {
                    "dependentVar": "lwage",
                    "treatmentVar": "educ",
                    "covariates": ["exper", "expersq", "black", "south", "smsa"],
                    "instrumentVars": list(instruments),
                    "covariance": covariance,
                },
            },
        })
        if not response["ok"]:
            raise AssertionError(response["error"])
        payload = response["result"]["payload"]
        tests_csv = Path(payload["testsPath"]).read_text(encoding="utf-8-sig")
        return payload, tests_csv


class IVStatisticContractTests(unittest.TestCase):
    def test_iv_estimator_description_directs_requested_full_diagnostics_to_iv_test(self):
        response = handle_request({
            "protocol_version": 1,
            "request_id": "describe-iv-estimator-next-diagnostics",
            "operation": "describe",
            "payload": {"method_id": "iv_2sls"},
        })
        self.assertTrue(response["ok"], response)
        guidance = " ".join(response["result"]["diagnostic_requirements_zh"])

        self.assertIn("iv_test", guidance)
        self.assertIn("内生性", guidance)
        self.assertIn("过度识别", guidance)

    def test_iv_test_description_discloses_robust_statistic_and_identification_limit(self):
        response = handle_request({
            "protocol_version": 1,
            "request_id": "describe-iv-test-statistic",
            "operation": "describe",
            "payload": {"method_id": "iv_test"},
        })
        self.assertTrue(response["ok"], response)
        description = response["result"]
        diagnostic_guidance = " ".join(description["diagnostic_requirements_zh"])

        self.assertIn("Wald χ²", diagnostic_guidance)
        self.assertIn("F<10", diagnostic_guidance)
        self.assertIn("排除限制", diagnostic_guidance)

    def test_robust_first_stage_chi_square_is_not_classified_with_f_less_than_ten(self):
        payload, tests_csv = execute_iv_test("robust")
        weak = payload["weakInstrument"]

        self.assertEqual(weak.get("firstStageStatisticDistribution"), "chi2(1)")
        self.assertIsNone(weak["threshold"])
        self.assertIsNone(weak["weak"])
        self.assertIn("F<10", weak["criterion"])
        self.assertIn("不适用", weak["criterion"])
        self.assertIn("chi2(1)", tests_csv)

    def test_nonrejection_of_overidentification_does_not_claim_exclusion_restriction_proved(self):
        payload, _ = execute_iv_test("robust", ("nearc4", "nearc2"))

        self.assertTrue(payload["overIdentification"]["applicable"])
        self.assertFalse(payload["overIdentification"]["instrumentsRejected"])
        self.assertNotIn("与工具外生性一致", payload["verdict"])
        self.assertIn("不等于证明", payload["verdict"])


if __name__ == "__main__":
    unittest.main()
