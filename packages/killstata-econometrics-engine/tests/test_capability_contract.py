import unittest

from pydantic import BaseModel

from killstata_econometrics_engine.registry import METHODS, describe_method


class CapabilityContractTests(unittest.TestCase):
    def test_every_registered_method_exports_one_complete_python_descriptor(self):
        required = {
            "tool_id",
            "name",
            "description",
            "input_schema",
            "accepted_input_aliases",
            "output_schema",
            "permission",
            "category",
            "executor",
        }
        for spec in METHODS.values():
            descriptor = spec.to_descriptor()
            self.assertEqual(set(descriptor), required)
            self.assertEqual(descriptor["tool_id"], spec.method_id)
            self.assertEqual(descriptor["executor"], "python")
            self.assertIsInstance(descriptor["input_schema"], dict)
            self.assertEqual(descriptor["input_schema"], spec.input_schema)
            self.assertEqual(descriptor["output_schema"], spec.output_schema)
            self.assertIsInstance(spec.input_model, type)
            self.assertTrue(issubclass(spec.input_model, BaseModel))

    def test_permission_values_are_explicit_and_conservative(self):
        allowed_effects = {"read_only", "writes_state", "writes_files", "external"}
        for spec in METHODS.values():
            permission = spec.to_descriptor()["permission"]
            self.assertIn(permission["effect"], allowed_effects)
            self.assertIsInstance(permission["destructive"], bool)
            self.assertIsInstance(permission["parallel_safe"], bool)
            self.assertIsInstance(permission["requires_confirmation"], bool)

    def test_describe_exposes_the_same_descriptor_without_a_second_schema(self):
        spec = METHODS["ols_regression"]
        described = describe_method(spec.method_id)
        descriptor = spec.to_descriptor()
        for key in descriptor:
            self.assertEqual(described[key], descriptor[key])


if __name__ == "__main__":
    unittest.main()
