# 传统 DID 端到端验证记录

日期：2026-07-16

## 输入基准

- 教学文档：`/Users/cw/Desktop/data/传统DID案例操作及代码.docx`
- 实测数据：`/Users/cw/Desktop/data/传统DID操作演示数据.xlsx`
- 原始数据 820 行、8 列；`fte` 缺失 19 行；统一估计样本 801 行。
- 原始 `id × t` 不唯一，因此传统分组×时期 DID 可执行，严格面板 DID2S 不适用。

## 真实执行结果

- 无控制变量：DID=2.913982357430412，HC1 SE=1.7368182803898533，p=0.09378398531063303。
- 控制 `bk/kfc/roys`：DID=2.9350196886916775，HC1 SE=1.543422138485333，p=0.057581101030208304，95% CI=[-0.09465038864103947, 5.964689766024394]。
- 真实 KillStata 调用顺序：导入 → `econometrics_recommend` → QA（不传 entity/time）→ `did_static`。

## 验证命令与结果

- Python 语法：`python -m py_compile packages/killstata/python/pyfixest/runner.py`，通过。
- 类型检查：`bun run typecheck`，通过。
- 目标回归：60 通过、0 失败、252 次断言。
- 全量回归：217 通过、0 失败、726 次断言，覆盖 47 个文件。
- 构建：`bun run build --skip-install`，Linux、macOS、Windows 全目标通过。
- `git diff --check`：通过。
- 独立只读终审：Critical 0、Important 0，Ready。

## 已知非阻断项

- 首次画像/QA 的自动 verifier 明显慢于实际 PyFixest 估计，属于后续性能优化。
- 详情模式仍可能显示 `Read` 路径或英文技术碎片，属于后续可见层收口，不影响估计数值与方法选择。
