import hashlib
import json
import sys

import pandas as pd


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main(did_path, digital_path):
    did = pd.read_excel(did_path, sheet_name="Data_原始编码")
    digital = pd.read_excel(digital_path, sheet_name="Sheet1")
    composite = digital["省份"].astype(str) + "_" + digital["地区"].astype(str)
    payload = {
        "did": {
            "sha256": sha256(did_path),
            "rows": int(len(did)),
            "entities": int(did["city"].nunique()),
            "periods": int(did["year"].nunique()),
            "duplicateEntityTimeRows": int(did.duplicated(["city", "year"]).sum()),
            "treatmentReversals": int(did.assign(_change=did.groupby("city")["did"].diff())._change.lt(0).sum()),
        },
        "digital": {
            "sha256": sha256(digital_path),
            "rows": int(len(digital)),
            "ambiguousDuplicateEntityTimeRows": int(digital.duplicated(["地区", "年份"]).sum()),
            "compositeEntities": int(composite.nunique()),
            "compositeDuplicateEntityTimeRows": int(pd.DataFrame({"entity": composite, "year": digital["年份"]}).duplicated(["entity", "year"]).sum()),
        },
    }
    print(json.dumps(payload, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
