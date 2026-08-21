// claude-provider.js —the `claude` engine for dsh-routed-subagent.
// Wraps @anthropic-ai/claude-agent-sdk's `query` to give external Claude Code
// subagents: background job, kill, model, real-time progress, continuable.
//
//   subagent_routed(engine='claude', model=..., prompt=..., continuable=true)
//   ├─ claudeProvider.start(request)  (one-shot: foreground/background)
//   ├─ claudeProvider.prepareContinuable(request) →{ seed, sessionId, resume }
//        registered via registerExternalContinuation so send_message(...) resumes it.
// The Claude Code SDK is an OPTIONAL dependency: it is loaded lazily on the
// first `engine='claude'` dispatch, so the plugin (and the codex/codebuddy
// engines) work without it installed. Install it globally with:
//   npm install -g @anthropic-ai/claude-agent-sdk
let _sdkQuery = null
async function sdkQuery() {
  if (_sdkQuery) return _sdkQuery
  try {
    const mod = await import('@anthropic-ai/claude-agent-sdk')
    _sdkQuery = mod.query
  } catch (e) {
    throw new Error(`claude engine requires '@anthropic-ai/claude-agent-sdk' (npm install -g @anthropic-ai/claude-agent-sdk): ${e.message}`)
  }
  return _sdkQuery
}
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'

// Reuse the official provider's resolveChildCwd + scan-safe env scrub via dsh-subprocess.
import { resolveChildCwd } from '@deepseek-ai/dsh-subagent'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'

const PERMISSION_MODES = ['dontAsk', 'acceptEdits', 'auto', 'plan', 'bypassPermissions']
const DEFAULT_PERMISSION_MODE = 'dontAsk'

function textTask(prompt) {
  if (!Array.isArray(prompt) || prompt.length === 0) throw new Error('claude-provider: prompt must be a non-empty text block list')
  const texts = []
  for (const b of prompt) {
    if (b.type !== 'text') throw new Error('claude-provider: one-shot task must contain only text blocks')
    texts.push(b.text)
  }
  return texts.join('')
}

/**
 * Minimal scan-safe parent env overlay (default: no inherited credentials).
 * Extra env can be supplied through config.env.
 */
function buildEnv(extra) {
  return { ...scrubbedParentEnv(), ...(extra ?? {}) }
}

export class ClaudeEngineProvider {
  constructor(name, ctx, config = {}) {
    this.name = name
    this.ctx = ctx
    this.config = config
    this.capabilities = Object.freeze({ outputSchema: false, depthLimit: false, toolFilter: false, persona: false })
    this.inheritsParentContext = false
  }

