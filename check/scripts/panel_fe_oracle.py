import json
import sys

import pandas as pd
from linearmodels.panel import PanelOLS


DEPENDENT = "经济发展水平"
TREATMENT = "did"
ENTITY = "city"
TIME = "year"
CONTROLS = [
    "人口密度",
    "金融发展程度",
    "城镇化水平",
    "产业结构整体升级",
    "产业结构高级化",
    "教育水平支出",
    "人力资本",
]


def main(source_path, sheet_name):
    # This is deliberately a standalone oracle: it reads the locked workbook directly
    # instead of reusing a KillStata stage, payload, output artifact, or helper module.
    frame = pd.read_excel(source_path, sheet_name=sheet_name)
    required = [DEPENDENT, TREATMENT, ENTITY, TIME, *CONTROLS]
    model = frame[required].copy()
    for column in [DEPENDENT, TREATMENT, *CONTROLS]:
        model[column] = pd.to_numeric(model[column], errors="coerce")
    model = model.dropna(subset=required)
    panel = model.set_index([ENTITY, TIME])
    regressors = panel[[TREATMENT, *CONTROLS]]
    clusters = panel.index.get_level_values(ENTITY).to_series(index=panel.index)
    fitted = PanelOLS(
        panel[DEPENDENT],
        regressors,
        entity_effects=True,
        time_effects=True,
        drop_absorbed=True,
        check_rank=True,
    ).fit(cov_type="clustered", clusters=clusters)
    print(json.dumps({
        "rowsUsed": int(len(model)),
        "coefficient": float(fitted.params[TREATMENT]),
        "stdError": float(fitted.std_errors[TREATMENT]),
    }))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
