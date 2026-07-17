import hashlib
import json
import os
import sys

import pandas as pd


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main(source, target):
    frame = pd.read_stata(source)
    # data_id in nsw_dw.dta is the literal sample label “Dehejia-Wahba Sample”,
    # not an observation identifier.  The deterministic 1-based row id only exists
    # in check storage so the one-row-per-unit PSM contract can be tested honestly.
    frame["unit_id"] = range(1, len(frame) + 1)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    frame.to_csv(target, index=False)
    print(json.dumps({
        "path": target,
        "sha256": sha256(target),
        "sourceSha256": sha256(source),
        "rows": int(len(frame)),
        "columns": list(frame.columns),
        "uniqueUnitCount": int(frame["unit_id"].nunique()),
    }))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
