import { fileURLToPath } from "bun"
import path from "path"
import { Identifier } from "@/id/id"
import { relativeWithinProject, realPathOrSelf } from "@/tool/analysis-path"
import { Session } from "."

export type DatasetConversationLink = {
  messageID: string
  attachmentPartID: string
}

type LinkDatasetToConversationInput = {
  sessionID: string
  sourcePath: string
  /** 已绑定过的上传消息优先按 ID 找回，避免 sourcePath 被 immutable snapshot 替换后断链。 */
  messageID?: string
  attachmentPartID?: string
  datasetId: string
  stageId?: string
  artifactPaths?: string[]
}

function sameFile(fileURL: string, sourcePath: string) {
  try {
    return realPathOrSelf(fileURLToPath(fileURL)) === realPathOrSelf(sourcePath)
  } catch {
    return false
  }
}

function artifactReference(artifactPath: string) {
  const relative = relativeWithinProject(artifactPath)
  if (!path.isAbsolute(relative)) return relative

  // 某些临时/非 Git 工作目录无法从 Instance 推导 worktree，通用 helper 会回退绝对路径。
  // canonical 产物始终在 .killstata 下，故可安全地按此锚点还原稳定项目内引用。
  const normalized = path.normalize(artifactPath)
  const marker = `${path.sep}.killstata${path.sep}`
  const markerIndex = normalized.lastIndexOf(marker)
  return markerIndex >= 0 ? normalized.slice(markerIndex + 1) : relative
}

/**
 * 将 canonical 数据集及其关键产物回写到原始上传消息。
 *
 * 不复制 Excel 或 Parquet：FilePart 已保存原始工作簿的位置，manifest 才是所有阶段和
 * 产物的真相源。这里写入一条小的 synthetic TextPart，让对话历史和压缩后的 capsule 都能
 * 反向定位同一份数据，而不是生成一份会漂移的副本。
 */
export async function linkDatasetToConversation(input: LinkDatasetToConversationInput): Promise<DatasetConversationLink | undefined> {
  const messages = await Session.messages({ sessionID: input.sessionID })
  const owner = input.messageID
    ? messages.find((message) => message.info.role === "user" && message.info.id === input.messageID)
    : [...messages]
        .reverse()
        .find((message) =>
          message.info.role === "user" &&
          message.parts.some((part) => part.type === "file" && part.url.startsWith("file:") && sameFile(part.url, input.sourcePath)),
        )
  if (!owner) return undefined

  const attachment = input.attachmentPartID
    ? owner.parts.find((part) => part.type === "file" && part.id === input.attachmentPartID)
    : owner.parts.find(
        (part) => part.type === "file" && part.url.startsWith("file:") && sameFile(part.url, input.sourcePath),
      )
  if (!attachment || attachment.type !== "file") return undefined

  const artifactPaths = [...new Set(input.artifactPaths ?? [])]
    .filter(Boolean)
    .slice(0, 8)
    .map(artifactReference)
  const metadata = {
    datasetOrigin: {
      datasetId: input.datasetId,
      stageId: input.stageId,
      attachmentPartID: attachment.id,
      manifestPath: `.killstata/datasets/${input.datasetId}/manifest.json`,
      artifactPaths,
    },
  }
  const text = [
    "<dataset-record>",
    `datasetId=${input.datasetId}`,
    `stageId=${input.stageId ?? "unknown"}`,
    `source_attachment=${attachment.filename ?? "workbook"}`,
    `manifest=.killstata/datasets/${input.datasetId}/manifest.json`,
    artifactPaths.length ? `artifacts=${artifactPaths.join(", ")}` : "artifacts=manifest-managed",
    "该数据集属于本条上传消息；复现时从 manifest 读取阶段和产物，不要复制或重新上传工作簿。",
    "</dataset-record>",
  ].join("\n")
  const existing = owner.parts.find(
    (part) =>
      part.type === "text" &&
      part.metadata?.datasetOrigin?.attachmentPartID === attachment.id,
  )

  await Session.updatePart({
    id: existing?.id ?? Identifier.ascending("part"),
    sessionID: input.sessionID,
    messageID: owner.info.id,
    type: "text",
    synthetic: true,
    text,
    metadata,
  })
  return { messageID: owner.info.id, attachmentPartID: attachment.id }
}
