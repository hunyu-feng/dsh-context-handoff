/**
 * Context Handoff — host half.
 *
 * Watches how full each live session's context is and, on demand, asks the
 * current model to write a handoff brief that a fresh session can continue
 * from. The client half does the creating / prompting / navigating.
 *
 * Threshold: bundle config `threshold` or env HANDOFF_THRESHOLD (clamped to
 * 0.5–0.98, default 0.85). Routes stay under /context-handoff/api/*.
 * Local development notes: see NOTES.md in the package root.
 */

const ROUTE_STATE = '/context-handoff/api/state'
const ROUTE_BRIEF = '/context-handoff/api/brief'
const FALLBACK_WINDOW = 1_000_000
const MAX_TRACKED = 64

function clampThreshold(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0.85
  return Math.min(0.98, Math.max(0.5, n))
}

function numberOr(value, fallback = 0) {
  return Number.isFinite(value) ? value : fallback
}

function textOfBlock(block) {
  if (!block || typeof block !== 'object') return ''
  if (block.type === 'text' && typeof block.text === 'string') return block.text
  if (block.type === 'tool-call') {
    const args = typeof block.arguments === 'string' ? block.arguments : ''
    return `[tool ${block.name}] ${args.slice(0, 400)}`
  }
  if (block.type === 'reasoning') return ''
  if (block.type === 'file' && block.attachment?.name) return `[file ${block.attachment.name}]`
  if (block.type === 'image') return '[image]'
  return ''
}

function flattenMessages(messages) {
  const lines = []
  for (const message of messages) {
    const role = message?.role
    if (!role || role === 'system' || role === 'developer') continue
    const content = Array.isArray(message.content) ? message.content : []
    const text = content.map(textOfBlock).filter(Boolean).join('\n').trim()
    if (!text) continue
    if (role === 'tool') {
      lines.push(`[工具结果] ${text.slice(0, 1500)}`)
      continue
    }
    lines.push(`${role === 'assistant' ? '助手' : '用户'}: ${text}`)
  }
  return lines.join('\n\n')
}

const BRIEF_INSTRUCTION = `你是会话交接助手。下面是一个即将耗尽上下文窗口的会话的对话记录。请写一份给"接手的新会话"看的中文交接说明，必须简洁、可执行、信息密集。

结构（固定四段，不要多余寒暄）：
1. 用户目标：一句话说清最终要交付什么，以及任何硬性约束。
2. 已完成：列出已经做完并验证过的事实（含关键文件绝对路径、命令、版本号）。
3. 未完成：当前正在做但没做完的事，以及已知的坑 / 失败尝试及原因。
4. 下一步：按优先级列出接手者应先做的 3-6 个具体动作，能直接执行。

要求：不要复述整段对话；不要写"你好"；不要问问题；总字数控制在 800 字以内；只输出交接说明本身。`

export const name = 'context-handoff'
export const inject = ['webServer', 'tokenMeter', 'llm']

