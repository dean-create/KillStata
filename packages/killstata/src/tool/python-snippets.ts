// Shared inline-Python fragments reused across tool/data-import.ts and tool/econometrics.ts.
// Both tools generate standalone Python scripts as TS template strings, so there is no way
// for them to share a real Python module at runtime - this file exists to keep those copies
// from drifting apart the way the CSV-encoding fallback did before this fix.

export const PY_READ_CSV_FALLBACK = `
def read_csv_with_fallback(path):
    read_error = None
    for index, encoding in enumerate(["utf-8-sig", "gbk", "latin1"]):
        try:
            df = pd.read_csv(path, encoding=encoding)
            df.attrs["_source_encoding"] = encoding
            return df
        except Exception as exc:
            read_error = exc
            message = str(exc).lower()
            if index == 0 and not isinstance(exc, UnicodeDecodeError) and "unicode" not in message and "codec" not in message:
                raise
    raise read_error
`.trim()
