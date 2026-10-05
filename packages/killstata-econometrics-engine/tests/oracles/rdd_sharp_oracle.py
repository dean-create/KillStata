"""KillStata 锐性断点回归 oracle — 锁定 rdrobust Senate fixture。

双重独立证据：
  1) A 级已发表值：Cattaneo-Idrobo-Titiunik《A Practical Introduction to RDD》与
     rdrobust 文档中 Senate 例子的 canonical 结果——conventional RD 点估计 7.414131、
     MSE 最优带宽 h=17.754397、断点两侧有效样本 [360, 323]。
  2) 独立实现复现：用 statsmodels WLS 手写局部一次多项式（三角核、同一 MSE 带宽），
     独立复算 conventional 点估计。与 rdrobust 后端是完全不同的代码路径，若两者吻合到
     ~1e-7，即证明后端不是"自己对自己"，而是真的在算标准的局部线性 RD 估计量。

只在测试目录使用，不修改产品代码。
"""

from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import statsmodels.api as sm

FIXTURE_SHA256 = "2ce48a5b13499a6ed9c949f5ea64657ff6c131ded582fc7f7f58c92e924f90cd"

# A 级已发表 canonical 值（rdrobust Senate 例子；y=vote, x=margin, c=0，默认设定）。
PUBLISHED_CONVENTIONAL = 7.414131
PUBLISHED_BANDWIDTH_H = 17.754397
PUBLISHED_N_LEFT = 360
PUBLISHED_N_RIGHT = 323


def independent_local_linear(x: np.ndarray, y: np.ndarray, cutoff: float, h: float) -> float:
    """三角核局部一次多项式的 conventional sharp-RD 估计：D 上的系数。

    这是 conventional RD 估计量的定义式——|x-c|<=h 子样本上，用三角权重
    w=1-|x-c|/h 对 [1, x-c, D, D*(x-c)] 做加权最小二乘，D=1[x>=c]。
    """
    xc = x - cutoff
    mask = np.abs(xc) <= h
    xs = xc[mask]
    ys = y[mask]
    w = 1.0 - np.abs(xs) / h
    D = (xs >= 0).astype(float)
    X = np.column_stack([np.ones_like(xs), xs, D, D * xs])
    res = sm.WLS(ys, X, weights=w).fit()
    return float(res.params[2])


def main():
    data_path = sys.argv[1]
    content = Path(data_path).read_bytes()
    actual_sha = hashlib.sha256(content).hexdigest()
    if actual_sha != FIXTURE_SHA256:
        print(json.dumps({"error": f"rd_senate fixture hash mismatch: {actual_sha}"}))
        sys.exit(1)

    df = pd.read_csv(data_path).dropna(subset=["margin", "vote"])
    x = df["margin"].astype(float).values
    y = df["vote"].astype(float).values
    wls = independent_local_linear(x, y, cutoff=0.0, h=PUBLISHED_BANDWIDTH_H)

    print(json.dumps({
        "sha256": actual_sha,
        "rows": int(len(content.splitlines()) - 1),
        "published": {
            "conventional": PUBLISHED_CONVENTIONAL,
            "bandwidthH": PUBLISHED_BANDWIDTH_H,
            "nLeft": PUBLISHED_N_LEFT,
            "nRight": PUBLISHED_N_RIGHT,
        },
        "independentWls": {
            "conventional": wls,
            "bandwidthH": PUBLISHED_BANDWIDTH_H,
        },
    }, indent=2))


if __name__ == "__main__":
    main()
