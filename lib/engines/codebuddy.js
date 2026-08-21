// codebuddy-provider.js — the `codebuddy` engine for dsh-routed-subagent.
// Drives the Tencent CodeBuddy Code CLI (`codebuddy --print --output-format
// stream-json`) as an external subagent with:
//   ① background job  ② real-time progress (NDJSON stream events)
//   ③ kill (process termination)  ④ explicit model (--model)
//   ⑤ continuable (--session-id first, --resume <uuid> follow-up)
//
// Streaming shape (verified against codebuddy-cli 2.127.2):
//   spawn: node <bin> --print --output-format stream-json --include-partial-messages \
//          --dangerously-skip-permissions [--model M] [--session-id U|--resume U] <prompt>
//   stdout = one JSON object per line:
//     { type:'system' } ...
//     { type:'stream_event', event:{type:'content_block_delta', delta:{type:'text_delta', text}}}  live text
//     { type:'assistant', message }  assembled
//     { type:'result', subtype:'success', result, session_id }  terminal
import { spawn, execSync } from 'node:child_process'
import { SessionId } from '@deepseek-ai/dsh-session'
import { randomUUID } from 'node:crypto'
import { resolveChildCwd } from '@deepseek-ai/dsh-subagent'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const MAX_PROGRESS_CHARS = 20000

// ── codebuddy CLI entry-point discovery ─────────────────────────────────
function defaultCodebuddyBin() {
  try { if (process.env.CODEBUDDY_BIN) return process.env.CODEBUDDY_BIN } catch {}
  const candidates = []
  if (process.env.APPDATA) candidates.push(join(process.env.APPDATA, 'npm', 'node_modules', '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'))
  try {
    const root = execSync('npm root -g', { encoding: 'utf8', shell: 'cmd.exe' }).trim()
    if (root) candidates.push(join(root, '@tencent-ai', 'codebuddy-code', 'bin', 'codebuddy'))
  } catch {}
  for (const c of candidates) if (existsSync(c)) return c
  return 'codebuddy'
}

export class CodebuddyEngineProvider {
  constructor(name, ctx, config = {}) {
    this.name = name
    this.ctx = ctx
    this.config = config
    this.capabilities = Object.freeze({ outputSchema: false, depthLimit: false, toolFilter: false, persona: false })
    this.inheritsParentContext = false
    this._progress = []
  }

  _bin() { return this.config.codebuddyBin ?? process.env.CODEBUDDY_BIN ?? defaultCodebuddyBin() }

  /** model used when the request doesn't specify one (codebuddy has no sane default). */
  _defaultModel() { return this.config.codebuddyModel ?? process.env.CODEBUDDY_MODEL ?? 'hy3' }

  _env() { return { ...scrubbedParentEnv(), ...(this.config.env ?? {}) } }

  _pushProgress(s) {
    if (!s) return
    this._progress.push(s)
    const joined = this._progress.join('')
    if (joined.length > MAX_PROGRESS_CHARS) this._progress = [joined.slice(-MAX_PROGRESS_CHARS)]
  }

  _clearProgress() { this._progress = [] }

