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
from .data_preprocess import get_column_info

# 导入计量经济学算法
from .econometric_algorithm import (
    # OLS回归
    ordinary_least_square_regression,
    
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
    
    # OLS方法
    'ordinary_least_square_regression',
    
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
