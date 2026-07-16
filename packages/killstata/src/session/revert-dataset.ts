import type { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { DataImportTool, isStageProducingAction, type DataAction } from "../tool/data-import"
import { readDatasetManifest } from "../tool/analysis-state"

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
        if (part.tool !== "data_import") continue

        const meta = part.state.metadata as { action?: string; datasetId?: string; stageId?: string } | undefined
        if (!meta?.action || !meta.datasetId || !meta.stageId) continue
        // qa / describe / correlation 也带 stageId，但它们只是读了那个阶段，没有推进数据。
        if (!isStageProducingAction(meta.action as DataAction)) continue

        try {
          const manifest = readDatasetManifest(meta.datasetId)
          const stage = manifest.stages.find((item) => item.stageId === meta.stageId)
          if (!stage?.parentStageId) return undefined

          return {
            datasetId: meta.datasetId,
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
   * 取最后一个真正派生了数据阶段的操作；qa/describe 等只读步骤不能覆盖恢复目标。
   */
  export function findRestoreTarget(messages: MessageV2.WithParts[], datasetId: string): Target | undefined {
    let target: Target | undefined

    for (const msg of messages) {
      for (const part of msg.parts) {
        if (part.type !== "tool" || part.state.status !== "completed" || part.tool !== "data_import") continue

        const meta = part.state.metadata as { action?: string; datasetId?: string; stageId?: string } | undefined
        if (meta?.datasetId !== datasetId || !meta.action || !meta.stageId) continue
        if (!isStageProducingAction(meta.action as DataAction)) continue

        target = {
          datasetId,
          stageId: meta.stageId,
          undoneAction: meta.action,
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
    const revealed = messages.filter(
      (message) => message.info.id >= fromMessageID && message.info.id < toMessageID,
    )
    return findRestoreTarget(revealed, datasetId)
  }

  /**
   * 真正执行回滚：复用 data_import(action="rollback")，它会以目标阶段为父派生出一个新阶段。
   *
   * 注意这是「往前长」而不是「抹掉历史」——和 git revert 同理。被撤销的那个阶段仍然留在
   * manifest 和实验日志里。这正是学术诚信要的：试过什么就得留痕，不能假装没试过。
   */
  export async function rollback(target: Target, sessionID: string) {
    const tool = await DataImportTool.init()

    await tool.execute(
      {
        action: "rollback",
        datasetId: target.datasetId,
        stageId: target.stageId,
      } as never,
      {
        sessionID,
        messageID: "",
        callID: "",
        // 不能用 analyst：它的审批闸门会对 rollback 弹出「执行计划」要求用户签字，
        // 而用户此刻正是在明确要求撤销，再问一遍是荒谬的。
        agent: "general",
        abort: new AbortController().signal,
        metadata: async () => {},
        ask: async () => {},
      } as never,
    )

    log.info("rolled back dataset", { datasetId: target.datasetId, stageId: target.stageId })
  }
}
