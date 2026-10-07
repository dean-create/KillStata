# @killstata/script

发布版本计算工具。读取 monorepo 根 `package.json` 的 `packageManager` 字段验证 Bun 版本，
查询 npm registry 计算下一个版本号，确定发布通道。

## 用法

```ts
import { Script } from "@killstata/script"

Script.channel  // "latest" | "<branch-name>"
Script.version  // 计算出的版本号
Script.preview  // boolean
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `KILLSTATA_CHANNEL` | 指定发布通道（覆盖 git branch） |
| `KILLSTATA_BUMP` | `major` / `minor` / 无（默认 patch） |
| `KILLSTATA_VERSION` | 直接指定版本号（跳过 registry 查询） |

## 依赖

- 必须是 bun 项目（依赖 `packageManager` 字段）
- 假设 monorepo 结构：`packages/script/`、`packages/killstata/`
