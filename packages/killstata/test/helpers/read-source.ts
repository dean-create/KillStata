import fs from "fs"
import path from "path"

const SRC = path.join(process.cwd(), "src")

/**
 * 读取一个源码单元的全部文本，**不关心它是单文件还是目录**。
 *
 * 为什么需要这个：不少契约测试用 `readFileSync("src/session/prompt.ts")` 断言
 * "某条规则/某段逻辑存在"。这类断言把"逻辑在哪个文件里"也一起锁死了——
 * `session/prompt.ts` 拆成 `session/prompt/*.ts`、`runtime/workflow.ts` 拆成
 * `runtime/workflow/*.ts` 之后，规则一条没少，测试却全红。
 *
 * 传入不带扩展名的路径即可：先找同名 .ts 文件，找不到就把同名目录下所有 .ts
 * 合并返回。这样断言的是"这段逻辑仍在这个模块里"，模块内部怎么分文件是实现细节。
 *
 * 用法：`readSourceUnit("session/prompt")`、`readSourceUnit("runtime/workflow")`
 */
export function readSourceUnit(unitPath: string): string {
  const asFile = path.join(SRC, `${unitPath}.ts`)
  if (fs.existsSync(asFile)) return fs.readFileSync(asFile, "utf-8")

  const asDir = path.join(SRC, unitPath)
  if (fs.existsSync(asDir) && fs.statSync(asDir).isDirectory()) {
    return fs
      .readdirSync(asDir)
      .filter((f) => f.endsWith(".ts"))
      .sort()
      .map((f) => fs.readFileSync(path.join(asDir, f), "utf-8"))
      .join("\n")
  }

  throw new Error(`readSourceUnit: 找不到源码单元 ${unitPath}（既无 ${unitPath}.ts 也无同名目录）`)
}