export function apply(ctx, config) {
  const threshold = clampThreshold(config?.threshold ?? process.env.HANDOFF_THRESHOLD)
  /** @type {Map<string, {session: object, tokens: number, window: number, ratio: number, provider?: string, model?: string, at: number}>} */
  const tracked = new Map()
  const windowCache = new Map()

  function remember(sessionId) {
    const entry = tracked.get(sessionId)
    return entry
  }

  async function resolveWindow(sessionId, session) {
    const entry = remember(sessionId)
    if (!entry || entry.window) return
    const provider = entry.provider
    const model = entry.model
    if (!provider || !model) return
    const key = `${provider}/${model}`
    const cached = windowCache.get(key)
    if (cached) {
      entry.window = cached
      entry.ratio = entry.tokens / cached
      return
    }
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      const win = info?.context?.contextWindow
      if (Number.isFinite(win) && win > 0) {
        windowCache.set(key, win)
        entry.window = win
        entry.tokens = entry.tokens
        entry.ratio = entry.tokens / win
      }
    } catch {
      /* keep the fallback window */
    }
  }

  function projectedPressure(session) {
    try {
      const state = ctx.get('sessionProjections')?.stateOf?.(session, 'contextPressure')
      if (!state || !Number.isFinite(state.pressureTokens)) return null
      const surface = numberOr(state.surfaceTokens)
      const sampled = numberOr(state.sampledSurfaceTokens, surface)
      const tokens = Math.max(0, state.pressureTokens + surface - sampled)
      return { tokens, window: numberOr(state.contextWindow) }
    } catch {
      return null
    }
  }

  function track(session) {
    let sessionId
    try {
      sessionId = session?.id
    } catch {
      return
    }
    if (!sessionId) return
    let context = {}
    try {
      context = session.requestContext?.() ?? {}
    } catch {
      context = {}
    }
    const projected = projectedPressure(session)
    let tokens = projected ? projected.tokens : 0
    let window = projected ? projected.window : 0
    let source = projected ? 'projection' : 'measure'
    if (!projected) {
      try {
        const measurement = ctx.tokenMeter.measure(session)
        tokens = numberOr(measurement?.totalTokens)
      } catch {
        tokens = 0
      }
    }
    const cachedWindow = windowCache.get(`${context.provider}/${context.model}`)
    if (!window) window = numberOr(context.contextWindow) || cachedWindow || 0
    const entry = {
      session,
      tokens,
      window,
      ratio: window > 0 ? tokens / window : 0,
      provider: context.provider,
      model: context.model,
      source,
      at: Date.now(),
    }
    tracked.delete(sessionId)
    tracked.set(sessionId, entry)
    while (tracked.size > MAX_TRACKED) {
      const oldest = tracked.keys().next().value
      tracked.delete(oldest)
    }
    if (!window) void resolveWindow(sessionId, session)
    return entry
  }

  function snapshotOf(sessionId) {
    const entry = remember(sessionId)
    if (!entry) return null
    const window = entry.window || 0
    const ratio = window > 0 ? entry.tokens / window : entry.ratio
    return {
      ok: true,
      sessionId,
      tokens: entry.tokens,
      window,
      ratio: Math.min(1, Math.max(0, ratio)),
      percent: Math.round(Math.min(1, Math.max(0, ratio)) * 1000) / 10,
      threshold,
      ready: window > 0 && ratio >= threshold,
      provider: entry.provider ?? null,
      model: entry.model ?? null,
      source: entry.source ?? 'measure',
      measuredAt: entry.at,
    }
  }

  function latestSessionId() {
    let id = null
    for (const key of tracked.keys()) id = key
    return id
  }

  function latestIdleSessionId() {
    let id = latestSessionId()
    return id
  }

  function messagesOf(session) {
    try {
      const derived = session.deriveMessages?.()
      if (Array.isArray(derived) && derived.length > 0) return derived
    } catch {
      /* fall through */
    }
    return []
  }

  async function buildBrief(session, signal) {
    const messages = messagesOf(session)
    const transcript = flattenMessages(messages)
    const clipped = transcript.length > 60000 ? transcript.slice(-60000) : transcript
    const prompt = `${BRIEF_INSTRUCTION}\n\n===== 对话记录开始 =====\n${clipped}\n===== 对话记录结束 =====`
    const context = (() => {
      try {
        return session.requestContext?.() ?? {}
      } catch {
        return {}
      }
    })()
    const provider = context.provider
    const model = context.model
    if (!provider || !model) throw new Error('无法确定当前模型')
    let text = ''
    const stream = ctx.llm.stream({
      provider,
      model,
      system: '你是严谨的会话交接摘要器，只输出交接说明。',
      messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
      purpose: 'compaction',
      signal,
    })
    for await (const chunk of stream) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
        throw new Error(chunk.reason?.failure?.message ?? '模型调用失败')
      }
    }
    return { text: text.trim(), provider, model, messages: messages.length }
  }

  function sendJson(res, status, payload) {
    const body = JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  }

  function sessionIdFrom(url) {
    return url.searchParams.get('sessionId') || latestSessionId()
  }

  const disposers = []
  disposers.push(
    ctx.on('session/event', (session, event) => {
      if (!session || !event) return
      if (event.type === 'turn/end' || event.type === 'assistant/message' || event.type === 'request/header') {
        track(session)
      }
    }),
  )

  disposers.push(
    ctx.effect(() => {
      const off = ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_STATE,
        handler: async (req, res) => {
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const sessionId = sessionIdFrom(url)
            if (!sessionId) return sendJson(res, 404, { ok: false, error: 'no session' })
            if (!remember(sessionId)) {
              const session = ctx.get('sessions')?.get?.(sessionId)
              if (session) track(session)
            }
            const snapshot = snapshotOf(sessionId)
            if (!snapshot) return sendJson(res, 404, { ok: false, error: 'session not tracked' })
            return sendJson(res, 200, snapshot)
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        },
      })
      return () => {
        if (typeof off === 'function') off()
      }
    }),
  )

  disposers.push(
    ctx.effect(() => {
      const off = ctx.webServer.register({
        kind: 'exact',
        path: ROUTE_BRIEF,
        handler: async (req, res) => {
          const controller = new AbortController()
          const timer = setTimeout(() => controller.abort(), 90000)
          try {
            const url = new URL(req.url ?? '/', 'http://localhost')
            const sessionId = sessionIdFrom(url)
            if (!sessionId) return sendJson(res, 404, { ok: false, error: 'no session' })
            const entry = remember(sessionId)
            const session = entry?.session ?? ctx.get('sessions')?.get?.(sessionId)
            if (!session) return sendJson(res, 404, { ok: false, error: 'session not found' })
            const state = snapshotOf(sessionId)
            const result = await buildBrief(session, controller.signal)
            if (!result.text) return sendJson(res, 502, { ok: false, error: '模型没有返回摘要' })
            return sendJson(res, 200, {
              ok: true,
              sessionId,
              brief: result.text,
              provider: result.provider,
              model: result.model,
              messages: result.messages,
              state,
            })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          } finally {
            clearTimeout(timer)
          }
        },
      })
      return () => {
        if (typeof off === 'function') off()
      }
    }),
  )

  ctx.effect(() => () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        /* ignore */
      }
    }
    tracked.clear()
  })
}
