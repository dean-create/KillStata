/**
 * 对话流渲染（Codex 风格）。
 * 消息按类型渲染：user（右对齐 + 附件 chip）、progress（内联进度行）、
 * assistant（结果文档，markdown 安全阅读层）、system（弱化居中）。
 */
import { createEffect, createSignal, For, on, Show } from "solid-js"
import { formatElapsed, progressTone, type ProgressStep, type ResultDocumentBlock, type RunProgressSnapshot, type ThreadMessage } from "../thread"
import { Icon } from "./Icon"

const FOLLOW_THRESHOLD = 32

/** 空白线程的研究起步。点击只回填输入框，不提交、不调用分析引擎。 */
const STARTERS = [
  {
    icon: "trend" as const,
    title: "政策前后变化",
    hint: "比较实施前后的结果差异",
    prompt: "比较政策实施前后结果变量的变化，并说明处理组与对照组。",
  },
  {
    icon: "compare" as const,
    title: "处理效应比较",
    hint: "估计处理对结果的影响",
    prompt: "估计处理变量对结果变量的影响，并控制可能的混杂因素。",
  },
  {
    icon: "scatter" as const,
    title: "变量关系探索",
    hint: "识别核心变量间的关联",
    prompt: "探索结果变量与核心解释变量之间的关系，并给出稳健性建议。",
  },
]

type MessageThreadProps = {
  messages: ThreadMessage[]
  /** connected 模式活动任务的本地计时快照；不属于消息协议，也不写入研究记录。 */
  progressSnapshot?: RunProgressSnapshot
  /** 分析运行中的本地时间播报不会塞进消息 log，避免每秒触发读屏播报。 */
  showProgressSnapshot?: boolean
  /** 空白线程的本地研究起步，不会自动提交或调用分析引擎。 */
  onStarter?: (prompt: string) => void
  datasetName?: string
  /** 新消息出现时自动滚动到底部。 */
  onTailVisible?: (element: HTMLElement | undefined) => void
  /** 结果文档块 → JSX 的渲染器（由 App 注入，复用同一阅读层）。 */
  renderBlocks: (document: string) => ResultDocumentBlock[]
  /** 对应 TUI /thinking：控制历史消息默认是否展开思考过程。 */
  showThinking?: boolean
  /** 对应 TUI /timestamps：显示消息创建时间。 */
  showTimestamps?: boolean
}

