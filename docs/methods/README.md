# 计量方法准入卡

每个已准入模型工具调用的方法一张卡，回答用户在"高级方法盘点"任务里提出的五个问题：
算法实现来自哪里、适用条件是什么、输出怎么解释、测试覆盖到什么程度、模型调用链长什么样。

准入完成的定义 = 这张卡片存在且如实。卡片过时（比如后端换了库、契约加了字段）
必须同步更新，而不是留着一份不准的记录。

## 对标级别定义（贯穿全部卡片的共同标尺）

- **A 级**：对标已发表文献值或公认教科书数据集（例如 Grunfeld 面板、Card 1995 工资回报）。
- **B 级**：跨库独立实现对标——用另一个完全不同的软件/代码路径重新算一遍，两边应当一致。
  "自己对自己"不算 B 级，哪怕数据是合成的。
- **C 级**：合成数据、已知参数的恢复测试。能验证接线正确，验证不了算法本身对不对。

底线：每个方法家族的旗舰估计器至少 B 级。

## 已准入方法索引

| 工具 ID | 对标级别 | 后端 | 卡片 |
|---|---|---|---|
| `econometrics_recommend` | 不适用（诊断，无回归结论） | econometrics-smart.ts + statsmodels 画像 | [econometrics_recommend.md](econometrics_recommend.md) |
| `psm_construction` | B 级 | statsmodels Logit + SciPy 独立重算 | [psm_construction.md](psm_construction.md) |
| `psm_visualize` | B 级（wiring/smoke） | 同 psm_construction | 待补（Codex 2026-07-17 刚准入，卡片待回填） |
| `ols_regression` | A 级 | statsmodels OLS/WLS | [ols_regression.md](ols_regression.md) |
| `panel_fe_regression` | A 级 | linearmodels PanelOLS | [panel_fe_regression.md](panel_fe_regression.md) |
| `iv_2sls` | A 级 | linearmodels IV2SLS | [iv_2sls.md](iv_2sls.md) |
| `hdfe_regression` | B 级 | PyFixest feols | [hdfe_regression.md](hdfe_regression.md) |
| `did_static` | A 级 | PyFixest feols（交互项） | [did_static.md](did_static.md) |
| `did2s` | B 级 | PyFixest did2s（Gardner 2021） | [did2s.md](did2s.md) |
| `did_event_study_saturated` | B 级 + **beta 依赖警示** | PyFixest event_study(saturated) | [did_event_study_saturated.md](did_event_study_saturated.md) |

## 尚未准入 / 明确不准入的方法

见 `PLAN.md` "剩余方法处置表"一节：PSM 家族其余 5 项待准入；旧 TWFE 交错 DID 和旧
event study 明确不准入（Goodman-Bacon 偏误，已有现代替代）；RDD 2 项待准入；
`rdd_fuzzy_global` 倾向不准入（Gelman & Imbens 2019 反对高阶全局多项式）；
`smart_baseline`/`baseline_regression` 明确砍除（自动换估计量与产品原则冲突）。
