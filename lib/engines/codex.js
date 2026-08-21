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
    this.diagnostics = []
    this._initialized = false
  }

  _spawn(bin, cwd, env) {
    // `bin` may be (a) a native executable (..codex.exe -> spawn directly) or
    // (b) a node script (..bin/codex.js -> needs node as interpreter).
    const isNative = /\.(exe|bat|cmd|ps1)$/i.test(bin)
    const args = ['app-server', '--stdio']
    const child = spawn(isNative ? bin : process.execPath, isNative ? args : [bin, ...args], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
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
    try { this.child.kill('SIGTERM') } catch {}
    try {
      await new Promise((res) => {
        const to = setTimeout(() => { try { this.child.kill('SIGKILL') } catch {}; res() }, 1200)
        this.child.once('exit', () => { clearTimeout(to); res() })
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
    this._wire = null
    this._progress = []
  }

  _bin() { return this.config.codexBin ?? process.env.CODEX_BIN ?? defaultCodexBin() }

  _env() { return { ...scrubbedParentEnv(), ...(this.config.env ?? {}) } }

  _pushProgress(s) {
    if (!s) return
    this._progress.push(s)
    const joined = this._progress.join('')
    if (joined.length > MAX_PROGRESS_CHARS) {
      this._progress = [joined.slice(-MAX_PROGRESS_CHARS)]
    }
  }

  _clearProgress() { this._progress = [] }

  /** Get a shared lazy app-server wire (one process for the provider lifetime). */
  async _getWire(env) {
    if (!this._wire) this._wire = new CodexAppServerWire()
    await this._wire.ensure(this._bin(), this.config.cwd ?? process.cwd(), env ?? this._env())
    return this._wire
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
    this._clearProgress()
    const wire = await this._getWire()

    let threadId = null
    let turnId = null
    let aborted = false

    const started = this._startThreadTurn(wire, {
      cwd, model: request.model, text,
      permissionMode: normalizePermissionMode(request.permission_mode),
    }).catch((e) => { throw e })

    const resultPromise = (async () => {
      const { threadId: tid, turnId: tun } = await started
      threadId = tid; turnId = tun
      return this._awaitTurnInternal(wire, tid, tun, () => aborted)
    })()

    const kill = async () => {
      aborted = true
      if (threadId && turnId) {
        try { await wire.request('turn/interrupt', { threadId, turnId }) } catch {}
      }
    }

    // If the parent signal is aborted, trigger interrupt
    if (request.signal) {
      request.signal.addEventListener('abort', () => kill(), { once: true })
    }

    return {
      id: SessionId(randomUUID()),
      localAgent: undefined,
      readOutput: () => this._progress.join('') || 'starting…',
      result: resultPromise,
      dispose: kill,
    }
  }

  _awaitTurnInternal(wire, threadId, turnId, abortedFn) {
    return new Promise((resolve, reject) => {
      let final = ''
      let timer = null
      const off = wire.onNotify((msg) => {
        const p = msg.params ?? {}
        const m = msg.method
        if (p.turnId && p.turnId !== turnId) return
        if (m === 'item/agentMessage/delta' && typeof p.delta === 'string') {
          this._pushProgress(p.delta); final += p.delta
        } else if (m === 'item/completed' && p.item?.type === 'agentMessage' && typeof p.item.text === 'string') {
          this._pushProgress(p.item.text); final = p.item.text
        } else if (m === 'turn/completed') {
          off(); if (timer) clearTimeout(timer)
          const status = p.turn?.status
          const text = (final || extractAgentText(p.turn?.items) || this._progress.join('')).slice(-16000)
          resolve({
            threadId, turnId,
            output: text ? [{ type: 'text', text }] : [],
            stopReason: status === 'interrupted' ? (abortedFn() ? 'aborted' : 'interrupted') : 'completed',
          })
        } else if (m === 'turn/failed') {
          off(); if (timer) clearTimeout(timer)
          reject(new Error(`codex-provider: turn failed — ${p.turn?.error?.message ?? p.error?.message ?? 'no detail'}`))
        }
      })
      timer = setTimeout(() => { off(); reject(new Error('codex-provider: timed out waiting for turn/completed')) }, 300000)
    })
  }

  /** Continuable: codex thread is persisted on disk; resume = same thread, new turn. */
  async prepareContinuable(request) {
    const parentCwd = request.parent?.session?.header?.cwd
    const cwd = resolveChildCwd('codex-provider', this.config.cwd, parentCwd)
    const wire = await this._getWire()
    // Start a fresh persisted thread now so there is a real sessionId to resume.
    const threadRes = await wire.request('thread/start', {
      workspace: cwd, cwd,
      model: request.model ?? undefined,
      config: {}, customInstructions: [], isHidden: true,
    })
    const threadId = threadRes?.thread?.id
    const sessionId = request.sessionId ?? `codex:${threadId}`
    const resume = (content, signal) => this._resume(threadId, cwd, content, signal)
    return { seed: [], sessionId, resume }
  }

  async _resume(threadId, cwd, content, signal) {
    const wire = await this._getWire()
    this._clearProgress()
    const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.map((c) => c?.text ?? '').join('\n') : String(content ?? ''))
    const turnRes = await wire.request('turn/start', {
      threadId, input: [{ type: 'text', text }], silent: true,
    })
    const turnId = turnRes?.turn?.id
    const done = await this._awaitTurnInternal(wire, threadId, turnId, () => signal?.aborted ?? false)
    return { output: done.output, stopReason: done.stopReason }
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
