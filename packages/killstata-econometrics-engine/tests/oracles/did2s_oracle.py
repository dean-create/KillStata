"""Independent Gardner DID2S oracle for the locked mpdta acceptance fixture.

No PyFixest import is allowed here.  The oracle expands the untreated first
stage into county/time dummies, runs the event-time second stage, and computes
the clustered Gardner GMM sandwich directly with numpy.
"""

import json
import sys

import numpy as np
import pandas as pd


def fixed_effect_design(frame, entity, time):
    entities = sorted(frame[entity].unique())
    periods = sorted(frame[time].unique())
    # All entity dummies plus all but one time dummy is full rank and spans the
    # same two-way FE space as the absorbed first-stage specification.
    return np.column_stack([
        *(frame[entity].eq(value).to_numpy(dtype=float) for value in entities),
        *(frame[time].eq(value).to_numpy(dtype=float) for value in periods[1:]),
    ])


def event_time_design(frame, relative_time, reference_period):
    values = sorted(
        frame[relative_time].astype(float).unique(),
        key=lambda value: (np.isneginf(value), value),
    )
    included = [value for value in values if value != reference_period]
    matrix = np.column_stack([
        frame[relative_time].eq(value).to_numpy(dtype=float) for value in included
    ])
    return matrix, included


def main(source):
    frame = pd.read_csv(source)
    dependent = "lemp"
    treatment = "did2s_treated"
    entity = "countyreal"
    time = "year"
    relative_time = "event_time"
    reference_period = -1.0
    required = {dependent, treatment, entity, time, relative_time}
    if not required.issubset(frame.columns) or len(frame) != 2500:
        raise ValueError("DID2S oracle 的 mpdta 输入结构不正确")

    y = frame[dependent].to_numpy(dtype=float)
    untreated = frame[treatment].eq(0).to_numpy()
    x1 = fixed_effect_design(frame, entity, time)
    first_stage = np.linalg.lstsq(x1[untreated], y[untreated], rcond=None)[0]
    first_residual = y - x1 @ first_stage

    x2, event_times = event_time_design(frame, relative_time, reference_period)
    second_stage = np.linalg.solve(x2.T @ x2, x2.T @ first_residual)
    second_residual = first_residual - x2 @ second_stage

    # Gardner DID2S cluster-robust GMM covariance, implemented from the matrix
    # definition rather than reusing any PyFixest helper or result artifact.
    x10 = x1 * untreated[:, None]
    adjustment = np.linalg.solve(x10.T @ x10, (x2.T @ x1).T).T
    x2_cross_product = x2.T @ x2
    covariance = np.zeros((len(event_times), len(event_times)))
    for cluster in frame[entity].unique():
        mask = frame[entity].eq(cluster).to_numpy()
        score_numerator = (
            x2[mask].T @ second_residual[mask]
            - adjustment @ (x10[mask].T @ first_residual[mask])
        )
        score = np.linalg.solve(x2_cross_product, score_numerator)
        covariance += np.outer(score, score)

    zero_index = event_times.index(0.0)
    print(json.dumps({
        "rowsUsed": int(len(frame)),
        "coefficient": float(second_stage[zero_index]),
        "stdError": float(np.sqrt(covariance[zero_index, zero_index])),
    }))


if __name__ == "__main__":
    main(sys.argv[1])
