/**
 * Context Handoff — client half.
 *
 * Shows how full the current conversation's context is and, once it crosses
 * the threshold, hands the work to a brand-new session: it asks the host for a
 * brief, creates the child session, prompts it with the brief and navigates
 * to it so work continues without a manual restart.
 */

window.__ModuleLoader__.load({
  id: 'dsh-context-handoff',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'context-handoff'
    const STATE_API = '/context-handoff/api/state'
    const BRIEF_API = '/context-handoff/api/brief'
    const POLL_MS = 4000
    const AUTO_KEY = 'context-handoff:auto:'

    const DICT = {
      en: {
        label: 'Context handoff',
        context: 'Context',
        ready: 'handoff due',
        handing: 'Handing off…',
        done: 'Handed off',
        open: 'Open new session',
        manual: 'Hand off now',
        retry: 'Retry',
        waiting: 'Watching context pressure',
        note: 'At {threshold}% the work moves to a new session with a summary and keeps going.',
        error: 'Handoff failed',
        unavailable: 'Context unavailable',
        confirm: 'Click again to hand off now',
      },
      zh: {
        label: '上下文交接',
        context: '上下文',
        ready: '即将交接',
        handing: '交接中…',
        done: '已交接',
        open: '打开新会话',
        manual: '立即交接',
        retry: '重试',
        waiting: '正在监测上下文占用',
        note: '达到 {threshold}% 时自动换新会话：先写交接摘要，再在新会话里继续干活。',
        error: '交接失败',
        unavailable: '上下文不可用',
        confirm: '再点一次确认交接',
      },
    }

    const CSS = `
      .ch-root { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .ch-pill { display: inline-flex; align-items: center; gap: 6px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: default; font: inherit; }
      .ch-pill.ch-action { cursor: pointer; }
      .ch-pill.ch-action:hover { border-color: var(--dsw-alias-brand-primary); }
      .ch-pill.ch-armed { border-color: var(--dsw-alias-state-warn-primary); }
      .ch-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-state-success-primary); flex: none; }
      .ch-dot[data-level="warn"] { background: var(--dsw-alias-state-warn-primary); }
      .ch-dot[data-level="high"] { background: var(--dsw-alias-state-error-primary); }
      .ch-meter { width: 54px; height: 5px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2); box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l1); overflow: hidden; flex: none; }
      .ch-meter-fill { height: 100%; background: var(--dsw-alias-state-success-primary); border-radius: 999px; transition: width .3s ease; }
      .ch-meter-fill[data-level="warn"] { background: var(--dsw-alias-state-warn-primary); }
      .ch-meter-fill[data-level="high"] { background: var(--dsw-alias-state-error-primary); }
      .ch-state { color: var(--dsw-alias-label-tertiary); }
      .ch-error { color: var(--dsw-alias-state-error-primary); }
      .ch-link { color: var(--dsw-alias-brand-primary); cursor: pointer; background: none; border: 0; padding: 0; font: inherit; }
      .ch-link:hover { text-decoration: underline; }
      .ch-spinner { width: 10px; height: 10px; border-radius: 50%; border: 2px solid var(--dsw-alias-border-l2); border-top-color: var(--dsw-alias-brand-primary); animation: ch-spin .8s linear infinite; flex: none; }
      @keyframes ch-spin { to { transform: rotate(360deg); } }
    `

    function levelOf(percent) {
      if (percent >= 85) return 'high'
      if (percent >= 60) return 'warn'
      return 'ok'
    }

    function buildPrompt(sessionId, brief) {
      return [
        '【上下文交接】上一个会话（' + sessionId + '）的上下文即将用尽，工作已交接给你。',
        '',
        '交接说明：',
        brief,
        '',
        '请直接从"下一步"开始继续执行，不要复述摘要，不要询问是否继续；涉及文件或命令时先确认现状再动手。',
      ].join('\n')
    }

    function autoKey(sessionId) {
      return AUTO_KEY + sessionId
    }

    function makeTranslate(getTranslate) {
      const fallback = (navigator.language || 'en').toLowerCase().startsWith('zh') ? DICT.zh : DICT.en
      return (key, params) => {
        let text
        const live = typeof getTranslate === 'function' ? getTranslate() : null
        if (live && typeof live === 'function') {
          try {
            text = live(key, params)
          } catch {
            text = null
          }
        }
        if (!text || text === key) text = fallback[key] ?? DICT.en[key] ?? key
        if (params) text = text.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m))
        return text
      }
    }

    function useSnapshot(sessionId, t) {
      const [snapshot, setSnapshot] = React.useState(null)
      const [error, setError] = React.useState(null)
      const [tick, setTick] = React.useState(0)
      React.useEffect(() => {
        let alive = true
        let timer = null
        async function load() {
          if (!sessionId) return
          try {
            const response = await fetch(STATE_API + '?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' })
            const payload = await response.json()
            if (!alive) return
            if (payload?.ok) {
              setSnapshot(payload)
              setError(null)
            } else {
              setError(payload?.error ?? t('unavailable'))
            }
          } catch (err) {
            if (alive) setError(String(err?.message ?? err))
          }
        }
        void load()
        timer = setInterval(() => {
          if (document.visibilityState !== 'hidden') void load()
        }, POLL_MS)
        const onVisible = () => {
          if (document.visibilityState !== 'hidden') void load()
        }
        document.addEventListener('visibilitychange', onVisible)
        return () => {
          alive = false
          if (timer) clearInterval(timer)
          document.removeEventListener('visibilitychange', onVisible)
        }
      }, [sessionId, tick])
      return { snapshot, error, reload: () => setTick((v) => v + 1) }
    }

    async function firstEventSeq(sessions, sessionId) {
      let reference = null
      try {
        reference = sessions.retain(sessionId, { source: 'controllerOperation' })
        const binding = await reference.ready
        const snapshot = binding?.eventSource?.getSnapshot?.()
        const entries = snapshot?.entries ?? []
        const first = entries.find((entry) => entry?.type === 'event' && entry.event?.seq)
        return first?.event?.seq
      } catch {
        return undefined
      } finally {
        try {
          reference?.release?.()
        } catch {
          /* ignore */
        }
      }
    }

    async function createChildSession(services, sessionId) {
      const sessions = services.sessions
      if (!sessions) throw new Error('sessions service unavailable')
      if (typeof sessions.create === 'function') {
        try {
          return await sessions.create({})
        } catch {
          /* fall through to forking a minimal prefix */
        }
      }
      if (typeof sessions.fork === 'function') {
        const atSeq = await firstEventSeq(sessions, sessionId)
        return await sessions.fork(atSeq ? { sessionId, atSeq, increaseTitle: true } : { sessionId, increaseTitle: true })
      }
      throw new Error('无法新建会话（sessions.create / sessions.fork 均不可用）')
    }

    function Widget(props) {
      const t = props.t
      const sessionId = props.sessionId
      const services = props.services
      const useSession = props.useSession
      const running = typeof useSession === 'function' ? useSession((state) => Boolean(state?.running)) : false
      const { snapshot, error, reload } = useSnapshot(sessionId, t)
      const [phase, setPhase] = React.useState('idle')
      const [childId, setChildId] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [armed, setArmed] = React.useState(false)
      const armedRef = React.useRef(false)
      const armTimer = React.useRef(null)

      const percent = snapshot?.percent ?? null
      const threshold = snapshot?.threshold ?? 0.85
      const ready = Boolean(snapshot?.ready)
      const level = levelOf(percent ?? 0)

      const handoff = React.useCallback(
        async (manual) => {
          if (!sessionId || phase === 'running') return
          if (!manual && window.localStorage.getItem(autoKey(sessionId))) return
          window.localStorage.setItem(autoKey(sessionId), String(Date.now()))
          setPhase('running')
          setFailure(null)
          try {
            const briefResponse = await fetch(BRIEF_API + '?sessionId=' + encodeURIComponent(sessionId), { cache: 'no-store' })
            const briefPayload = await briefResponse.json()
            if (!briefPayload?.ok || !briefPayload.brief) throw new Error(briefPayload?.error ?? t('error'))
            const sessions = services.sessions
            const uiWorkspace = services.uiWorkspace
            if (!sessions) throw new Error('sessions service unavailable')
            const child = await createChildSession(services, sessionId)
            const reference = sessions.retain(child, { source: 'controllerOperation' })
            try {
              const binding = await reference.ready
              const result = await binding.session.prompt(
                [{ type: 'text', text: buildPrompt(sessionId, briefPayload.brief) }],
                'queue',
              )
              if (result && result.ok === false) throw new Error(result.error?.message ?? 'prompt rejected')
              setChildId(child)
              setPhase('done')
              try {
                uiWorkspace?.openSession?.(child)
              } catch {
                /* navigation is best effort */
              }
            } finally {
              try {
                reference.release?.()
              } catch {
                /* ignore */
              }
            }
          } catch (err) {
            setFailure(String(err?.message ?? err))
            setPhase('failed')
            window.localStorage.removeItem(autoKey(sessionId))
            reload()
          }
        },
        [sessionId, phase, services, t, reload],
      )

      React.useEffect(() => {
        if (!ready || phase !== 'idle' || !sessionId || running) return
        if (window.localStorage.getItem(autoKey(sessionId))) return
        const timer = setTimeout(() => void handoff(false), 1500)
        return () => clearTimeout(timer)
      }, [ready, phase, sessionId, running, handoff])

      const requestHandoff = React.useCallback(() => {
        if (armedRef.current) {
          armedRef.current = false
          setArmed(false)
          if (armTimer.current) clearTimeout(armTimer.current)
          void handoff(true)
          return
        }
        armedRef.current = true
        setArmed(true)
        if (armTimer.current) clearTimeout(armTimer.current)
        armTimer.current = setTimeout(() => {
          armedRef.current = false
          setArmed(false)
        }, 3000)
      }, [handoff])

      React.useEffect(() => () => {
        if (armTimer.current) clearTimeout(armTimer.current)
      }, [])

      if (!sessionId) return null

      const hint = snapshot
        ? [
            t('note', { threshold: Math.round(threshold * 100) }),
          ].join('')
        : t('waiting')

      return h(
        'div',
        { className: 'ch-root', title: hint },
        h(
          'div',
          {
            className: 'ch-pill' + (phase === 'idle' ? ' ch-action' : '') + (armed ? ' ch-armed' : ''),
            role: phase === 'idle' ? 'button' : undefined,
            title: hint + ' · ' + (armed ? t('confirm') : t('manual')),
            onClick: phase === 'idle' ? requestHandoff : undefined,
          },
          h('span', { className: 'ch-dot', 'data-level': level }),
          h('span', null, t('context') + ' ' + (percent === null ? '—' : percent.toFixed(1) + '%')),
          h(
            'span',
            { className: 'ch-meter' },
            h('span', { className: 'ch-meter-fill', 'data-level': level, style: { width: Math.min(100, percent ?? 0) + '%' } }),
          ),
          phase === 'running' ? h('span', { className: 'ch-spinner' }) : null,
          h(
            'span',
            { className: 'ch-state' },
            phase === 'running'
              ? t('handing')
              : phase === 'done'
                ? t('done')
                : ready
                  ? t('ready')
                  : armed
                    ? t('confirm')
                    : '',
          ),
        ),
        phase === 'done' && childId
          ? h(
              'button',
              {
                className: 'ch-link',
                type: 'button',
                onClick: () => {
                  try {
                    services.uiWorkspace?.openSession?.(childId)
                  } catch {
                    /* ignore */
                  }
                },
              },
              t('open'),
            )
          : null,
        phase === 'failed'
          ? h(
              'span',
              { className: 'ch-error' },
              t('error') + (failure ? '：' + failure : ''),
              ' ',
              h('button', { className: 'ch-link', type: 'button', onClick: () => void handoff(true) }, t('retry')),
            )
          : null,
        error && phase === 'idle' ? h('span', { className: 'ch-error' }, t('unavailable')) : null,
      )
    }

    function apply(ctx) {
      const disposers = []
      let translate = null
      try {
        const locale = ctx.get('locale')
        if (locale && typeof locale.register === 'function') {
          for (const id of ['en', 'en-US', 'zh', 'zh-CN']) {
            try {
              disposers.push(locale.register(NS, id, DICT[id.startsWith('zh') ? 'zh' : 'en']))
            } catch {
              /* older locale service */
            }
          }
          if (typeof locale.bind === 'function') translate = locale.bind(NS)
        }
      } catch {
        /* locale is optional */
      }
      const t = makeTranslate(translate)

      const style = document.createElement('style')
      style.setAttribute('data-context-handoff', '')
      style.textContent = CSS
      document.head.appendChild(style)
      disposers.push(() => style.remove())

      const services = {
        get sessions() {
          try {
            return ctx.get('sessions') ?? null
          } catch {
            return null
          }
        },
        get uiWorkspace() {
          try {
            return ctx.get('uiWorkspace') ?? null
          } catch {
            return null
          }
        },
      }

      disposers.push(
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'context-handoff',
              order: 3,
              label: () => t('label'),
            },
            (props) => h(Widget, { ...props, t, services }),
          ),
        ),
      )

      return () => {
        for (const dispose of disposers) {
          try {
            dispose?.()
          } catch {
            /* ignore */
          }
        }
      }
    }

    return { inject: ['slots', 'locale'], apply }
  },
})
