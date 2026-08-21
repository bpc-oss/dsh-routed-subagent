/**
 * dsh-routed-subagent: run a subagent FULLY mounted on a chosen agent preset,
 * from ANY session that mounts this plugin row, with per-call model routing.
 *
 * WHY THIS IS DIFFERENT FROM THE STOCK SUBAGENT TOOLS
 * ---------------------------------------------------
 * The stock subagent tools force children to JOIN the PARENT's preset
 * (`composeFrom` inside the child setup window). This plugin instead drives
 * the child creation itself with an ASYNC setup that awaits
 * `agentPresets.mount(childCtx, <preset>)` — the child's scope chain is bound
 * to the TARGET preset's standing mount, so it gets that preset's whole
 * composition: persona, prompt sections, skill catalog, tools. The child runs
 * as an official ONE-SHOT subagent (subagent lifecycle events, UI, trajectory
 * rows) and returns its final output to the caller.
 *
 * Implementation note: this is a faithful re-implementation of
 * `@deepseek-ai/dsh-subagent-in-process-driver`'s `startInProcessRun` with the
 * load-bearing change — the child setup mounts the requested preset instead of
 * composing from the parent (all other driver semantics are preserved: policy
 * inheritance, descriptor append, cancellation, result reading). All
 * supporting helpers are imported from the official packages, which ARE
 * resolvable from preset-local rows (the preset loader resolves bare
 * specifiers against the harness install).
 *
 * HOST-PLANE SHARING: the subagent provider registry is a PROCESS SINGLETON.
 * Several presets may mount this row; `registerProvider` is idempotent here
 * (skips when the name already exists) so the SECOND preset does not throw
 * DUPLICATE_PROVIDER and silently break preset selection.
 *
 * One-shot only: the child is a single-turn expert call (perfect for review /
 * audit / research tasks). Continuable (`send_message`) children still inherit
 * the parent preset — that is the platform's hard constraint.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  appendDelegatedPolicyOverrides,
  assertSubagentMaxDepth,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  finalAssistantOutput,
  registerExternalContinuation,
  resolveChildAgentOptions,
  resolveChildDepth,
  settleRun,
} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { ClaudeEngineProvider } from './engines/claude.js'
import { CodexEngineProvider } from './engines/codex.js'
import { CodebuddyEngineProvider } from './engines/codebuddy.js'

export const name = 'dsh-routed-subagent'
export const inject = ['subagents', 'agentPresets', 'tools']

/** Map a session turn outcome to the subagent seam's terminal vocabulary. */
function toStopReason(reason) {
  switch (reason?.kind) {
    case 'completed': return 'completed'
    case 'max-tokens': return 'max-tokens'
    case 'aborted': return 'aborted'
    case 'blocked': return 'refusal'
    default: return 'error'
  }
}

/**
 * Model-facing delegation-scope statement, same text and order as the official
 * one (dsh-subagent SUBAGENT_DELEGATION_CONTEXT): the child must know its
 * permission scope is fixed and cannot be widened from inside the session.
 */
const SUBAGENT_DELEGATION_CONTEXT = 'You are a delegated subagent: your permission scope was fixed when you were started and cannot be widened from inside this session — operations that require approval are rejected automatically. When the task needs access beyond that scope, do not retry the denied operation; state the limitation in your reply so the delegating agent can handle it.'

/** Append one one-shot descriptor inside the child's initial turn. */
function attachDescriptorAppend(childCtx, descriptor) {
  let appended = false
  childCtx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!appended && decision.kind === 'enter') {
      appended = true
      agent.session.append('subagent/descriptor', descriptor)
    }
    return decision
  })
}