export function MessageThread(props: MessageThreadProps) {
  let threadElement: HTMLDivElement | undefined
  let previousMessageLength: number | undefined
  let previousFirstMessageID: number | undefined
  const [atBottom, setAtBottom] = createSignal(true)
  const [expandedStepIDs, setExpandedStepIDs] = createSignal<Set<string>>(new Set())
  const [expandedReasoningIDs, setExpandedReasoningIDs] = createSignal<Set<number>>(new Set())
  const [collapsedReasoningIDs, setCollapsedReasoningIDs] = createSignal<Set<number>>(new Set())

  // 仅用于点击时读取当前消息的 streaming 状态；真正的渲染状态仍由每条消息闭包计算。
  const currentMessageIsStreaming = (id: number) => {
    const message = props.messages.find(
      (candidate): candidate is Extract<ThreadMessage, { kind: "assistant" }> => candidate.id === id && candidate.kind === "assistant",
    )
    return message?.streaming === true
  }

  const toggleReasoning = (id: number) => {
    const isOpen = expandedReasoningIDs().has(id)
      || ((props.showThinking ?? false) && !collapsedReasoningIDs().has(id) && currentMessageIsStreaming(id))
    if (isOpen) {
      setExpandedReasoningIDs((current) => {
        const next = new Set(current)
        next.delete(id)
        return next
      })
      setCollapsedReasoningIDs((current) => new Set(current).add(id))
      return
    }
    setCollapsedReasoningIDs((current) => {
      const next = new Set(current)
      next.delete(id)
      return next
    })
    setExpandedReasoningIDs((current) => new Set(current).add(id))
  }

  createEffect(
    on(
      () => props.messages.length,
      () => {
        queueMicrotask(() => {
          if (!threadElement) return
          const firstMessageID = props.messages[0]?.id
          const appendedUser = props.messages.length > (previousMessageLength ?? 0)
            && props.messages.at(-1)?.kind === "user"
          const researchChanged = firstMessageID !== previousFirstMessageID && props.messages.length === 0
          const shouldFollow = atBottom() || appendedUser || researchChanged
          previousMessageLength = props.messages.length
          previousFirstMessageID = firstMessageID
          if (!shouldFollow) return
          threadElement.scrollTop = Math.max(0, threadElement.scrollHeight - threadElement.clientHeight)
          setAtBottom(true)
        })
      },
    ),
  )

  const handleScroll = () => {
    if (!threadElement) return
    const distance = threadElement.scrollHeight - threadElement.scrollTop - threadElement.clientHeight
    setAtBottom(distance <= FOLLOW_THRESHOLD)
  }

  const scrollToBottom = () => {
    if (!threadElement) return
    threadElement.scrollTop = Math.max(0, threadElement.scrollHeight - threadElement.clientHeight)
    setAtBottom(true)
  }
  const toggleStep = (step: ProgressStep) => {
    setExpandedStepIDs((current) => {
      const next = new Set(current)
      if (next.has(step.id)) next.delete(step.id)
      else next.add(step.id)
      return next
    })
  }

  const timestamp = (message: ThreadMessage) => {
    if (!props.showTimestamps || !message.createdAt) return null
    const date = new Date(message.createdAt)
    return Number.isNaN(date.valueOf()) ? null : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  }

  const stepStatusLabel = (status: ProgressStep["status"]) => {
    if (status === "queued") return "排队中"
    if (status === "pending") return "待继续"
    if (status === "running") return "进行中"
    if (status === "completed") return "已完成"
    if (status === "recovered") return "已恢复"
    return "需要处理"
  }

  return (
    <div
      ref={(element) => {
        threadElement = element
      }}
      class="message-thread"
      role="log"
      aria-live="polite"
      aria-label="分析对话"
      onScroll={handleScroll}
    >
      <Show when={props.messages.length === 0}>
        <div class="thread-welcome">
          <Show when={props.datasetName}>
            <p class="thread-eyebrow" title={`已选择数据 · ${props.datasetName}`}>
              已选择数据 · {props.datasetName}
            </p>
          </Show>
          <h1>{props.datasetName ? "描述你想识别的关系" : "开始一项研究"}</h1>
          <p>{props.datasetName ? "数据仅保留在此设备。说明研究问题后再由你主动发送分析。" : "选择数据，或从一个问题开始。"}</p>
          <div class="thread-secondary">
            {/* 起步卡片只回填输入框：研究问题仍由研究者确认后主动发送，不自动触发分析。 */}
            <div class="thread-starters" role="group" aria-label="研究问题起步">
              <For each={STARTERS}>
                {(starter) => (
                  <button type="button" class="starter-card" aria-label={starter.title} onClick={() => props.onStarter?.(starter.prompt)}>
                    <Icon name={starter.icon} size={17} class="starter-icon" />
                    <span class="starter-title">{starter.title}</span>
                    <span class="starter-hint">{starter.hint}</span>
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      </Show>
      <For each={props.messages}>
        {(message) => {
          if (message.kind === "user") {
            return (
              <div class="message is-user" role="listitem">
                <div class="message-bubble">
                  <Show when={message.datasetName}>
                    <span class="attachment-chip">
                      <Icon name="paperclip" size={13} class="attachment-icon" />
                      {message.datasetName}
                      <Show when={message.worksheetName}>
                        <span class="attachment-sheet">· {message.worksheetName}</span>
                      </Show>
                    </span>
                  </Show>
                  <p class="message-text">{message.text}</p>
                  <Show when={timestamp(message)}><time class="message-timestamp">{timestamp(message)}</time></Show>
                </div>
              </div>
            )
          }
          if (message.kind === "progress") {
            // 每一步都显式打印：做了什么、正在做什么、结果如何。不再把连续进度折叠成
            // "查看前 N 步"——研究者需要看到完整的执行轨迹，而不是一个需要点开的摘要。
            const tone = progressTone(message.message)
            const step = message.step
            const expanded = () => step !== undefined && expandedStepIDs().has(step.id)
            return (
              <>
                <div class={`message is-progress progress-tone-${tone}`} role="listitem" aria-label="分析进度">
                  <Show when={step} fallback={
                    <>
                      <Icon name={tone === "done" ? "check" : "ellipsis"} size={13} class="progress-glyph" />
                      <span class="progress-text">{message.message}</span>
                    </>
                  }>
                    {(currentStep) => (
                      <details class="progress-step" open={expanded()}>
                        <summary onClick={(event) => { event.preventDefault(); toggleStep(currentStep()); }}>
                          <Icon name={currentStep().status === "completed" || currentStep().status === "recovered" ? "check" : "ellipsis"} size={13} class="progress-glyph" />
                          <span class="progress-step-label">{currentStep().label}</span>
                          <span class="progress-step-status">{stepStatusLabel(currentStep().status)}</span>
                        </summary>
                        <Show when={expanded()}>
                          <p class="progress-step-detail">{message.message}</p>
                        </Show>
                      </details>
                    )}
                  </Show>
                  <Show when={timestamp(message)}><time class="message-timestamp">{timestamp(message)}</time></Show>
                </div>
              </>
            )
          }
          if (message.kind === "assistant") {
            // 正文是研究者的主线；思考过程默认折叠，用户点击或显式 /thinking 设置后才展开。
            const reasoningEnabled = () => props.showThinking ?? false
            const reasoningOpen = () => expandedReasoningIDs().has(message.id) || (reasoningEnabled() && Boolean(message.streaming) && !collapsedReasoningIDs().has(message.id))
            const hasBody = () => Boolean(message.document.trim())
            return (
              <div class="message is-assistant" role="listitem">
                <div class="message-bubble">
                  <Show when={message.reasoning}>
                    <details class="reasoning-block" open={reasoningOpen()}>
                      <summary onClick={(event) => { event.preventDefault(); toggleReasoning(message.id) }}>
                        {reasoningOpen() ? "收起思考过程" : "展开思考过程"}
                      </summary>
                      <Show when={reasoningOpen()}>
                        <div class="reasoning-content">{message.reasoning}</div>
                      </Show>
                    </details>
                  </Show>
                  <Show when={hasBody() || !message.streaming}>
                  <section class="result-document" aria-label="结果文档">
                    <For each={props.renderBlocks(message.document)}>
                      {(block) => {
                        if (block.kind === "paragraph") return <p>{block.text}</p>
                        if (block.kind === "table") {
                          return (
                            <div class="result-table-wrap">
                              <table>
                                <thead>
                                  <tr><For each={block.headers}>{(header) => <th scope="col">{header}</th>}</For></tr>
                                </thead>
                                <tbody>
                                  <For each={block.rows}>
                                    {(row) => <tr><For each={row}>{(cell) => <td>{cell}</td>}</For></tr>}
                                  </For>
                                </tbody>
                              </table>
                            </div>
                          )
                        }
                        if (block.level === 1) return <h1>{block.text}</h1>
                        if (block.level === 2) return <h2>{block.text}</h2>
                        return <h3>{block.text}</h3>
                      }}
                    </For>
                    <Show when={message.streaming}>
                      <span class="streaming-cursor" aria-hidden="true" />
                    </Show>
                  </section>
                  </Show>
                  <Show when={timestamp(message)}><time class="message-timestamp">{timestamp(message)}</time></Show>
                </div>
              </div>
            )
          }
          return (
            <div class={`message is-system is-${message.tone}`} role="status">
              {message.message}
              <Show when={timestamp(message)}><time class="message-timestamp">{timestamp(message)}</time></Show>
            </div>
          )
        }}
      </For>
      <Show when={props.showProgressSnapshot && props.progressSnapshot}>
        {(snapshot) => (
          <div
            class="progress-snapshot"
            role="status"
            aria-label={`本地计时：已用时 ${formatElapsed(snapshot().elapsedMilliseconds)}；已收到 ${snapshot().progressUpdates} 条进度更新`}
          >
            <span aria-hidden="true" class="progress-snapshot-dot" />
            <span>已用时 {formatElapsed(snapshot().elapsedMilliseconds)} · 已收到 {snapshot().progressUpdates} 条进度更新</span>
          </div>
        )}
      </Show>
      <Show when={!atBottom() && props.messages.length > 0}>
        <button type="button" class="thread-back-to-bottom" aria-label="回到底部" onClick={scrollToBottom}>
          <Icon name="arrow-down" size={15} />
        </button>
      </Show>
      <div
        ref={(element) => {
          props.onTailVisible?.(element)
        }}
      />
    </div>
  )
}
