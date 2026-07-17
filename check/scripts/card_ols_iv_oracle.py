import hashlib
import json
import os
import sys

import pandas as pd
import statsmodels.api as sm
from linearmodels.datasets import card
from linearmodels.iv import IV2SLS


CONTROLS = ["exper", "expersq", "black", "south", "smsa"]


def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def row(result, term):
    standard_errors = result.std_errors if hasattr(result, "std_errors") else result.bse
    return {
        "rowsUsed": int(result.nobs),
        "coefficient": float(result.params[term]),
        "stdError": float(standard_errors[term]),
    }


def main(target):
    # The local CSV is a reproducible check fixture generated from linearmodels 7.0,
    # not a copy of KillStata's golden fixture.
    frame = card.load()
    os.makedirs(os.path.dirname(target), exist_ok=True)
    frame.to_csv(target, index=False)

    ols = sm.OLS(frame["lwage"], sm.add_constant(frame[["educ", *CONTROLS]])).fit(cov_type="HC1")
    iv = IV2SLS(frame["lwage"], sm.add_constant(frame[CONTROLS]), frame[["educ"]], frame[["nearc4"]]).fit(cov_type="robust")
    print(json.dumps({
        "path": target,
        "sha256": sha256(target),
        "rows": int(len(frame)),
        "ols": row(ols, "educ"),
        "iv": row(iv, "educ"),
    }))


if __name__ == "__main__":
    main(sys.argv[1])
