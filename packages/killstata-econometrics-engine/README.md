# KillStata Econometrics Engine

独立的 Python 计量引擎。它只负责方法注册、参数契约、数据计算和结构化结果，不依赖模型 Provider、Session、Agent Loop、权限或 UI。

## JSONL

启动：

```bash
PYTHONPATH=src python -m killstata_econometrics_engine
```

每行输入一个 JSON 请求，每行输出一个 JSON 响应。协议版本 2 支持可选的
`progress` 帧，随后恰好一个 `result` 或 `error` 终态帧；版本 1 请求仍兼容。
stdout 只允许协议响应，诊断信息写 stderr。

## 分层边界

- `registry.py` 是方法 ID、中文别名、适用/不适用条件、输入要求、输出结构和诊断要求的唯一登记处；它绑定每个方法的 Pydantic 参数模型。
- `schemas.py` 是参数字段、类型、必填项、枚举、嵌套结构和默认值的唯一真相源；同一个模型同时生成 JSON Schema 和执行时校验结果。
- `protocol.py` 只负责 JSONL 分帧、调用 Pydantic 校验、响应封装和错误分类。
- `python/*/runner.py` 只负责已经登记的方法计算；所有 Registry 方法都由 `runner_bridge.py` 在同一个长驻引擎进程内懒加载，未绑定入口的方法会直接返回结构化错误，不会为单次调用再启动子进程。
- TypeScript 不把方法算法、方法级 Schema 或 Python 会话状态复制进 Harness；它只注入受控数据路径、输出目录和规范化参数。

## 操作

`health` 返回 Python/Registry 状态；`catalog` 只返回方法短索引；`search` 返回最多 10 个完整方法引用；`describe` 返回单个方法完整契约；`execute` 执行已确认的方法并返回结果、诊断、警告和产物引用。方法推荐与异质性扩展也通过同一 Registry/JSONL 入口执行。

## 验证边界

- `tests/test_protocol.py` 与 `test_pydantic_contract.py` 验证 Registry、JSONL 和严格参数契约。
- `tests/test_execute.py` 验证方法通过长驻引擎实际执行与结构化错误分类。
- `tests/test_benchmark_oracles.py` 读取冻结 benchmark manifest，对数据做 SHA-256 校验，并用独立实现核对 IV 诊断、RDD、DID2S 与 PSM 匹配。
- 模型如何选工具、能否恢复及用户体验不属于 Python 引擎测试，由 TypeScript Drive 场景验证。
