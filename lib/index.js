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
import { createRequire } from 'node:module'
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

// 0.2.1-rc.2 removed `subagents.start(provider, spec)`. The kernel now ships a
// compatibility bridge with the 0.2.0 semantics again (it calls the provider's
// own start() when present), so prefer it: startActivation would bypass the
// provider's seed/setup logic and misroute external engines as local children.
// Keep the activation shape as a last-resort fallback for older/newer kernels,
// forwarding `label` because startActivation reads spec.label, not request.label.
function startDispatch(subagents, provider, request, signal) {
  if (typeof subagents.start === 'function') {
    return subagents.start(provider, { ...request, signal })
  }
  return subagents.startActivation({
    provider,
    request,
    signal,
    ...(request.label === undefined ? {} : { label: request.label }),
  })
}

export const name = 'dsh-routed-subagent'
// 'agents' is NOT injectable here for childCtx: the agent-loop calls our
// `setup(childCtx, child)` with childCtx = the CHILD agent's ctx, whose scope
// exposes systemPrompt/tools services but NOT the `agent` accessor (same as
// stock dsh-subagent, which reads `child.session` from the second argument —
// see dsh-subagent/lib/index.js:1077/542). Use the `child` Agent handle.
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
 * Validate the tool_filter parameter shape: DENY-ONLY { deny: string[] }.
 * `allow` is rejected: the tool surface is defined by the mounted preset —
 * a mask can only remove tools, never add or narrow to an allow-list.
 * Deny must be a non-empty array of non-empty tool names.
 */