/** Wrap a published child in the one-turn run lifecycle (cancellation, settle, disposal). */
function drivePresetRun(handle, signal, prompt, childId, boundary = 0) {
  const child = handle.agent
  const flags = { cancelled: false }
  const onAbort = () => {
    flags.cancelled = true
    child.cancel({ kind: 'parent' })
  }
  signal.addEventListener('abort', onAbort, { once: true })
  if (signal.aborted) onAbort()
  const result = (async () => {
    try {
      if (!flags.cancelled) {
        child.followup(createUserMessage({ content: prompt, source: { kind: 'user' } }))
        await child.whenIdle()
      }
      return readPresetResult(child, flags.cancelled, boundary)
    } finally {
      signal.removeEventListener('abort', onAbort)
    }
  })()
  return {
    id: childId,
    localAgent: child,
    result,
    async dispose() {
      signal.removeEventListener('abort', onAbort)
      flags.cancelled = true
      const disposal = (await Promise.allSettled([handle.dispose(), result]))[0]
      if (disposal.status === 'rejected') throw disposal.reason
    },
  }
}

/** Read one settled child's final output + stop reason from its events. */
function readPresetResult(child, cancelled, boundary = 0) {
  // Fork seeds replay the parent's completed turns; slice them out so the fold
  // only ever reports the CHILD's own work (a child cancelled before its first
  // turn/end must not inherit the parent's completion reason).
  const own = child.session.events.slice(boundary)
  const lastEnd = foldConsumedWork(own).end
  const output = finalAssistantOutput(own) ?? []
  const recorded = toStopReason(lastEnd?.data.reason)
  const stopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded
  return { output, stopReason }
}

/** The parent's completed-turn prefix — the official fork seed (current tool-call turn excluded). */
function completedTurnPrefix(parent) {
  const events = parent.session.events
  const lastEnd = events.findLast((e) => e.type === 'turn/end')
  if (lastEnd === void 0) return []
  return events.slice(0, lastEnd.seq + 1)
}

/**
 * Resolve the recursion budget with an early, friendly validation: values
 * that are not positive safe integers fail here (tool layer) instead of deep
 * inside the provider. Note: 0 is rejected — a zero budget can never admit a
 * child (resolveChildDepth always requires depth >= 1).
 */
function resolveMaxDepth(value, fallback, toolName) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`${toolName}: max_depth must be a positive integer, got ${JSON.stringify(value)}`)
  }
  if (value < 1) {
    throw new Error(`${toolName}: max_depth must be >= 1 (recursion budget), got ${value}`)
  }
  return value
}

/**
 * Render a LIVE progress snapshot of a running child for the jobs `readOutput`
 * hook — called whenever the parent reads the background job (job_output).
 * Summarizes recent activity (tools, steps, text), elapsed/idle time, and
 * flags a possibly-stuck child (no events for a while).
 */
function liveProgress(child, startedMs) {
  const elapsed = ((Date.now() - startedMs) / 1000).toFixed(0)
  if (child === null) return `starting (${elapsed}s)…`
  try {
    const events = child.session.events ?? []
    if (events.length === 0) return `running (${elapsed}s) · 0 events yet`
    const last = events[events.length - 1]
    // Finished: surface the final output instead of a progress snapshot.
    const reason = last?.type === 'turn/end' ? (typeof last.data?.reason === 'object' ? last.data?.reason?.kind : last.data?.reason) : undefined
    if (last?.type === 'turn/end' && (reason === 'completed' || reason === 'aborted' || reason === 'error' || reason === 'max-tokens')) {
      const output = finalAssistantOutput(events) ?? []
      const finalText = output.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('')
      return `finished ${reason} in ${elapsed}s · ${events.length} events\n${finalText.slice(0, 2000) || '(no text output)'}`
    }
    const idleMs = typeof last?.time === 'number' ? Date.now() - last.time : 0
    const idle = (idleMs / 1000).toFixed(0)
    const stuck = idleMs > 120000
    const tail = events.slice(-8)
    const summary = []
    for (const e of tail) {
      const d = e.data ?? {}
      if (e.type === 'tool/call') summary.push(`tool:${d.name ?? '?'}`)
      else if (e.type === 'assistant/chunk' && typeof d.text === 'string') summary.push(d.text.slice(0, 50))
      else if (e.type === 'step/start') summary.push(`step ${d.step ?? '?'}`)
      else if (e.type === 'turn/end') summary.push(`turn-end:${typeof d.reason === 'object' ? d.reason?.kind ?? '?' : d.reason ?? '?'}`)
    }
    return [
      `running ${elapsed}s · ${events.length} events · idle ${idle}s${stuck ? ' ⚠️ POSSIBLY STUCK (no events > 2min)' : ''}`,
      summary.join(' | '),
    ].join('\n')
  } catch {
    return `running (${elapsed}s)`
  }
}