  /** Build the SDK query options with every requested capability. */
  _sdkOptions(request, controller, capture, spec) {
    const { model, max_turns, permission_mode, cwd, env, sessionId, resume, includePartial } = request
    const opts = {
      abortController: controller,
      cwd,
      env: buildEnv(env),
      permissionMode: permission_mode ?? DEFAULT_PERMISSION_MODE,
      ...(model !== undefined ? { model } : {}),
      ...(max_turns !== undefined ? { maxTurns: max_turns } : {}),
      ...(includePartial === false ? {} : { includePartialMessages: true }),
      ...(resume !== undefined ? { resume } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      persistSession: true, // needed for continuable (resume later)
      onElicitation: () => Promise.resolve({ action: 'decline' }),
      onUserDialog: () => Promise.resolve({ behavior: 'cancelled' }),
      canUseTool: () => Promise.resolve({ behavior: 'deny', message: 'unattended claude engine cannot prompt for approval' }),
      // NOTE: no spawnClaudeCodeProcess — let the SDK spawn the real `claude`
      // CLI itself (its built-in spawnLocalProcess manages stdin/stdout/kill).
    }
    return opts
  }

  /** One-shot start (foreground or background via the common run layer). */
  async start(request) {
    const parentCwd = request.parent.session?.header?.cwd
    if (parentCwd === undefined) throw new Error('claude-provider: no working directory —delegate from a parent session')
    const cwd = resolveChildCwd('claude-provider', this.config.cwd, parentCwd)
    const controller = new AbortController()
    const capture = () => {} // progress/diagnostic callback seat (extend per-run via progress buffer)
    let spec = { disposeGraceMs: 3000 }

    const texts = textTask(request.prompt)
    if (request.signal.aborted) throw new Error('claude-provider: aborted before startup')

    const q = (await sdkQuery())({
      prompt: texts,
      options: this._sdkOptions({ ...request, cwd }, controller, capture, spec),
    })

    // Consume the async iterable →progress text + terminal result.
    const progress = { text: '' }
    const collect = (stage) => {
      const m = typeof stage === 'string' ? stage : ''
      if (m) progress.text = m.slice(-4000)
    }

    const resultPromise = (async () => {
      let final = null
      let sawResult = false
      try {
        for await (const m of q) {
          if (m.type === 'result') {
            sawResult = true
            if (m.subtype === 'success') { final = m.result; break }
            throw new Error(`claude-provider: run failed (${m.subtype})`)
          } else if (m.type === 'assistant' && typeof m.message?.content === 'string') {
            collect(m.message.content)
          } else if (m.type === 'stream_event' && typeof m.event?.content === 'string') {
            collect(m.event.content)
          }
        }
      } catch (e) {
        // flatten per seam contract
        return { output: progress.text ? [{ type: 'text', text: progress.text }] : [], stopReason: controller.signal.aborted ? 'aborted' : 'error' }
      }
      if (!sawResult) {
        if (controller.signal.aborted) return { output: progress.text ? [{ type: 'text', text: progress.text }] : [], stopReason: 'aborted' }
        return { output: progress.text ? [{ type: 'text', text: progress.text }] : [], stopReason: 'error' }
      }
      return { output: final && final.trim() ? [{ type: 'text', text: final }] : (progress.text ? [{ type: 'text', text: progress.text }] : []), stopReason: 'completed' }
    })()

    const dispose = async () => {
      if (!controller.signal.aborted) controller.abort(new Error('claude-provider: run disposed'))
      try { q.close() } catch {}
      await resultPromise.catch(() => {})
    }

    return {
      id: SessionId(randomUUID()),
      localAgent: undefined,
      readOutput: () => progress.text || 'running...',
      result: resultPromise,
      dispose,
    }
  }

  /**
   * Continuable: persist the SDK session and register a resume callback so
   * `send_message(sessionId, ...)` routes back here (via the continuation patch).
   * We start the session with the initial prompt so the session exists on disk;
   * subsequent resume(sessionId, ...) calls add follow-up turns.
   */
  async prepareContinuable(request) {
    const parentCwd = request.parent.session?.header?.cwd
    const cwd = resolveChildCwd('claude-provider', this.config.cwd, parentCwd)
    const sessionId = request.sessionId ?? randomUUID()
    const texts = textTask(request.prompt)
    // Start the initial turn so the SDK session is created on disk. The output
    // is stored for later; the subagent's final output is surfaced by the tool.
    const controller = new AbortController()
    const q = (await sdkQuery())({
      prompt: texts,
      options: {
        ...this._sdkOptions({ cwd, sessionId }, controller, () => {}, { disposeGraceMs: 3000 }),
        // no `resume` — first turn, SDK creates the session under `sessionId`
      },
    })
    const initOutput = { text: '' }
    for await (const m of q) {
      if (m.type === 'result' && m.subtype === 'success') break
      else if (m.type === 'assistant' && typeof m.message?.content === 'string') initOutput.text = m.message.content.slice(-4000)
    }
    try { q.close() } catch {}
    const resume = (content, signal) => this._resume(sessionId, cwd, content, signal)
    return { seed: [], sessionId, resume, initialOutput: initOutput.text }
  }

  /** Internal: resume a persisted SDK session with a follow-up turn. */
  async _resume(sessionId, cwd, content, signal) {
    const controller = new AbortController()
    const texts = Array.isArray(content) ? content.map((b) => b?.text ?? '').join('\n') : String(content)
    const progress = { text: '' }
    const q = (await sdkQuery())({
      prompt: [texts],
      options: this._sdkOptions({ cwd, resume: sessionId }, controller, () => {}, { disposeGraceMs: 3000 }),
    })
    let final = null
    for await (const m of q) {
      if (m.type === 'result' && m.subtype === 'success') { final = m.result; break }
      else if (m.type === 'assistant' && typeof m.message?.content === 'string') progress.text = m.message.content.slice(-4000)
      else if (m.type === 'stream_event' && typeof m.event?.content === 'string') progress.text = m.event.content.slice(-4000)
    }
    try { q.close() } catch {}
    return { output: final && final.trim() ? [{ type: 'text', text: final }] : [], stopReason: 'completed' }
  }
}
