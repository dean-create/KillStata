import type { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { readDatasetManifest } from "../runtime/dataset-state"
import { DataImportTool } from "../tool/data-import"
import { MUTATING_METHODS } from "../tool/data-preprocess"

// 历史数据中可能含 data_import 产生的 filter/preprocess 阶段，必须一起识别。
const STAGE_PRODUCING_ACTIONS = new Set(["import", "filter", "preprocess", "rollback"])

/**
 * 从 tool part metadata 提取操作标识符。
 * data_import 存的是 meta.action（"import"/"filter"/"preprocess"/"rollback"），
 * data_preprocess 存的是 meta.method（"combine_columns"/"filter"/"winsorize" 等）。
 * 返回统一格式：data_import 原样，data_preprocess 加 "preprocess_" 前缀。
 */
function partAction(meta: Record<string, unknown>): string | undefined {
  if (typeof meta.action === "string") return meta.action
  if (typeof meta.method === "string") return `preprocess_${meta.method}`
  return undefined
}

/**
 * data_preprocess 中会创建新数据阶段的方法（排除 zscore_detect/iqr_detect 两个只读诊断）。
 * 从 data-preprocess.ts 的 MUTATING_METHODS 派生，避免两处硬编码漂移。
 */
const DATA_PREPROCESS_MUTATING_METHODS = new Set(
  [...MUTATING_METHODS].map((method) => `preprocess_${method}`),
)

function isStageProducingAction(action: string | undefined): boolean {
  if (!action) return false
  return STAGE_PRODUCING_ACTIONS.has(action) || DATA_PREPROCESS_MUTATING_METHODS.has(action)
}

// 撤销（/undo）在 OpenCode 里意味着"把源代码文件还原回去"，靠一个 git 影子仓库实现。
// 对计量用户毫无意义：他们不改源文件，而且数据目录根本不是 git 仓库——那套机制在他们身上
// 从来就是静默失效的（AI 把数据洗错了，没有任何退路）。
//
// 数据世界里的撤销是「回到数据的上一个版本」。这套机制已经存在：每次 filter/preprocess 都
// 派生出一个新的 parquet stage 并记下 parentStageId，天然就是一条可回溯的链。
// 我们要做的只是把 /undo 接到它上面。
export namespace RevertDataset {
  const log = Log.create({ service: "session.revert.dataset" })

  export type Target = {
    datasetId: string
    /** 要回到的那个阶段 */
    stageId: string
    /** 被撤销掉的那一步做了什么（给用户看的，例如 "filter"） */
    undoneAction: string
  }

  /**
   * 从「即将被撤销的这批消息」里，算出数据应该退回到哪个阶段。
   *
   * 撤销的语义是"就当这些操作没发生过"，所以要找的是：这批消息里**最早那个产生了新数据阶段
   * 的操作**，然后退回到它的父阶段——也就是这些操作开始之前的数据状态。
   *
   * 返回 undefined 的两种情况，都属于"没有数据可回滚"，此时 /undo 退化为纯粹的消息撤销：
   *   - 这批消息压根没动过数据（只是聊天、跑了个回归、看了看描述统计）
   *   - 最早的那个操作就是 import 本身（没有父阶段，再往前就没有数据了）
   */
  export function findTarget(messages: MessageV2.WithParts[]): Target | undefined {
    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type !== "tool" || part.state.status !== "completed") continue
        if (part.tool !== "data_import" && part.tool !== "data_preprocess") continue

        const meta = part.state.metadata as Record<string, unknown> | undefined
        const action = partAction(meta ?? {})
        const datasetId = meta?.datasetId
        const stageId = meta?.stageId
        if (!action || typeof datasetId !== "string" || typeof stageId !== "string") continue
        if (!isStageProducingAction(action)) continue

        try {
          const manifest = readDatasetManifest(datasetId)
          const stage = manifest.stages.find((item) => item.stageId === stageId)
          if (!stage?.parentStageId) return undefined

          return {
            datasetId,
            stageId: stage.parentStageId,
            undoneAction: stage.label || stage.action,
          }
        } catch (error) {
          log.warn("could not read manifest while looking for a rollback target", { error: String(error) })
          return undefined
        }
      }
    }
    return undefined
  }

  /**
   * 最后一次 /redo 会把剩余的隐藏消息全部恢复，因此数据也必须回到这些消息执行完后的状态。
   * 取最后一个真正派生了数据阶段的操作；profile/validate等只读步骤不能覆盖恢复目标。
   */
  export function findRestoreTarget(messages: MessageV2.WithParts[], datasetId: string): Target | undefined {
    let target: Target | undefined

    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type !== "tool" || part.state.status !== "completed") continue
        const tool = part.tool
        if (tool !== "data_import" && tool !== "data_preprocess") continue

        const meta = part.state.metadata as Record<string, unknown> | undefined
        const action = partAction(meta ?? {})
        if (meta?.datasetId !== datasetId || !action || !meta?.stageId) continue
        if (!isStageProducingAction(action)) continue

        target = {
          datasetId,
          stageId: meta.stageId as string,
          undoneAction: action.replace(/^preprocess_/, ""),
        }
      }
    }

    return target
  }

  export function findRedoAdvanceTarget(
    messages: MessageV2.WithParts[],
    fromMessageID: string,
    toMessageID: string,
    datasetId: string,
  ) {
    const revealed = messages.filter((message) => message.info.id >= fromMessageID && message.info.id < toMessageID)
    return findRestoreTarget(revealed, datasetId)
  }

  /**
   * 真正执行回滚：复用 data_import(action="rollback")，它会以目标阶段为父派生出一个新阶段。
   */
  export async function rollback(target: Target, sessionID: string) {
    const tool = await DataImportTool.init()
    // /undo is the user's explicit authorization for this local, reversible stage restore.
    // This internal tool invocation has no model Tool.Context, so provide the required context
    // instead of calling the permission callback on an incomplete object.
    const ctx = {
      sessionID,
      messageID: "",
      callID: "",
      agent: "system",
      abort: new AbortController().signal,
      metadata: async () => undefined,
      ask: async () => {},
    }

    await tool.execute(
      {
        action: "rollback",
        datasetId: target.datasetId,
        stageId: target.stageId,
        preserveLabels: true,
      },
      ctx as never,
    )
  }
}