/**
 * Validate the tool_filter parameter shape: DENY-ONLY { deny?: string[] }.
 * `allow` is rejected: the tool surface is defined by the mounted preset —
 * a mask can only remove tools, never add or narrow to an allow-list.
 * Deny must be a non-empty array of non-empty tool names.
 */
function validateToolFilter(filter, toolName) {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    throw new Error(`${toolName}: tool_filter must be an object { deny?: string[] }`)
  }
  if (filter.allow !== undefined) {
    throw new Error(`${toolName}: tool_filter.allow is not supported — the tool surface comes from the mounted preset; use deny to remove tools`)
  }
  const deny = filter.deny
  if (deny === undefined) {
    throw new Error(`${toolName}: tool_filter needs deny (a non-empty list of tool names to remove)`)
  }
  if (!Array.isArray(deny) || deny.length === 0 || deny.some((n) => typeof n !== 'string' || n.length === 0)) {
    throw new Error(`${toolName}: tool_filter.deny must be a non-empty array of non-empty tool names`)
  }
  return { deny: [...new Set(deny)] }
}

/**
 * Assert that the patched @deepseek-ai/dsh-subagent is the loaded instance.
 * The marker lives in the fork package.json; every profile's resolution must
 * land on the install-level junction (module identity must not split).
 */
function assertSubagentPatchApplied(ctx) {
  try {
    const pkg = JSON.parse(readFileSync(new URL('node_modules/@deepseek-ai/dsh-subagent/package.json', import.meta.url), 'utf8'))
    if (pkg.dshRoutedSubagentPatch !== 'v3.1-preset-mount') {
      throw new Error(`@deepseek-ai/dsh-subagent at ${new URL('node_modules/@deepseek-ai/dsh-subagent/package.json', import.meta.url).href} is NOT the dsh-routed-subagent patched fork (marker missing)`)
    }
  } catch (error) {
    ctx.logger?.warn?.(`${name}: platform patch assertion failed — continuable+preset mode will not work: ${String(error?.message ?? error)}`)
  }
}

