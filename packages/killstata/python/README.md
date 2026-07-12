# killstata Python Toolbox

该目录包含killstata的Python计量经济学工具库。

## 目录结构

```
python/
├── econometrics/              # 计量经济学核心工具
│   ├── __init__.py           # 包初始化，导出所有方法
│   ├── econometric_algorithm.py  # 计量方法实现(来自Econometrics-Agent)
│   └── data_preprocess.py    # 数据预处理工具(来自Econometrics-Agent)
```

## 工具说明

### 数据预处理 (`data_preprocess.py`)
- `get_column_info()`: 分析DataFrame列类型(连续/分类/时间/其他)

### 计量经济学方法 (`econometric_algorithm.py`)

#### 1. 基础回归
- `ordinary_least_square_regression()`: OLS回归，支持异方差稳健/聚类标准误

#### 2. 倾向得分方法 (Propensity Score Methods)
- `propensity_score_construction()`: 构建倾向得分
- `propensity_score_matching()`: PSM匹配估计ATE/ATT
- `propensity_score_inverse_probability_weighting()`: IPW估计
- `propensity_score_regression()`: 回归调整法
- `propensity_score_double_robust_estimator_*()`: 双重稳健估计

#### 3. 工具变量法 (IV Methods)
- `IV_2SLS_regression()`: 两阶段最小二乘法
- `IV_2SLS_IV_setting_test()`: 工具变量有效性检验

#### 4. 双重差分法 (DID Methods)
- `Static_Diff_in_Diff_regression()`: 静态DID
- `Staggered_Diff_in_Diff_regression()`: 交错DID
- `Staggered_Diff_in_Diff_Event_Study_regression()`: 事件研究法DID

## 使用方式

这些工具将通过TypeScript层调用，作为killstata的核心计量能力支撑。

## 许可与来源

- 工具库源代码来自 [Econometrics-Agent](https://github.com/FromCSUZhou/Econometrics-Agent)
- 遵循原项目Apache 2.0许可协议
