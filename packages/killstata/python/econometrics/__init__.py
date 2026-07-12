# -*- coding: utf-8 -*-
"""
killstata Econometrics Toolbox
计量经济学工具库

该模块提供了标准计量经济学方法的实现，包括：
- 数据预处理工具
- OLS回归
- 倾向得分匹配(PSM)
- 工具变量法(IV-2SLS)
- 双重差分法(DID)
- 断点回归(RDD)
等方法
"""

from __future__ import annotations

# 导入数据预处理工具
from .data_preprocess import (
    build_quality_report,
    coerce_dataframe_types,
    correlation_matrix,
    create_dummies,
    create_interaction_features,
    create_lag_features,
    create_lead_features,
    create_ratio_features,
    describe_dataset,
    detect_outliers,
    drop_missing_rows,
    fill_missing_constant,
    fill_missing_statistics,
    fill_missing_values,
    forward_backward_fill,
    get_column_info,
    group_linear_interpolate,
    interpolate_by_group,
    linear_interpolate,
    log_transform,
    log_transform_columns,
    panel_balance_check,
    profile_dataframe,
    regression_impute,
    safe_get_dummies,
    standardize,
    standardize_columns,
    winsorize,
    winsorize_columns,
)

# 导入计量经济学算法
from .econometric_algorithm import (
    # OLS回归
    ordinary_least_square_regression,
    breusch_pagan_test,
    white_test,
    vif_report,
    condition_number_report,
    jarque_bera_test,
    durbin_watson_test,
    breusch_godfrey_test,
    influence_summary,
    balance_test,
    common_support_report,
    alternative_covariance_check,
    leave_one_cluster_out,
    placebo_test,
    alternative_specification_check,
    run_core_diagnostics,
    run_robustness_checks,
    
    # 倾向得分相关方法
    propensity_score_construction,
    propensity_score_visualize_propensity_score_distribution,
    propensity_score_matching,
    propensity_score_inverse_probability_weighting,
    propensity_score_regression,
    propensity_score_double_robust_estimator_augmented_IPW,
    propensity_score_double_robust_estimator_IPW_regression_adjustment,
    
    # 工具变量方法
    IV_2SLS_regression,
    IV_2SLS_IV_setting_test,
    
    # 双重差分方法
    Static_Diff_in_Diff_regression,
    Staggered_Diff_in_Diff_regression,
    Staggered_Diff_in_Diff_Event_Study_regression,
)

__all__ = [
    # 数据预处理
    'get_column_info',
    'coerce_dataframe_types',
    'profile_dataframe',
    'build_quality_report',
    'drop_missing_rows',
    'fill_missing_values',
    'fill_missing_constant',
    'fill_missing_statistics',
    'forward_backward_fill',
    'linear_interpolate',
    'interpolate_by_group',
    'group_linear_interpolate',
    'regression_impute',
    'log_transform_columns',
    'log_transform',
    'standardize_columns',
    'standardize',
    'winsorize_columns',
    'winsorize',
    'safe_get_dummies',
    'create_dummies',
    'create_ratio_features',
    'create_interaction_features',
    'create_lag_features',
    'create_lead_features',
    'detect_outliers',
    'describe_dataset',
    'correlation_matrix',
    'panel_balance_check',
    
    # OLS方法
    'ordinary_least_square_regression',
    'breusch_pagan_test',
    'white_test',
    'vif_report',
    'condition_number_report',
    'jarque_bera_test',
    'durbin_watson_test',
    'breusch_godfrey_test',
    'influence_summary',
    'balance_test',
    'common_support_report',
    'alternative_covariance_check',
    'leave_one_cluster_out',
    'placebo_test',
    'alternative_specification_check',
    'run_core_diagnostics',
    'run_robustness_checks',
    
    # 倾向得分方法
    'propensity_score_construction',
    'propensity_score_visualize_propensity_score_distribution',
    'propensity_score_matching',
    'propensity_score_inverse_probability_weighting',
    'propensity_score_regression',
    'propensity_score_double_robust_estimator_augmented_IPW',
    'propensity_score_double_robust_estimator_IPW_regression_adjustment',
    
    # 工具变量方法
    'IV_2SLS_regression',
    'IV_2SLS_IV_setting_test',
    
    # 双重差分方法
    'Static_Diff_in_Diff_regression',
    'Staggered_Diff_in_Diff_regression',
    'Staggered_Diff_in_Diff_Event_Study_regression',
]

__version__ = '0.1.0'