export function apply(ctx, config = {}) {
  const providerName = config.providerName ?? 'routed-mount'
  const forkProviderName = config.forkProviderName ?? 'routed-fork'
  const claudeProviderName = config.claudeProviderName ?? 'routed-claude'
  const codexProviderName = config.codexProviderName ?? 'routed-codex'
  const codebuddyProviderName = config.codebuddyProviderName ?? 'routed-codebuddy'
  const toolName = config.toolName ?? 'subagent_routed'
  const agentPresets = ctx.agentPresets

  // ── 1) custom providers: full preset mount on the child ───────────────────
  // `routed-mount` starts a FRESH child; `routed-fork` SEEDS the child with the
  // parent's completed-turn prefix (inherits the parent conversation) and then
  // mounts the requested preset on top. Both share one run factory.
  const makeProvider = (pname, inheritsParentContext) => ({
    name: pname,
    // Declare ONLY what start() actually implements. toolFilter is true: the
    // tool may pass a deny-only mask applied on top of the mounted preset's
    // tool surface (same restrict mechanism as the stock subagent tool).
    // persona is deliberately false: the child's persona comes from the mounted
    // preset — a per-request persona override is not supported (write the role
    // into the prompt instead). depthLimit is true: the tool passes maxDepth
    // (default 3) so recursive delegation is bounded. outputSchema is false:
    // no structured-output contract is implemented.
    capabilities: {
      toolFilter: true,
      persona: false,
      depthLimit: true,
      outputSchema: false,
    },
    // fresh mount: no inherited conversation; fork: the child sees the parent's
    // completed turns (the tool wording branches on this flag).
    inheritsParentContext,
    async start(request) {
      assertSubagentMaxDepth(request.maxDepth)
      if (request.signal.aborted) throw new Error('subagent request was aborted before child publication')
      const parent = request.parent
      const targetPreset = request.preset
      if (typeof targetPreset !== 'string' || targetPreset.length === 0) {
        throw new Error(`${pname}: request.preset is required (the preset id the child should mount)`)
      }
      const childDepth = resolveChildDepth(parent, request.maxDepth)
      const childId = SessionId(randomUUID())
      const inherited = captureDelegatedPolicyOverrides(parent)
      // fork seed: the parent's completed-turn prefix (current tool-call turn
      // excluded) — value-copied events, so the parent's cancellation never
      // corrupts the child's log.
      const seed = inheritsParentContext ? completedTurnPrefix(parent) : []
      const boundary = seed.length

      const setup = async (childCtx) => {
        appendDelegatedPolicyOverrides(childCtx.agent.session, inherited)
        // THE load-bearing line: mount the requested preset (async setup is
        // awaited by the agent factory), replacing parent composition.
        await agentPresets.mount(childCtx, targetPreset)
        // Deny-only tool mask applied ON TOP of the mounted preset's tool
        // surface (same restrict mechanism as the stock subagent toolFilter).
        if (request.toolFilter !== undefined && request.toolFilter.deny !== void 0) {
          childCtx.tools.restrict({ deny: request.toolFilter.deny })
        }
        // Same fixed-permission statement the official composition installs.
        childCtx.systemPrompt.context({
          name: 'subagent:delegation',
          order: 120,
          text: SUBAGENT_DELEGATION_CONTEXT,
        })
        if (request.descriptor !== void 0) attachDescriptorAppend(childCtx, request.descriptor)
      }

      return drivePresetRun(
        await parent.ctx.agents.create({
          sessionId: childId,
          // Override agentPreset: childSessionMeta records the PARENT's preset,
          // but this child actually mounts the TARGET preset — the header must
          // say so or a cold read rebuilds the child under the wrong composition.
          // activationBoundary = seed.length keeps fork seed events out of the
          // consumed-work fold (a cancelled child must not report the parent's
          // last turn/end as its own completion).
          meta: { ...childSessionMeta(parent, childDepth, boundary), agentPreset: targetPreset },
          ...(boundary > 0 ? { seed } : {}),
          agentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),
          signal: request.signal,
          setup,
        }),
        request.signal,
        request.prompt,
        childId,
        boundary,
      )
    },
    // Continuable children (send_message): the patched materialize mounts the
    // target preset from composition.preset; the provider only supplies the
    // seed prefix (fresh = none; fork = parent's completed turns).
    prepareContinuable(request) {
      return Promise.resolve(inheritsParentContext ? { seed: completedTurnPrefix(request.parent) } : {})
    },
  })
  const provider = makeProvider(providerName, false)
  const forkProvider = makeProvider(forkProviderName, true)
  // Startup assertion (M4): continuable+preset requires the PATCHED
  // @deepseek-ai/dsh-subagent to be the loaded instance. A profile-local
  // `link:` dependency would split module identity — the harness would
  // instantiate the OFFICIAL SubagentRuntime and the patch would silently
  // never run. Fail loud, never silently degrade.
  assertSubagentPatchApplied(ctx)
  // The provider registry is a PROCESS SINGLETON shared by every preset that
  // mounts this row — register once, skip duplicates, never throw.
  if (ctx.subagents.getProvider(providerName) === undefined) {
    ctx.subagents.registerProvider(provider)
  } else {
    ctx.logger?.info?.(`${name}: provider "${providerName}" already registered on the host plane; skipping duplicate`)
  }
  if (ctx.subagents.getProvider(forkProviderName) === undefined) {
    ctx.subagents.registerProvider(forkProvider)
  } else {
    ctx.logger?.info?.(`${name}: provider "${forkProviderName}" already registered on the host plane; skipping duplicate`)
  }
  // ── 1b) claude engine provider (imports @anthropic-ai/claude-agent-sdk) ──
  const claudeProvider = new ClaudeEngineProvider(claudeProviderName, ctx, config)
  if (ctx.subagents.getProvider(claudeProviderName) === undefined) {
    ctx.subagents.registerProvider(claudeProvider)
  } else {
    ctx.logger?.info?.(`${name}: provider "${claudeProviderName}" already registered on the host plane; skipping duplicate`)
  }

  // ── 1c) codex engine provider (drives the codex CLI app-server over stdio) ──
  const codexProvider = new CodexEngineProvider(codexProviderName, ctx, config)
  if (ctx.subagents.getProvider(codexProviderName) === undefined) {
    ctx.subagents.registerProvider(codexProvider)
  } else {
    ctx.logger?.info?.(`${name}: provider "${codexProviderName}" already registered on the host plane; skipping duplicate`)
  }
  // The codex wire owns a LONG-LIVED app-server child process. Kill it on
  // plugin teardown so reloads/uninstalls never leave orphan `codex` processes.
  ctx.effect(() => () => { codexProvider.dispose?.().catch?.(() => {}) }, 'dsh-routed-subagent codex teardown')

  // ── 1d) codebuddy engine provider (drives the CodeBuddy Code CLI --print) ──
  const codebuddyProvider = new CodebuddyEngineProvider(codebuddyProviderName, ctx, config)
  if (ctx.subagents.getProvider(codebuddyProviderName) === undefined) {
    ctx.subagents.registerProvider(codebuddyProvider)
  } else {
    ctx.logger?.info?.(`${name}: provider "${codebuddyProviderName}" already registered on the host plane; skipping duplicate`)
  }

  // ── 2) tool: subagent_routed ───────────────────────────────────────────
  const defaultMaxDepth = config.maxDepth ?? 3
  const defaultBackground = config.runInBackground ?? true
  ctx.effect(() => ctx.tools.register(defineTool({
    name: toolName,
    description: 'Run a subagent fully mounted on a SPECIFIED agent preset, from any session — the child adopts that preset\'s complete composition (persona, prompt sections, skill catalog, tools), unlike the stock subagent tools which inherit this session\'s own preset. Dispatch ONE background delegable job and keep working (see modes; a child that needs THIS conversation\'s context should set fork=true). BACKGROUND by default: the call RETURNS A JOB ID IMMEDIATELY — the child runs independently, aborting this conversation does NOT cancel it, and you can dispatch several in parallel. UNLESS the task explicitly requires the result before you can continue, DO NOT wait: return the job id, continue your other work, and collect results later with job_output (live progress) or stop with job_kill. Set run_in_background: false ONLY when the very next step depends on the child\'s output. PREFER fork=true when the child should see this conversation\'s history; prefer continuable=true for a long-running child you\'ll send follow-ups to (send_message); otherwise leave both unset for a plain one-shot. One tool, all modes — do NOT fall back to the (disabled) stock subagent.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.' },
      preset: { type: 'string', required: true, description: 'The agent preset id the child should mount (e.g. "dev", "standard", "router-standard"). Must exist in the roster.' },
      description: { type: 'string', required: true, description: 'A short (3-5 word) description of the delegated task, for display.' },
      max_depth: { type: 'number', description: 'Recursion budget for the child\'s own delegations (default ' + defaultMaxDepth + '; must be a positive integer >= 1).' },
      model: { type: 'string', description: 'The model id the CHILD should use (overrides this session\'s model for this call only). Must be valid under the chosen provider; if invalid, the child fails with the LLM routing error. Omit to inherit this session\'s model.' },
      provider: { type: 'string', description: 'The provider name for the child\'s model (defaults to this session\'s provider when model is set without provider).' },
      max_tokens: { type: 'number', description: 'Optional output/token cap for the child\'s LLM calls (agentOptions.maxTokens). Must be a positive integer.' },
      engine: { type: 'string', description: 'Dispatch engine: "dsh" (default, preset mounting), "claude" (external Claude Code CLI via @anthropic-ai/claude-agent-sdk), or "codex" (external Codex CLI via its app-server stdio protocol).' },
      tool_filter: { type: 'object', additionalProperties: false, properties: { deny: { type: 'array', items: { type: 'string' } } }, description: 'Optional DENY-only tool mask applied on top of the mounted preset\'s tool surface: { deny?: string[] } naming global tool names to REMOVE (e.g. deny shell tools for a read-only audit). Same restrict mechanism as the stock subagent toolFilter.' },
      run_in_background: { type: 'boolean', description: 'Default true: return a job id immediately and run the child independently (parallel dispatch; survives conversation abort). Set false to wait for the child\'s final output inline.' },
      fork: { type: 'boolean', description: 'Default false: fresh child with no inherited conversation. Set true to FORK this conversation — the child is seeded with all COMPLETED turns of this session (the current tool-call turn excluded) so it inherits the conversation context, then mounts the requested preset on top (stronger than the stock subagent_fork, which cannot change the preset). PREFER fork=true when the task needs this conversation\'s history.' },
      continuable: { type: 'boolean', description: 'Default false: one-shot child. Set true to return a durable subagent id — continue it with send_message(subagentId, ...) (multi-turn). The child mounts the requested preset and keeps it across resumes. Use for a long-running child you\'ll send follow-ups to.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['background', 'foreground', 'continuable'] },
          jobId: { type: 'string' },
          subagentId: { type: 'string' },
          runId: { type: 'string' },
          preset: { type: 'string', required: true },
          provider: { type: 'string' },
          model: { type: 'string' },
          stopReason: { type: 'string' },
          output: { type: 'array', items: { type: 'json' } },
        },
      },
      render: (_args, value) => {
        const modelTag = value.model ? ' @ ' + (value.provider ? value.provider + '/' : '') + value.model : ''
        return value.kind === 'background'
          ? [{ type: 'text', text: `started background subagent job ${value.jobId} on preset "${value.preset}"${modelTag} — the conversation is free to continue; collect with job_output / stop with job_kill` }]
          : value.kind === 'continuable'
            ? [{ type: 'text', text: `started continuable subagent ${value.subagentId} on preset "${value.preset}"${modelTag} — continue it with send_message(${value.subagentId}, ...)` }]
            : [{ type: 'text', text: `[subagent_routed ${value.preset}${modelTag} | ${value.stopReason}]\n${(value.output ?? []).filter((b) => b && b.type === 'text').map((b) => b.text).join('')}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`)

      // validate the target preset up front. `agentPresets.resolve` already
      // throws with the available preset ids; surface its message verbatim so
      // internal errors are not mislabeled as "unknown preset".
      try {
        await agentPresets.resolve(args.preset)
      } catch (error) {
        const reason = error instanceof Error && error.message ? error.message : String(error)
        throw new Error(`cannot resolve agent preset "${args.preset}": ${reason}`)
      }

      // per-call model override: request.agentOptions wins over the parent's
      // route in resolveChildAgentOptions (parent defaults first, requested
      // spreads last), so a model/provider given here applies to THIS child.
      const engine = args.engine ?? 'dsh'
      const agentOptions = {}
      if (args.provider !== undefined && args.provider !== '') agentOptions.provider = args.provider
      if (args.model !== undefined && args.model !== '') agentOptions.model = args.model
      if (args.max_tokens !== undefined) {
        if (!Number.isSafeInteger(args.max_tokens) || args.max_tokens < 1) {
          throw new Error(`${toolName}: max_tokens must be a positive integer, got ${JSON.stringify(args.max_tokens)}`)
        }
        agentOptions.maxTokens = args.max_tokens
      }

      // model availability pre-check: fail fast with a candidate list instead
      // of letting the child's LLM route fail opaquely. The original
      // resolveModelInfo error is preserved as the Error `cause` so a provider
      // outage is distinguishable from a genuinely unknown model. Runs whenever
      // a model OR provider override was given (a provider-only override
      // resolves against the parent's model, which is almost always invalid —
      // catch it here). Skipped when the harness exposes no llm service, and
      // ALWAYS skipped for external engines (codex/claude — their model is
      // handled by the CLI engine itself, not DSH's LLM routing).
      if ((engine !== 'claude' && engine !== 'codex' && engine !== 'codebuddy') && (agentOptions.model !== undefined || agentOptions.provider !== undefined)) {
        const llm = ctx.get('llm')
        const provider = agentOptions.provider ?? parent.options?.provider
        const model = agentOptions.model ?? parent.options?.model
        if (llm !== undefined && provider !== undefined && model !== undefined && typeof llm.resolveModelInfo === 'function') {
          try {
            await llm.resolveModelInfo(provider, model)
          } catch (cause) {
            let available = '(none)'
            try {
              const models = await llm.listModels(provider)
              if (Array.isArray(models) && models.length > 0) {
                available = models.map((m) => m.name ?? m.id).join(', ')
              }
            } catch { /* keep '(none)' */ }
            const shown = agentOptions.model !== undefined ? agentOptions.model : `${parent.options?.model ?? '(parent model)'}`
            throw new Error(
              `model "${shown}" is not available under provider "${provider}"; available models under ${provider}: ${available}. Pass provider=... to use another provider.`,
              { cause },
            )
          }
        }
      }

      const background = args.run_in_background !== undefined ? args.run_in_background : defaultBackground
      // Engine routing: dsh/fork use the preset-mount providers; claude/codex/codebuddy
      // use the external CLI-engine providers (Claude Code SDK / Codex app-server / CodeBuddy).
      const externalEngine = engine === 'claude' || engine === 'codex' || engine === 'codebuddy'
      const dispatchProvider = engine === 'claude'
        ? claudeProviderName
        : engine === 'codex'
          ? codexProviderName
          : engine === 'codebuddy'
            ? codebuddyProviderName
            : (args.fork ? forkProviderName : providerName)
      const request = {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        preset: args.preset,
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        // External engines manage their own recursion budget (no depthLimit
        // capability), so skip the maxDepth constraint for them.
        ...(externalEngine ? {} : { maxDepth: resolveMaxDepth(args.max_depth, defaultMaxDepth, toolName) }),
        ...(args.tool_filter !== undefined ? { toolFilter: validateToolFilter(args.tool_filter, toolName) } : {}),
        // external-engine specific passthroughs
        ...(externalEngine && args.model !== undefined ? { model: args.model } : {}),
        ...(externalEngine ? { cwd: parent.session?.header?.cwd ?? config.cwd } : {}),
      }

      if (args.continuable) {
        if (externalEngine) {
          // claude/codex/codebuddy continuable: prepare an external session,
          // register its resume callback in the (patched) external-continuation
          // registry so send_message routes here.
          const provider = engine === 'claude' ? claudeProvider : engine === 'codex' ? codexProvider : codebuddyProvider
          const prepared = await provider.prepareContinuable(request)
          if (typeof registerExternalContinuation === 'function') {
            registerExternalContinuation(prepared.sessionId, prepared.resume)
          }
          return {
            kind: 'continuable',
            subagentId: prepared.sessionId,
            engine,
            ...(agentOptions.provider !== undefined ? { provider: agentOptions.provider } : {}),
...(agentOptions.model !== undefined ? { model: agentOptions.model } : {}),
          }
        }
        // dsh continuable (preset mounting) — requires the patched dsh-subagent
        const subagents = ctx.subagents
        if (typeof subagents.startContinuable !== 'function') {
          throw new Error(`${toolName}: continuable mode unavailable — the harness lacks startContinuable`)
        }
        const continuable = await subagents.startContinuable({
          provider: dispatchProvider,
          label: args.description,
          request,
          signal: exec.signal,
        })
        return {
          kind: 'continuable',
          subagentId: continuable.childId,
          preset: args.preset,
          ...(agentOptions.provider !== undefined ? { provider: agentOptions.provider } : {}),
...(agentOptions.model !== undefined ? { model: agentOptions.model } : {}),
        }
      }

      if (background) {
        // BACKGROUND: dispatch through the jobs service with an INDEPENDENT
        // AbortController. The call returns a job id immediately — the
        // conversation is free to do other work or dispatch more children in
        // parallel, and aborting this conversation does NOT cancel the child
        // (stop it explicitly with job_kill). Same semantics as the official
        // background subagent tool.
        //
        // Observability: the run exposes a `readOutput` hook — `jobs.read`
        // calls it whenever the parent reads the job (job_output), so the
        // conversation can see the child's LIVE progress (step/tool activity,
        // recent text, idle time) and decide whether it is stuck or on track.
        const jobs = ctx.get('jobs')
        if (jobs === undefined || typeof jobs.start !== 'function') {
          throw new Error(`${toolName}: background jobs unavailable — load @deepseek-ai/dsh-jobs (or set run_in_background: false)`)
        }
        const jobId = jobs.start({
          kind: 'subagent',
          label: args.description,
          owner: parent,
          run: () => {
            const controller = new AbortController()
            let child = null // live child agent (dsh engine)
            let extRun = null // external engine run (claude/codex: has its own readOutput)
            const started = Date.now()
            const startPromise = ctx.subagents.start(dispatchProvider, { ...request, signal: controller.signal })
            startPromise.then((run) => {
              if (externalEngine) { extRun = run; return }
              child = run.localAgent ?? null
            }).catch(() => { /* surfaced through done */ })
            return {
              cancel: (reason) => controller.abort(reason ?? 'background subagent task killed'),
              readOutput: () => externalEngine
                ? (extRun?.readOutput?.() ?? 'starting…')
                : liveProgress(child, started),
              done: (async () => settleRun(await startPromise))(),
            }
          },
        })
        return {
          kind: 'background',
          jobId,
          preset: args.preset,
          ...(agentOptions.provider !== undefined ? { provider: agentOptions.provider } : {}),
...(agentOptions.model !== undefined ? { model: agentOptions.model } : {}),
        }
      }

      const run = await ctx.subagents.start(dispatchProvider, { ...request, signal: exec.signal })
      // Ownership contract: the caller MUST dispose the run. Ordering matters:
      // settle the RESULT first, THEN dispose — dispose() sets the run's
      // cancelled flag synchronously, so racing it against result (parallel
      // Promise.allSettled) would skip the child's turn and return "aborted"
      // with zero output. Two sequential fault-tolerant phases, like the
      // official settleForegroundRun.
      const [execution] = await Promise.allSettled([
        run.result.then((result) => ({ result })),
      ])
      const [disposal] = await Promise.allSettled([
        Promise.resolve().then(() => run.dispose()),
      ])
      if (execution.status === 'rejected') {
        if (disposal.status === 'rejected') throw new AggregateError([execution.reason, disposal.reason], `${toolName}: run failed and dispose also failed`)
        throw execution.reason
      }
      if (disposal.status === 'rejected') {
        ctx.logger?.warn?.(`${toolName}: run.dispose() failed for ${run.id}: ${String(disposal.reason)}`)
      }
      const result = execution.value.result
      // Failure semantics aligned with the official foreground subagent tool:
      // only `completed` and caller-initiated `aborted` are returned as values;
      // genuine child failures (error / refusal / max-tokens) throw with any
      // partial output attached, so the parent model sees a real failure.
      if (result.stopReason !== 'completed' && result.stopReason !== 'aborted') {
        const text = (result.output ?? []).filter((b) => b && b.type === 'text').map((b) => b.text).join('')
        throw new Error(
          `${toolName}: subagent run ended with ${result.stopReason}${text.length > 0 ? `\nPartial output before the run ended:\n${text}` : ''}`,
        )
      }
      return {
        kind: 'foreground',
        runId: run.id,
        preset: args.preset,
        ...(agentOptions.provider !== undefined ? { provider: agentOptions.provider } : {}),
...(agentOptions.model !== undefined ? { model: agentOptions.model } : {}),
        stopReason: result.stopReason,
        output: result.output ?? [],
      }
    },
  })), 'dsh-routed-subagent tool')

  // ── 3) guard: disable the stock subagent tools ──────────────────────────
  // All official capabilities are now in subagent_routed (background/foreground,
  // fork, continuable, max_tokens, tool_filter deny). With the full surface
  // ported, the stock subagent / subagent_fork tools are denied at execution —
  // the model sees a clear redirect instead of silently choosing an inferior
  // tool. Plain-context guard = applies globally (every preset that mounts
  // this row). NOTE: a preset that does NOT mount this row is outside the
  // guard's scope — keep this row in every preset you want routed-only.
  const disableStock = config.disableStockSubagent ?? true
  if (disableStock) {
    ctx.effect(() => ctx.tools.guard((exec) => {
      const n = exec?.name
      if (n === 'subagent' || n === 'subagent_fork') {
        return `the stock ${n} tool is disabled — use ${toolName} instead (full preset mount, background by default, live progress, fork + continuable modes)`
      }
    }), 'dsh-routed-subagent stock-subagent guard')
  }
}
