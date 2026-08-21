// codex-provider.js — the `codex` engine for dsh-routed-subagent.
// Wraps the OpenAI Codex CLI's `app-server --stdio` RPC protocol so a Codex CLI
// process can be driven as an external subagent with:
//   ① background job  ② real-time progress (process event stream)
//   ③ kill (turn/interrupt + process dispose)  ④ explicit model (thread/start)
//   ⑤ continuable (thread is persisted on disk; resume = same thread + new turn on it)
//
// Protocol notes (verified against codex-cli 0.148.0):
//   - transport: newline-delimited JSON-RPC over stdin/stdout
//   - initialize        -> { userAgent, codexHome, platformFamily, platformOs }
//   - thread/start      -> { thread: { id, sessionId, path(jsonl!) }, model, ... }
//                          (  model: string — explicit model selection            )
//   - turn/start        -> { turn: { id, status } }  (threadId + input[{type:'text',text}])
//   - turn/interrupt    -> {}   (kills the running turn)
//   - notifications: thread/started, item/started, item/agentMessage/delta,
//                    item/completed, turn/completed(status=completed|interrupted),
//                    turn/failed, thread/tokenUsage/updated
import { spawn, execSync } from 'node:child_process'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { resolveChildCwd } from '@deepseek-ai/dsh-subagent'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

// ── codex CLI entry-point discovery ──────────────────────────────────────
// The `codex` command in PATH is usually a .cmd/.ps1 shim that a bare spawn()
// cannot run on Windows with shell:false. Resolve the real node entry:
//   1) $CODEX_BIN env override  2) npm global root  3) roaming-npm global.
// Return the NODE script (..bin/codex.js) — it must be run with node as the
// interpreter (spawning the native ..codex.exe directly is unreliable on Win).
function defaultCodexBin() {
  try { if (process.env.CODEX_BIN) return process.env.CODEX_BIN } catch {}
  const candidates = []
  // `npm root -g` gives the global node_modules root (e.g. .../AppData/Roaming/npm/node_modules)
  let root = ''
  try { root = execSync('npm root -g', { encoding: 'utf8', shell: 'cmd.exe' }).trim() } catch {}
  if (root) candidates.push(join(root, '@openai', 'codex', 'bin', 'codex.js'))
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'))
  for (const c of candidates) if (existsSync(c)) return c
  return 'codex'
}

const MAX_PROGRESS_CHARS = 20000

/** Minimal newline-delimited JSON-RPC client over a codex app-server child. */
class CodexAppServerWire {
  constructor() {
    this.child = null
    this._inflight = new Map()
    this._id = 0
    this._buf = ''
    this._notifyListeners = new Set()
    this._exitListeners = new Set()
    this.diagnostics = []
    this._initialized = false
  }

