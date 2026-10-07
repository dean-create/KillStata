import sys
import tempfile
import unittest
from pathlib import Path

PYTHON_ROOT = Path(__file__).resolve().parents[1] / "python"
if str(PYTHON_ROOT) not in sys.path:
    sys.path.insert(0, str(PYTHON_ROOT))

from data_import.runner import _load_for_import


class CsvDelimiterImportTests(unittest.TestCase):
    def test_import_detects_semicolon_delimiter_and_preserves_columns(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "modechoice.csv"
            path.write_text(
                "individual;mode;choice;hinc\n"
                "1;1;0;35\n"
                "1;2;1;35\n",
                encoding="utf-8",
            )

            frame, receipt, sheet_info = _load_for_import(
                path,
                {"sheetPolicy": {"mode": "first_sheet"}},
            )

        self.assertEqual(frame.shape, (2, 4))
        self.assertEqual(frame.columns.tolist(), ["individual", "mode", "choice", "hinc"])
        self.assertEqual(frame["choice"].tolist(), [0, 1])
        self.assertEqual(sheet_info, None)
        self.assertEqual(receipt.get("delimiter"), ";")

    def test_import_preserves_single_column_csv_without_inventing_delimiter(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "labels.csv"
            path.write_text("label\ncontrol\ntreated\n", encoding="utf-8")

            frame, receipt, _ = _load_for_import(path, {})

        self.assertEqual(frame.shape, (2, 1))
        self.assertEqual(frame.columns.tolist(), ["label"])
        self.assertEqual(receipt.get("delimiter"), ",")


if __name__ == "__main__":
    unittest.main()
