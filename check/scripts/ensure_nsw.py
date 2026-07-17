import hashlib
import json
import os
import sys
import urllib.request

import pandas as pd


SOURCE_URL = "https://users.nber.org/~rdehejia/data/nsw_dw.dta"
EXPECTED_COLUMNS = ["data_id", "treat", "age", "education", "black", "hispanic", "married", "nodegree", "re74", "re75", "re78"]


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def main(target):
    if not os.path.exists(target):
        os.makedirs(os.path.dirname(target), exist_ok=True)
        urllib.request.urlretrieve(SOURCE_URL, target)
    frame = pd.read_stata(target)
    columns = list(frame.columns)
    if columns != EXPECTED_COLUMNS:
        raise RuntimeError(f"NSW 变量字典不匹配：{columns}")
    print(json.dumps({"path": target, "sourceUrl": SOURCE_URL, "sha256": sha256(target), "rows": int(len(frame)), "columns": columns}))


if __name__ == "__main__":
    main(sys.argv[1])
