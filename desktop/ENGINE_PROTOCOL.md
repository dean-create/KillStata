# KillStata Desktop Engine Protocol v1 / v2

桌面 UI 与分析引擎只通过本协议通信。Desktop 不导入 KillStata CLI 的源码、类型或路由；CLI 可以作为一个实现该协议的本地引擎，但不是桌面端的编译依赖。

## 通用约束

- 基地址只允许本地回环地址，由桌面壳生成并保存。
- 桌面壳为每次启动生成临时访问令牌；桥接器默认拒绝没有 `Authorization: Bearer <token>` 的 HTTP 请求。只有 SSE `GET /v1/runs/{runId}/events` 因浏览器接口限制可使用同值的 `?token=`；其他端点的 query token 必须拒绝，且令牌不写入结果、日志或持久化配置。
- 手工开发启动如确有必要，可以显式设置 `KILLSTATA_ENGINE_ALLOW_UNAUTHENTICATED=true`；这不是应用默认行为，也不能用于发布包。
- Release 包中，协议桥接器负责启动同包的 KillStata 核心，并监测 Desktop 父进程；正常关闭、可捕获的终止信号和父进程消失都会使桥接器停止核心，避免遗留回环服务。
- Desktop 发布包必须携带与内置 Core 二进制一一对应的 provenance manifest，至少记录 Core 版本、CLI commit、来源仓库、sourceDirty、目标平台、协议版本和 Core SHA-256。Release 启动前必须验证 manifest 存在、协议为 `v1` 且二进制摘要匹配；CLI 后续更新不会改变已发布 `.app` 的内置快照。
- 每个 JSON 响应必须包含 `protocolVersion: "v1"`；版本不匹配时客户端必须拒绝响应，不能猜测字段含义。
- v2 使用相同资源命名但独立 `/v2/*` 路径；健康响应必须声明 `capabilities: { structuredSteps, interactive }` 两个布尔值。v1 客户端不得把 v2 响应当作 v1 响应处理。
- 错误为 `{ "protocolVersion": "v1", "code": "…", "message": "…", "retryable": false }`。
- API Key、原始文件路径、引擎内部日志不返回给 UI。
- 结果文档是引擎 assistant 消息中 `type === "text"` 且未标记 synthetic/ignored 的正文。
  没有可见正文时任务标记为 `failed`（事件消息说明原因），不把原始 JSON 当结果返回；
  `/v1/runs/{runId}/result` 在失败时 `document` 为 `null`。
- SSE 事件只有 `progress`、`completed`、`failed`、`cancelled` 四种，均携带面向用户的
  中文 `message`。`progress` 可选携带安全的 `step` 摘要：
  `id`（稳定步骤标识）、`label`（研究者可读名称）、`phase: "analysis"`、
  `status: "queued" | "running" | "completed" | "failed"`。旧引擎省略 `step` 时，
  Desktop 必须按普通文本进度兼容；未知字段不会进入 UI。`failed` 消息包含失败原因（如「API 账户余额不足，请充值后重试」），
  不包含堆栈、密钥或原始路径；桌面端可直接展示。
- v2 在同一 SSE 资源上允许新增 `question`、`permission` 和 `waiting` 事件；它们只携带安全的结构化交互字段：问题包括 `requestId/title/prompt/mode/options/allowSkip`，授权包括 `requestId/title/action/scope`。交互事件不是终态，客户端必须保持 SSE 连接。回答端点为 `POST /v2/runs/{runId}/interactions/{requestId}/answer`，拒绝端点为 `POST /v2/runs/{runId}/interactions/{requestId}/deny`，两者都要求 v2 确认响应。v1 bridge 继续使用自动应答策略，不暴露这些端点。
- 数据集、任务、提示词和单个上传都有固定上限；bridge 在 multipart 解析前就以服务器级请求体上限拒绝超大上传。每次启动会创建权限为 `0700` 的私有临时会话目录；正常关闭、父进程消失和启动失败都会清理该目录。不可捕获退出（例如 `SIGKILL`）留下、且 owner 已失活的同一私有父目录 `session-*` 会在下一次启动时回收；活跃或未标记目录绝不删除。

## 端点

| 方法 | 路径 | 目的 |
| --- | --- | --- |
| `GET` | `/v1/health` | 引擎版本及可用状态 |
| `GET` | `/v1/commands` | 当前可用的斜杠命令目录 |
| `POST` | `/v1/datasets` | 以 multipart 上传已选数据，返回不含本机路径的 `id` |
| `POST` | `/v1/runs` | 提交一条分析请求或已选 KillStata 命令，返回 `runId` |
| `GET` | `/v1/runs/{runId}/events` | SSE 进度、结果与失败事件 |
| `POST` | `/v1/runs/{runId}/cancel` | 用户停止当前分析 |
| `GET` | `/v1/runs/{runId}/result` | 获取持久化结果文档及产物索引 |
| `POST` | `/v2/runs/{runId}/interactions/{requestId}/answer` | 提交结构化问题回答 |
| `POST` | `/v2/runs/{runId}/interactions/{requestId}/deny` | 拒绝问题或权限请求 |

## 健康检查示例

```json
{
  "protocolVersion": "v1",
  "engineVersion": "0.1.0",
  "status": "ready"
}
```

`status` 仅可为 `starting`、`ready` 或 `unavailable`。Desktop 只有在 `ready` 时才允许提交分析。

## 分析请求

`POST /v1/runs` 必须携带已上传数据集与非空 `prompt`。当研究者从本地命令目录选择一个 KillStata 命令、补充参数并明确发送时，可额外携带：

```json
{
  "command": { "name": "describe", "arguments": "@policy.csv" }
}
```

`name` 只能是长度不超过 64 的字母、数字、连字符或下划线命令标识，并且必须存在于该次提交前从 `GET /v1/commands` 取得的当前公开目录；`arguments` 受同一提示词长度上限约束。桥接器把它作为结构化 HTTP 请求交给本机引擎，绝不拼接为 shell 命令。省略该字段时，原有自然语言分析路径保持不变。