  _spawn(bin, cwd, env) {
    // `bin` may be (a) a native executable (..codex.exe -> spawn directly) or
    // (b) a node script (..bin/codex.js -> needs node as interpreter).
    const isNative = /\.(exe|bat|cmd|ps1)$/i.test(bin)
    const args = ['app-server', '--stdio']
    let child
    try {
      child = spawn(isNative ? bin : process.execPath, isNative ? args : [bin, ...args], {
        cwd,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (e) {
      throw new Error(`codex-provider: failed to spawn app-server (bin=${bin}): ${e.message}`)
    }
    this.child = child
    this.child.stdin.on('error', () => {})
    this.child.stderr.on('data', (d) => { this.diagnostics.push(d.toString().slice(-4000)) })
    this.child.stdout.on('data', (d) => this._onData(d.toString()))
    this.child.on('error', (e) => this._failAll(e))
    this.child.on('exit', (code, sig) => {
      this._failAll(new Error(`codex app-server exited (code=${code} signal=${sig})`))
    })
  }

  _onData(text) {
    this._buf += text
    let idx
    while ((idx = this._buf.indexOf('\n')) >= 0) {
      const line = this._buf.slice(0, idx)
      this._buf = this._buf.slice(idx + 1)
      if (!line.trim()) continue
      let obj
      try { obj = JSON.parse(line) } catch { continue }
      if (obj.id !== undefined && this._inflight.has(obj.id)) {
        const { resolve, reject } = this._inflight.get(obj.id)
        this._inflight.delete(obj.id)
        if (obj.error) reject(new Error(`codex ${obj.error.code ?? ''} ${obj.error.message ?? 'error'}`.trim()))
        else resolve(obj.result)
      } else if (obj.method) {
        for (const fn of this._notifyListeners) { try { fn(obj) } catch {} }
      }
    }
  }

  _failAll(e) {
    for (const { reject } of this._inflight.values()) reject(e)
    this._inflight.clear()
  }

  onNotify(fn) { this._notifyListeners.add(fn); return () => this._notifyListeners.delete(fn) }

  /** Register a callback fired when this wire is disposed (run end / kill). */
  onExit(fn) { this._exitListeners.add(fn); return () => this._exitListeners.delete(fn) }

  /** Spawn + initialize. Idempotent-ish: respawns if the child died. */
  async ensure(bin, cwd, env) {
    if (!this.child || this.child.exitCode !== null || this.child.killed) {
      this._spawn(bin, cwd, env)
      this._initialized = false
      // wait for the socket to be writable
      await new Promise((res) => {
        this.child.stdin.once('open', res)
        setTimeout(res, 1500)
      })
    }
    // only initialize once per spawned child
    if (this._initialized) return { ok: true }
    if (this.child.killed || this.child.exitCode !== null) throw new Error('codex app-server exited before initialize')
    const init = await this.request('initialize', {
      capabilities: {},
      clientInfo: { name: 'dsh-routed-subagent', version: '0.3.0' },
    })
    this._initialized = true
    return init
  }

  request(method, params = {}) {
    if (!this.child || this.child.stdin.destroyed || this.child.exitCode !== null) {
      return Promise.reject(new Error('codex app-server not running'))
    }
    const id = ++this._id
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
    return new Promise((resolve, reject) => {
      this._inflight.set(id, { resolve, reject })
      this.child.stdin.write(payload, (err) => {
        if (err) { if (this._inflight.delete(id)) reject(err) }
      })
    })
  }

  async dispose() {
    if (!this.child) return
    const child = this.child
    // settle the waiter first: anyone awaiting notifications must resolve/reject
    // immediately instead of hanging until the 5-min timeout.
    for (const fn of this._exitListeners) { try { fn() } catch {} }
    this._exitListeners.clear()
    try { child.kill('SIGTERM') } catch {}
    try {
      await new Promise((res) => {
        const to = setTimeout(() => {
          try { child.kill('SIGKILL') } catch {}
          // SIGKILL on Windows is forceful; give the OS a beat to reap it.
          setTimeout(res, 300)
        }, 1200)
        child.once('exit', () => { clearTimeout(to); res() })
      })
    } catch {}
    this.child = null
  }
}

// ── engine provider ──────────────────────────────────────────────────────
// codex config.toml `approval_policy` valid variants:
const PERMISSION_MODES = ['untrusted', 'on-failure', 'on-request', 'granular', 'never']

export class CodexEngineProvider {
  constructor(name, ctx, config = {}) {
    this.name = name
    this.ctx = ctx
    this.config = config
    this.capabilities = Object.freeze({ outputSchema: false, depthLimit: false, toolFilter: false, persona: false })
    this.inheritsParentContext = false
    this._wires = new Set() // every live per-run wire (for provider-level teardown)
  }

  _bin() { return this.config.codexBin ?? process.env.CODEX_BIN ?? defaultCodexBin() }

  _env() { return { ...scrubbedParentEnv(), ...(this.config.env ?? {}) } }

  /**
   * Create a DEDICATED app-server wire for ONE run (process isolation).
   * NOT shared: codex notifications for `item/agentMessage/delta` carry no
   * turn/thread id, so a shared wire would leak every run's deltas into every
   * listener (mixed output). Each run spawns its own process and kills it on
   * dispose — parallel runs are fully isolated, and no orphan survives.
   */
  async _newWire(env) {
    const wire = new CodexAppServerWire()
    this._wires.add(wire)
    try {
      await wire.ensure(this._bin(), this.config.cwd ?? process.cwd(), env ?? this._env())
    } catch (e) {
      this._wires.delete(wire)
      try { await wire.dispose() } catch {}
      throw e
    }
    return wire
  }

  _dropWire(wire) {
    this._wires.delete(wire)
  }

  /** Per-run progress buffer (never shared across runs). */
  _newProgress() {
    const buf = []
    const push = (s) => {
      if (!s) return
      buf.push(s)
      const joined = buf.join('')
      if (joined.length > MAX_PROGRESS_CHARS) {
        buf.length = 0
        buf.push(joined.slice(-MAX_PROGRESS_CHARS))
      }
    }
    return { buf, push, text: () => buf.join('') }
  }

  /** Provider-level teardown: kill every live wire (running runs included). */
  async dispose() {
    const wires = [...this._wires]
    this._wires.clear()
    await Promise.allSettled(wires.map((w) => w.dispose()))
  }

  /** Build a fresh thread (optionally with an explicit model) and start a turn. */
  async _startThreadTurn(wire, { cwd, model, text, permissionMode }) {
    const cfg = {}
    // Unattended external engine: never prompt the user for tool approval.
    cfg.approval_policy = 'never'
    if (permissionMode) cfg.approval_policy = permissionMode
    const threadRes = await wire.request('thread/start', {
      workspace: cwd,
      cwd,
      model: model ?? undefined, // explicit model selection (verified picks it up)
      config: cfg,
      customInstructions: [],
      isHidden: true,
    })
    const threadId = threadRes?.thread?.id
    if (!threadId) throw new Error(`codex-provider: thread/start returned no thread id — ${JSON.stringify(threadRes).slice(0,300)}`)
    const turnRes = await wire.request('turn/start', {
      threadId,
      input: [{ type: 'text', text }],
      silent: true,
    })
    const turnId = turnRes?.turn?.id
    if (!turnId) throw new Error(`codex-provider: turn/start returned no turn id — ${JSON.stringify(turnRes).slice(0,300)}`)
    return { threadId, turnId }
  }

  /** One-shot start (foreground or background via the common run layer). */
  async start(request) {
    if (request.signal?.aborted) throw new Error('codex-provider: aborted before startup')
    const parentCwd = request.parent?.session?.header?.cwd
    if (parentCwd === undefined) throw new Error('codex-provider: no working directory — delegate from a parent session')
    const cwd = resolveChildCwd('codex-provider', this.config.cwd, parentCwd)
    const text = codexInputText(request.prompt)
    // Per-run process + per-run progress: full isolation from other runs.
    const wire = await this._newWire()
    const progress = this._newProgress()
    let wireDead = false
    const disposeWire = async () => {
      if (wireDead) return
      wireDead = true
      this._dropWire(wire)
      try { await wire.dispose() } catch {}
    }

    let threadId = null
    let turnId = null
    let aborted = false

    const started = this._startThreadTurn(wire, {
      cwd, model: request.model, text,
      permissionMode: normalizePermissionMode(request.permission_mode),
    }).catch((e) => { throw e })

    const resultPromise = (async () => {
      try {
        const { threadId: tid, turnId: tun } = await started
        threadId = tid; turnId = tun
        return await this._awaitTurnInternal(wire, tid, tun, () => aborted, progress)
      } finally {
        await disposeWire()
      }
    })()

    const kill = async () => {
      aborted = true
      if (threadId && turnId) {
        try { await wire.request('turn/interrupt', { threadId, turnId }) } catch {}
      }
      await disposeWire()
    }

    // If the parent signal is aborted, trigger interrupt
    if (request.signal) {
      request.signal.addEventListener('abort', () => kill(), { once: true })
    }

    return {
      id: SessionId(randomUUID()),
      localAgent: undefined,
      readOutput: () => progress.text() || 'starting…',
      result: resultPromise,
      dispose: kill,
    }
  }

  _awaitTurnInternal(wire, threadId, turnId, abortedFn, progress) {
    return new Promise((resolve, reject) => {
      let final = ''
      let timer = null
      let settled = false
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        off(); offExit(); if (timer) clearTimeout(timer)
        fn(value)
      }
      const off = wire.onNotify((msg) => {
        const p = msg.params ?? {}
        const m = msg.method
        // Best-effort turn/thread isolation. NOTE: codex's delta notifications
        // carry NO turn/thread id, so this cannot fully isolate on a SHARED
        // wire — that is why each run now owns its own wire (process level).
        const msgThreadId = p.threadId ?? p.thread?.id
        if (msgThreadId && msgThreadId !== threadId) return
        const msgTurnId = p.turnId ?? p.turn?.id
        if (msgTurnId && msgTurnId !== turnId) return
        if (m === 'item/agentMessage/delta' && typeof p.delta === 'string') {
          progress.push(p.delta); final += p.delta
        } else if (m === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') {
          progress.push(p.item.text); final = p.item.text
        } else if (m === 'turn/completed') {
          const status = p.turn?.status ?? p.status
          const text = (final || extractAgentText(p.turn?.items) || progress.text()).slice(-16000)
          settle(resolve, {
            threadId, turnId,
            output: text ? [{ type: 'text', text }] : [],
            stopReason: status === 'interrupted' ? (abortedFn() ? 'aborted' : 'interrupted') : 'completed',
          })
        } else if (m === 'turn/failed') {
          settle(reject, new Error(`codex-provider: turn failed — ${p.turn?.error?.message ?? p.error?.message ?? 'no detail'}`))
        }
      })
      // If the wire is disposed mid-turn (kill / teardown), settle immediately
      // as aborted instead of hanging until the 5-minute timeout.
      const offExit = wire.onExit(() => {
        const text = (final || progress.text()).slice(-16000)
        settle(resolve, {
          threadId, turnId,
          output: text ? [{ type: 'text', text }] : [],
          stopReason: abortedFn() ? 'aborted' : 'interrupted',
        })
      })
      timer = setTimeout(() => settle(reject, new Error('codex-provider: timed out waiting for turn/completed')), 300000)
    })
  }

  /** Continuable: codex thread is persisted on disk; resume = same thread, new turn. */
  async prepareContinuable(request) {
    const parentCwd = request.parent?.session?.header?.cwd
    const cwd = resolveChildCwd('codex-provider', this.config.cwd, parentCwd)
    const wire = await this._newWire()
    // Start a fresh persisted thread now so there is a real sessionId to resume.
    const threadRes = await wire.request('thread/start', {
      workspace: cwd, cwd,
      model: request.model ?? undefined,
      config: {}, customInstructions: [], isHidden: true,
    })
    const threadId = threadRes?.thread?.id
    const sessionId = request.sessionId ?? `codex:${threadId}`
    const resume = (content, signal) => this._resume(threadId, cwd, content, signal)
    this._dropWire(wire)
    await wire.dispose() // thread is persisted on disk; the wire is only needed for creation
    return { seed: [], sessionId, resume }
  }

  async _resume(threadId, cwd, content, signal) {
    const wire = await this._newWire()
    const progress = this._newProgress()
    let wireDead = false
    let aborted = false
    const disposeWire = async () => {
      if (wireDead) return
      wireDead = true
      this._dropWire(wire)
      try { await wire.dispose() } catch {}
    }
    const kill = async () => {
      aborted = true
      if (turnId) {
        try { await wire.request('turn/interrupt', { threadId, turnId }) } catch {}
      }
      await disposeWire()
    }
    let turnId = null
    if (signal) {
      signal.addEventListener('abort', () => kill(), { once: true })
    }
    const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.map((c) => c?.text ?? '').join('\n') : String(content ?? ''))
    try {
      const turnRes = await wire.request('turn/start', {
        threadId, input: [{ type: 'text', text }], silent: true,
      })
      turnId = turnRes?.turn?.id
      const done = await this._awaitTurnInternal(wire, threadId, turnId, () => aborted || (signal?.aborted ?? false), progress)
      return { output: done.output, stopReason: done.stopReason }
    } finally {
      await disposeWire()
    }
  }
}

function extractAgentText(items) {
  if (!Array.isArray(items)) return ''
  for (const it of items) {
    if (it?.type === 'agentMessage' && typeof it?.text === 'string' && it.text.trim()) return it.text
    if (Array.isArray(it?.content)) {
      for (const b of it.content) if (b?.type === 'text' && typeof b?.text === 'string' && b.text.trim()) return b.text
    }
  }
  return ''
}

function codexInputText(prompt) {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return String(prompt ?? '')
  return prompt.map((b) => b?.text ?? '').filter(Boolean).join('\n')
}

function normalizePermissionMode(mode) {
  return PERMISSION_MODES.includes(mode) ? mode : undefined
}