  /** Spawn one codebuddy print session with the given flags + prompt. */
  _spawn({ model, sessionId, resume, cwd, prompt }) {
    const args = [
      '--print',
      '--output-format', 'stream-json',
      '--include-partial-messages',
      '--dangerously-skip-permissions',
    ]
    if (model) args.push('--model', model)
    if (sessionId) args.push('--session-id', sessionId)
    if (resume) args.push('--resume', resume)
    args.push(prompt) // positional prompt; spoof-safe via spawn array args

    const bin = this._bin()
    const isNative = /\.(exe|bat|cmd|ps1)$/i.test(bin)
    const [cmd, cargs] = isNative ? [bin, args] : [process.execPath, [bin, ...args]]
    return spawn(cmd, cargs, {
      cwd,
      env: this._env(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }

  /**
   * Run one turnaround and stream NDJSON to progress/result.
   * Resolves `result` ({ output, stopReason, sessionId }) when `result` event
   * arrives or when the process closes. Kill is exposed separately.
   */
  _run(cwd, prompt, { model, sessionId, resume, signal }) {
    const child = this._spawn({ model, sessionId, resume, cwd, prompt })
    let buf = ''
    let aborted = false
    let killFn = () => { try { child.kill('SIGKILL') } catch {} }

    const resultPromise = new Promise((resolve, reject) => {
      let settled = false
      const settle = (val) => { if (!settled) { settled = true; resolve(val) } }
      child.stdout.on('data', (d) => {
        buf += d.toString()
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1)
          if (!line.trim()) continue
          let obj
          try { obj = JSON.parse(line) } catch { continue }
          if (!obj || typeof obj !== 'object') continue
          const t = obj.type
          if (t === 'stream_event') {
            const ev = obj.event
            if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && typeof ev.delta.text === 'string') {
              this._pushProgress(ev.delta.text)
            }
          } else if (t === 'result') {
            const text = typeof obj.result === 'string' ? obj.result : ''
            settle({
              output: text ? [{ type: 'text', text: text.slice(-16000) }] : [],
              sessionId: obj.session_id,
              stopReason: obj.subtype === 'success' ? 'completed' : 'error',
            })
          }
        }
      })
      child.on('close', () => {
        settle({
          output: this._progress.join('') ? [{ type: 'text', text: this._progress.join('').slice(-16000) }] : [],
          stopReason: aborted ? 'aborted' : 'error',
        })
      })
      child.on('error', (e) => { if (!settled) { settled = true; reject(e) } })

      const kill = () => {
        aborted = true
        try { child.kill('SIGTERM') } catch {}
        setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 1500)
      }
      if (signal) {
        if (signal.aborted) kill()
        signal.addEventListener('abort', kill, { once: true })
      }
      killFn = kill
    })

    return {
      child,
      result: resultPromise,
      kill: () => killFn(),
    }
  }

  /** One-shot start (foreground or background via the common run layer). */
  async start(request) {
    if (request.signal?.aborted) throw new Error('codebuddy-provider: aborted before startup')
    const parentCwd = request.parent?.session?.header?.cwd
    if (parentCwd === undefined) throw new Error('codebuddy-provider: no working directory — delegate from a parent session')
    const cwd = resolveChildCwd('codebuddy-provider', this.config.cwd, parentCwd)
    const text = codebuddyInputText(request.prompt)
    this._clearProgress()
    const run = this._run(cwd, text, {
      model: request.model ?? this._defaultModel(),
      sessionId: undefined,
      resume: undefined,
      signal: request.signal,
    })
    return {
      id: SessionId(randomUUID()),
      localAgent: undefined,
      readOutput: () => this._progress.join('') || 'starting…',
      result: run.result,
      dispose: run.kill,
    }
  }

  /** Continuable: session persists under a client UUID; resume = new turn. */
  async prepareContinuable(request) {
    const parentCwd = request.parent?.session?.header?.cwd
    const cwd = resolveChildCwd('codebuddy-provider', this.config.cwd, parentCwd)
    const sessionId = request.sessionId ?? randomUUID()
    // Create the session on disk with the initial prompt under this UUID so the
    // later `--resume <uuid>` actually finds it (mirrors probe-cb4 flow).
    const text = codebuddyInputText(request.prompt)
    this._clearProgress()
    await this._run(cwd, text, {
      model: request.model ?? this._defaultModel(),
      sessionId,
      resume: undefined,
      signal: request.signal,
    }).result
    const resume = (content, signal) => this._resume(sessionId, cwd, content, signal)
    return { seed: [], sessionId, resume }
  }

  /** Internal: resume a persisted session with a follow-up turn. */
  async _resume(sessionId, cwd, content, signal) {
    this._clearProgress()
    const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.map((c) => c?.text ?? '').join('\n') : String(content ?? ''))
    const run = this._run(cwd, text, { model: this._defaultModel(), sessionId: undefined, resume: sessionId, signal })
    const result = await run.result
    return { output: result.output ?? [], stopReason: result.stopReason ?? 'completed' }
  }
}

function codebuddyInputText(prompt) {
  if (typeof prompt === 'string') return prompt
  if (!Array.isArray(prompt)) return String(prompt ?? '')
  return prompt.map((b) => b?.text ?? '').filter(Boolean).join('\n')
}
