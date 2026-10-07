import { expect, test } from "bun:test"
import { decideNonInteractivePermission } from "@/cli/cmd/run-permission"

test("非交互 run 自动允许受管数据运行时，而不是把 data_import 当成普通 Bash 拒绝", () => {
  const decision = decideNonInteractivePermission({
    workspaceRoot: "/tmp/project",
    request: {
      permission: "bash",
      patterns: ["/Users/test/.killstata/venv/bin/python *data*"],
      metadata: { description: "数据处理动作：import", managedRuntime: true },
    },
  })

  expect(decision).toMatchObject({ response: "once", auto: true })

  const estimatorDecision = decideNonInteractivePermission({
    workspaceRoot: "/tmp/project",
    request: {
      permission: "bash",
      patterns: ["/Users/test/.killstata/venv/bin/python *ols*"],
      metadata: { description: "执行OLS回归", managedRuntime: true },
    },
  })
  expect(estimatorDecision).toMatchObject({ response: "once", auto: true })
})

test("非受管 Bash 仍然需要拒绝或人工确认", () => {
  const decision = decideNonInteractivePermission({
    workspaceRoot: "/tmp/project",
    request: {
      permission: "bash",
      patterns: ["rm -rf *"],
      metadata: { description: "执行终端命令" },
    },
  })

  expect(decision.response).toBe("reject")
})