function validateToolFilter(filter, toolName) {
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) {
    throw new Error(`${toolName}: tool_filter must be an object { deny: string[] }`)
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
 * Build a Team-roster-safe teammate name: lower-kebab-case, unique per Team.
 * A caller-supplied name is sanitized but kept recognisable; a derived one gets
 * a short random suffix because roster names are immutable and never reclaimed.
 */
function memberSafeName(raw, explicit) {
  const base = String(raw ?? 'teammate')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'teammate'
  return explicit ? base : `${base}-${randomUUID().slice(0, 4)}`
}

/**
 * Assert that the patched @deepseek-ai/dsh-subagent is the loaded instance.
 * The marker lives in the fork package.json; every profile's resolution must
 * land on the install-level junction (module identity must not split).
 * Resolution goes through the package specifier (not a hardcoded
 * `lib/node_modules/...` path) so it follows whatever junction the profile
 * installs — the old relative path pointed at a junction that kernel upgrades
 * legitimately remove, which produced a false ENOENT warning on every boot.
 */
function assertSubagentPatchApplied(ctx) {
  try {
    const pkgPath = createRequire(import.meta.url).resolve('@deepseek-ai/dsh-subagent/package.json')
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg.dshRoutedSubagentPatch !== 'v3.1-preset-mount') {
      throw new Error(`@deepseek-ai/dsh-subagent at ${pkgPath} is NOT the dsh-routed-subagent patched fork (marker missing)`)
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
  // `seedsFromParent` is INTERNAL (fork seeding + continuable seed prefix).
  // It must NOT be published as the host-visible `inheritsParentContext`
  // flag: host >= 0.2.0-rc.1 rejects any provider that both advertises
  // `agentPreset` and reports `inheritsParentContext: true`
  //   `!provider.capabilities.agentPreset || provider.inheritsParentContext`
  //   -> "does not support independent agent preset selection"
  // Fork still inherits the conversation because THIS plugin seeds the child
  // itself (completedTurnPrefix + activationBoundary), not the host.
  const makeProvider = (pname, seedsFromParent) => ({
    name: pname,
    // Declare ONLY what start() actually implements. agentPreset is true: the
    // provider mounts an independently selected preset (host >= 0.2 requires
    // this flag for any request carrying a preset). toolFilter/persona are the
    // pre-0.2 capability keys: toolFilter is true (deny-only mask on top of the
    // mounted preset's surface); persona is deliberately false — the child's
    // persona comes from the mounted preset (write the role into the prompt
    // instead). depthLimit is true: the tool passes maxDepth (default 3) so
    // recursive delegation is bounded. outputSchema is false: no
    // structured-output contract is implemented.
    capabilities: {
      agentOptions: true,
      agentPreset: true,
      toolFilter: true,
      persona: false,
      depthLimit: true,
      outputSchema: false,
    },
    // Always false on purpose — see the seeding note above.
    inheritsParentContext: false,
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
      const seed = seedsFromParent ? completedTurnPrefix(parent) : []
      const boundary = seed.length

      const setup = async (childCtx, child) => {
        // child = the published Agent handle (second setup argument, same as
        // stock dsh-subagent:1077). The `agent` accessor is NOT visible on the
        // child ctx scope (see inject note) — use the handle directly.
        appendDelegatedPolicyOverrides(child.session, inherited)
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
          // Host >= 0.2.0-rc.1: `childSessionMeta(parent, childDepth, isSeeded, selectedPreset)`.
          // The 3rd argument is a BOOLEAN (was the numeric seed boundary before),
          // and the 4th carries the independently selected preset — the header must
          // say so or a cold read rebuilds the child under the parent's composition.
          // isSeeded = boundary > 0 mirrors what actually reaches create(): the seed
          // is only passed when the parent prefix is non-empty.
          meta: childSessionMeta(parent, childDepth, boundary > 0, targetPreset),
          ...(boundary > 0 ? { seed, inheritedEventCount: boundary } : {}),
          // Seeded sessions require BOTH the seed and its boundary count:
          // dsh-session throws "seeded session requires an inherited event count"
          // when header.isSeeded is true and inheritedEventCount is absent.
          // Ownership: the official driver passes the delegating agent so the child
          // is registered under it (agents.enter(agent, parentAgent)).
          parentAgent: parent,
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
      return Promise.resolve(seedsFromParent ? { seed: completedTurnPrefix(request.parent) } : {})
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
      prompt: { type: 'string', description: 'Dispatch mode: the complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.' },
      preset: { type: 'string', description: 'The exact agent preset roster ID the child should mount (e.g. "dev", "standard", "router-standard"); role/display names such as "reviewer" are not IDs. Must exist in the roster. Required for the default dsh engine; IGNORED for external engines (codex / claude / codebuddy — they are driven by their own CLI, not by a DSH preset).' },
      description: { type: 'string', description: 'Dispatch mode: a short (3-5 word) description of the delegated task, for display. Required unless target_agent_id/message are used.' },
      max_depth: { type: 'number', description: 'Recursion budget for the child\'s own delegations (default ' + defaultMaxDepth + '; must be a positive integer >= 1).' },
      model: { type: 'string', description: 'The model id the CHILD should use (overrides this session\'s model for this call only). Must be valid under the chosen provider; if invalid, the child fails with the LLM routing error. Omit to inherit this session\'s model.' },
      provider: { type: 'string', description: 'The provider name for the child\'s model (defaults to this session\'s provider when model is set without provider).' },
      max_tokens: { type: 'number', description: 'Optional output/token cap for the child\'s LLM calls (agentOptions.maxTokens). Must be a positive integer.' },
      engine: { type: 'string', description: 'Dispatch engine: "dsh" (default, preset mounting), "claude" (external Claude Code CLI via @anthropic-ai/claude-agent-sdk), "codex" (external Codex CLI via its app-server stdio protocol), or "codebuddy" (external CodeBuddy CLI).' },
      cwd: { type: 'string', description: 'Working directory for EXTERNAL engines (codex / claude / codebuddy) — the repository the external CLI should operate in. Defaults to the parent session cwd (the DSH conversation dir, usually NOT the target repo); pass the repo path explicitly for code review tasks. Ignored by the dsh engine.' },
      tool_filter: { type: 'object', additionalProperties: false, properties: { deny: { type: 'array', required: true, items: { type: 'string' } } }, description: 'Optional DENY-only tool mask ({ deny: string[] }) applied on top of the mounted preset tool surface, on the durable path too (host patch P47). Names global tools to REMOVE, e.g. deny write/shell for a read-only audit.' },
      run_in_background: { type: 'boolean', description: 'DISABLED: always true rejects the call. One-shot background jobs are gone by policy — every dispatch produces a durable subagent.' },
      timeout_ms: { type: 'number', description: 'External-engine turn timeout in milliseconds (default 1800000 = 30 min). A turn that runs longer fails with a timeout error. Ignored by the dsh engine.' },
      help: { type: 'boolean', description: 'Return this tool usage guide instead of dispatching. Use it when unsure which mode or parameters to pass.' },
      target_agent_id: { type: 'string', description: 'Continue mode: the durable subagent id to message instead of dispatching a new child. Pair with message; every other dispatch parameter and preset are ignored.' },
      message: { type: 'string', description: 'Continue mode: the message to deliver to target_agent_id. The child receives it at its next step if running, or starts a new turn if idle; the call returns delivery confirmation, not the answer.' },
      team: { type: 'boolean', description: 'OPT-IN Team mode (hybrid). Default false = disposable one-shot child (unlimited fan-out). true = create a REAL Agent Team roster member via the team service, so it is addressable with send_message and visible to list_agents. Requires a Team Lead caller and a free roster slot (maxMembers, failures included, never reclaimed). The teammate mounts THIS call\'s preset.' },
      name: { type: 'string', description: 'Team mode only: the teammate name (lower-kebab-case, unique per Team). Omit to derive one from description with a short random suffix.' },
      fork: { type: 'boolean', description: 'Default false: fresh child with no inherited conversation. Set true to FORK this conversation — the child is seeded with all COMPLETED turns of this session (the current tool-call turn excluded) so it inherits the conversation context, then mounts the requested preset on top (stronger than the stock subagent_fork, which cannot change the preset). PREFER fork=true when the task needs this conversation\'s history.' },
      continuable: { type: 'boolean', description: 'Always on: every dispatch is durable. Kept only for call-site compatibility; the value is ignored because one-shot children no longer exist.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['background', 'foreground', 'continuable', 'teammate', 'message', 'help'] },
          jobId: { type: 'string' },
          subagentId: { type: 'string' },
          name: { type: 'string' },
          agentId: { type: 'string' },
          messageId: { type: 'string' },
          guide: { type: 'string' },
          runId: { type: 'string' },
          preset: { type: 'string' },
          engine: { type: 'string' },
          provider: { type: 'string' },
          model: { type: 'string' },
          stopReason: { type: 'string' },
          output: { type: 'array', items: { type: 'json' } },
        },
      },
      render: (_args, value) => {
        const modelTag = value.model ? ' @ ' + (value.provider ? value.provider + '/' : '') + value.model : ''
        const target = value.preset ?? value.engine ?? 'dsh'
        if (value.kind === 'help') {
          return [{ type: 'text', text: value.guide ?? '' }]
        }
        if (value.kind === 'message') {
          return [{ type: 'text', text: `message delivered to durable subagent ${value.agentId}` }]
        }
        if (value.kind === 'teammate') {
          return [{ type: 'text', text: `spawned Team teammate "${value.name}"${value.preset ? ` on preset "${value.preset}"` : ''} — durable roster member; address it with send_message({ target: "${value.name}" }) and see it in list_agents` }]
        }
        return value.kind === 'background'
          ? [{ type: 'text', text: `started background subagent job ${value.jobId} on ${value.engine ? `engine "${value.engine}"` : `preset "${target}"`}${modelTag} — the conversation is free to continue; collect with job_output / stop with job_kill` }]
          : value.kind === 'continuable'
            ? [{ type: 'text', text: `started continuable subagent ${value.subagentId} on ${value.engine ? `engine "${value.engine}"` : `preset "${target}"`}${modelTag} — continue it with send_message(${value.subagentId}, ...)` }]
            : [{ type: 'text', text: `[subagent_routed ${value.engine ? `engine=${value.engine}` : target}${modelTag} | ${value.stopReason}]\n${(value.output ?? []).filter((b) => b && b.type === 'text').map((b) => b.text).join('')}` }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error(`${toolName} requires a calling agent (exec.agent was undefined)`)

      // ── Help mode: discoverable from any conversation ──────────────────────
      // A conversation's visible tool list is frozen when it starts, so newer
      // parameters are invisible there. Asking for help is the discoverable path.
      if (args.help === true) {
        return { kind: 'help', guide: "subagent_routed — usage guide\n\nMODE 1 · durable dispatch (default, the only dispatch path)\n  subagent_routed({ preset: 'dev', description: 'short label', prompt: 'full task' })\n  -> returns { kind: 'continuable', subagentId }\n  The child mounts the named preset, runs ONE turn, then goes idle. It is NOT deleted:\n  keep talking to it with mode 4. One-shot children were removed by policy.\n\nMODE 2 · fork (durable + this conversation's history)\n  { preset, description, prompt, fork: true }\n  Seeds the child with all COMPLETED turns of this conversation, then mounts the preset.\n\nMODE 3 · team teammate (real roster member)\n  { preset, description, name: 'kebab-case-name', prompt, team: true }\n  -> visible in list_agents, addressable by name, persists as a roster row.\n  Rules: caller must be the Team Lead; name is unique and never reused; one roster slot is\n  consumed permanently (a slot is NOT freed by deleting the child conversation).\n  NOT allowed together with: engine, model, provider, max_tokens, max_depth, tool_filter,\n  timeout_ms, cwd, run_in_background, continuable.\n\nMODE 4 · continue an existing durable child (works from ANY conversation)\n  { target_agent_id: '<durable id>', message: 'what to say next' }\n  -> returns { kind: 'message', agentId, messageId } (delivery receipt, not the answer).\n  A running child receives it at its next step; an idle child starts a new turn.\n  This is the way to reach children from conversations whose tool list predates the\n  separate control tool.\n\nPARAMETERS\n  preset            agent-preset id to mount (required for dispatch; must exist in the roster)\n  description       3-5 word label shown in UI (required for dispatch)\n  prompt            the complete, self-contained task (required for dispatch)\n  fork              seed the child with this conversation's completed turns\n  team              create a real Agent Team teammate instead of a plain child\n  name              teammate name (team mode only)\n  model / provider  per-call LLM override; omit to inherit THIS conversation's route\n  max_tokens        output cap for the child\n  max_depth         recursion budget (default 3)\n  tool_filter       { deny: [...] } deny-only mask, honoured via host patch P47\n  target_agent_id + message   continue mode (mode 4)\n\nNOT SUPPORTED\n  run_in_background: true   one-shot background dispatch is disabled by policy\n  one-shot foreground       removed; every dispatch is durable\n\nTIPS\n  - Omit model/provider unless you deliberately want a different route; the child\n    inherits the caller's model, which avoids quota surprises.\n  - tool_filter only REMOVES tools; pick a preset whose surface already fits the task.\n  - Check list_agents before spawning teammates: roster slots are immutable.\n" }
      }

      // ── Continue an existing durable child (message mode) ──────────────────
      // Old conversations keep the tool schema they started with, so a newly
      // registered control tool is invisible there. Routing continuation through
      // THIS tool keeps every conversation able to reach its children.
      if (args.target_agent_id !== undefined || args.message !== undefined) {
        if (typeof args.target_agent_id !== 'string' || typeof args.message !== 'string') {
          throw new Error(`${toolName}: continue mode needs BOTH target_agent_id and message`)
        }
        const messageId = await ctx.subagents.sendMessage(
          parent,
          SessionId(args.target_agent_id),
          [{ type: 'text', text: args.message }],
          { signal: exec.signal },
        )
        return { kind: 'message', agentId: args.target_agent_id, messageId }
      }

      if (typeof args.prompt !== 'string' || args.prompt.length === 0) {
        throw new Error(`${toolName}: prompt is required to dispatch a subagent`)
      }
      if (typeof args.description !== 'string' || args.description.length === 0) {
        throw new Error(`${toolName}: description is required to dispatch a subagent`)
      }

      // Engine routing first: external engines (codex / claude / codebuddy)
      // are driven by their own CLI — they have NO preset concept, so preset
      // is optional and IGNORED for them. Only the dsh engine (preset mounting)
      // requires and resolves a target preset.
      const engine = args.engine ?? 'dsh'
      const externalEngine = engine === 'claude' || engine === 'codex' || engine === 'codebuddy'

      if (!externalEngine) {
        if (typeof args.preset !== 'string' || args.preset.length === 0) {
          throw new Error(`${toolName}: preset is required for the dsh engine (the preset id the child should mount)`)
        }
        // validate the target preset up front. `agentPresets.resolve` already
        // throws with the available preset ids; surface its message verbatim so
        // internal errors are not mislabeled as "unknown preset".
        try {
          await agentPresets.resolve(args.preset)
        } catch (error) {
          const reason = error instanceof Error && error.message ? error.message : String(error)
          throw new Error(`cannot resolve agent preset "${args.preset}": ${reason}`)
        }
      }

      // per-call model override: request.agentOptions wins over the parent's
      // route in resolveChildAgentOptions (parent defaults first, requested
      // spreads last), so a model/provider given here applies to THIS child.
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

      // ── Team mode (opt-in): create a REAL roster teammate ─────────────────
      // Addressable via send_message, visible to list_agents; consumes one
      // immutable roster slot (maxMembers, failures included).
      if (args.team === true) {
        // Validate the request shape FIRST: a bad parameter must be reported even
        // when the Team service is absent, otherwise the error misleads.
        const unsupported = ['engine', 'model', 'provider', 'max_tokens', 'max_depth', 'tool_filter', 'timeout_ms', 'cwd', 'run_in_background', 'continuable']
          .filter((key) => args[key] !== undefined)
        if (unsupported.length > 0) {
          throw new Error(`${toolName}: team mode does not support ${unsupported.join(', ')} — a teammate inherits the Lead's route and preset composition; remove those parameters or drop team:true`)
        }
        if (typeof args.preset !== 'string' || args.preset.length === 0) {
          throw new Error(`${toolName}: team mode requires preset (the preset the teammate mounts)`)
        }
        const agentTeams = ctx.get('agentTeams')
        if (agentTeams === undefined || typeof agentTeams.spawnTeammate !== 'function') {
          throw new Error(`${toolName}: team mode requires the Agent Team service (@deepseek-ai/dsh-experimental-agent-team)`)
        }
        const membership = agentTeams.tryMembership(parent)
        if (membership === undefined) {
          throw new Error(`${toolName}: team mode needs a Team identity — this caller is a plain subagent, not a Team Lead`)
        }
        if (membership.role !== 'lead') {
          throw new Error(`${toolName}: only the Team Lead can create teammates (caller is teammate "${membership.name}")`)
        }
        const teammateName = memberSafeName(args.name ?? args.description, args.name !== undefined)
        // spawnTeammate builds the child through startActivation, which mounts
        // composition.agentPreset — carried by the patched team service.
        const spawned = await agentTeams.spawnTeammate(parent, {
          name: teammateName,
          description: args.description,
          prompt: [{ type: 'text', text: args.prompt }],
          context: args.fork ? 'fork' : 'fresh',
          provider: args.fork ? forkProviderName : providerName,
          agentPreset: args.preset,
          signal: exec.signal,
        })
        return {
          kind: 'teammate',
          subagentId: spawned?.member?.id,
          name: spawned?.member?.name ?? teammateName,
          preset: args.preset,
        }
      }

      // ── Durability policy: NO one-shot children ────────────────────────────
      // Every dispatch must produce a durable, continuable subagent: a one-shot
      // child is a throwaway record that cannot be messaged and is discarded.
      if (args.run_in_background === true) {
        throw new Error(`${toolName}: one-shot background dispatch is disabled — every subagent is continuable now and survives independently without a job wrapper. Drop run_in_background, or use team:true for a roster teammate.`)
      }

      // Engine routing: dsh/fork use the preset-mount providers; claude/codex/codebuddy
      // use the external CLI-engine providers (Claude Code SDK / Codex app-server / CodeBuddy).
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
        // preset only travels to the dsh engine (which requires it). External
        // engines (codex/claude/codebuddy) have no preset concept and must not
        // receive one — it would be misleading dead weight in their request.
        ...(!externalEngine ? { preset: args.preset } : {}),
        // External-engine providers do not declare the agentOptions capability,
        // so the host gate rejects any request carrying it. Their model is passed
        // through the engine-specific `model` field below instead.
        ...(!externalEngine && Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        // External engines manage their own recursion budget (no depthLimit
        // capability), so skip the maxDepth constraint for them.
        ...(externalEngine ? {} : { maxDepth: resolveMaxDepth(args.max_depth, defaultMaxDepth, toolName) }),
        // P47 (host patch): startLocal now forwards request.toolFilter into both
        // the descriptor and composition.toolFilter, so the deny-only mask is
        // applied on the durable path too (applyChildComposition).
        ...(args.tool_filter !== undefined ? { toolFilter: validateToolFilter(args.tool_filter, toolName) } : {}),
        // external-engine specific passthroughs
        ...(externalEngine && args.model !== undefined ? { model: args.model } : {}),
        ...(externalEngine ? { cwd: args.cwd ?? parent.session?.header?.cwd ?? config.cwd } : {}),
        ...(externalEngine && args.timeout_ms !== undefined ? { timeoutMs: args.timeout_ms } : {}),
      }

      // Durability policy: this branch is the ONLY dispatch path (see above).
      {
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
          ...(!externalEngine ? { preset: args.preset } : {}),
          ...(agentOptions.provider !== undefined ? { provider: agentOptions.provider } : {}),
...(agentOptions.model !== undefined ? { model: agentOptions.model } : {}),
        }
      }

      // Unreachable by construction: every dispatch above returns a durable
      // (continuable) subagent. Kept as a guard so a future edit that falls
      // through cannot silently create a disposable one-shot child.
      throw new Error(`${toolName}: internal error — no durable dispatch path produced a subagent`)
    },
  })), 'dsh-routed-subagent tool')

  // ── 2b) control tool: continue a durable subagent ────────────────────────
  // The Agent Team profile layer disables @deepseek-ai/dsh-tool-subagent-control,
  // so the global `send_message` is absent even though every dispatch here is
  // durable. This row is mounted by every preset, so register the control tool
  // here. It keeps the official name when that name is still free in this scope
  // and falls back to a distinct one when the Team bundle already owns it (the
  // Team variant takes `target`, not `agent_id`, so the names must not collide).
  let sendToolName = 'continue_subagent'
  try {
    if (ctx.tools?.get?.('send_message') === undefined) sendToolName = 'send_message'
  } catch { /* tools.get unavailable at this scope: keep the distinct name */ }
  ctx.tools.register(defineTool({
    name: sendToolName,
    description: 'Send a message to a durable subagent you created (or to your parent when you are a resident child). A working agent receives it at its next step; an idle agent starts a new turn with it. Returns delivery confirmation, not the answer.',
    parameters: {
      agent_id: { type: 'string', required: true, description: 'The durable subagent id returned by subagent_routed (or your parent agent id).' },
      message: { type: 'string', required: true, description: 'The message to deliver to the agent.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { messageId: { type: 'string', required: true } } },
      render: (args) => [{ type: 'text', text: `message delivered to agent ${args.agent_id}` }],
    },
    async execute(args, exec) {
      const sender = exec.agent
      if (!sender) throw new Error(`${sendToolName} requires a calling agent (exec.agent was undefined)`)
      const message = [{ type: 'text', text: args.message }]
      return { messageId: await ctx.subagents.sendMessage(sender, SessionId(args.agent_id), message, { signal: exec.signal }) }
    },
  }))

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
