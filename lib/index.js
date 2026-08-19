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
import { foldConsumedWork } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  appendDelegatedPolicyOverrides,
  assertSubagentMaxDepth,
  captureDelegatedPolicyOverrides,
  childSessionMeta,
  finalAssistantOutput,
  resolveChildAgentOptions,
  resolveChildDepth,
  settleRun,
} from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'

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
function drivePresetRun(handle, signal, prompt, childId) {
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
      return readPresetResult(child, flags.cancelled)
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
function readPresetResult(child, cancelled) {
  const own = child.session.events.slice(0)
  const lastEnd = foldConsumedWork(own).end
  const output = finalAssistantOutput(own) ?? []
  const recorded = toStopReason(lastEnd?.data.reason)
  const stopReason = cancelled && recorded !== 'completed' ? 'aborted' : recorded
  return { output, stopReason }
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

export function apply(ctx, config = {}) {
  const providerName = config.providerName ?? 'routed-mount'
  const toolName = config.toolName ?? 'subagent_routed'
  const agentPresets = ctx.agentPresets

  // ── 1) custom provider: full preset mount on the child ────────────────────
  const provider = {
    name: providerName,
    // Declare ONLY what start() actually implements. toolFilter/persona are
    // deliberately false: the child's persona/tool surface comes from the
    // mounted preset, not from per-request overrides. depthLimit is true: the
    // tool passes maxDepth (default 3) so recursive delegation is bounded.
    // outputSchema is false: no structured-output contract is implemented.
    capabilities: {
      toolFilter: false,
      persona: false,
      depthLimit: true,
      outputSchema: false,
    },
    // The child is a fresh session with no inherited parent conversation
    // (same as the official spawn provider) — declare it explicitly.
    inheritsParentContext: false,
    async start(request) {
      assertSubagentMaxDepth(request.maxDepth)
      if (request.signal.aborted) throw new Error('subagent request was aborted before child publication')
      const parent = request.parent
      const targetPreset = request.preset
      if (typeof targetPreset !== 'string' || targetPreset.length === 0) {
        throw new Error(`${providerName}: request.preset is required (the preset id the child should mount)`)
      }
      const childDepth = resolveChildDepth(parent, request.maxDepth)
      const childId = SessionId(randomUUID())
      const inherited = captureDelegatedPolicyOverrides(parent)

      const setup = async (childCtx) => {
        appendDelegatedPolicyOverrides(childCtx.agent.session, inherited)
        // THE load-bearing line: mount the requested preset (async setup is
        // awaited by the agent factory), replacing parent composition.
        await agentPresets.mount(childCtx, targetPreset)
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
          meta: { ...childSessionMeta(parent, childDepth, 0), agentPreset: targetPreset },
          agentOptions: resolveChildAgentOptions(parent, request.agentOptions, childDepth),
          signal: request.signal,
          setup,
        }),
        request.signal,
        request.prompt,
        childId,
      )
    },
  }
  // The provider registry is a PROCESS SINGLETON shared by every preset that
  // mounts this row — register once, skip duplicates, never throw.
  if (ctx.subagents.getProvider(providerName) === undefined) {
    ctx.subagents.registerProvider(provider)
  } else {
    ctx.logger?.info?.(`${name}: provider "${providerName}" already registered on the host plane; skipping duplicate`)
  }

  // ── 2) tool: subagent_routed ───────────────────────────────────────────
  const defaultMaxDepth = config.maxDepth ?? 3
  const defaultBackground = config.runInBackground ?? true
  ctx.effect(() => ctx.tools.register(defineTool({
    name: toolName,
    description: 'Run a subagent fully mounted on a SPECIFIED agent preset, from any session — the child adopts that preset\'s complete composition (persona, prompt sections, skill catalog, tools), unlike the stock subagent tools which inherit this session\'s own preset. BACKGROUND by default (like the stock subagent tool): the call returns a job id immediately, the child runs independently (survives aborting this conversation; collect with job_output or stop with job_kill), and you can dispatch several in parallel. Set run_in_background: false to wait for the result inline (the conversation blocks until the child returns).',
    parameters: {
      prompt: { type: 'string', required: true, description: 'The complete, self-contained task for the subagent. It does not share this conversation\'s context, so include everything it needs.' },
      preset: { type: 'string', required: true, description: 'The agent preset id the child should mount (e.g. "dev", "standard", "router-standard"). Must exist in the roster.' },
      description: { type: 'string', required: true, description: 'A short (3-5 word) description of the delegated task, for display.' },
      max_depth: { type: 'number', description: 'Recursion budget for the child\'s own delegations (default ' + defaultMaxDepth + '; must be a positive integer >= 1).' },
      model: { type: 'string', description: 'The model id the CHILD should use (overrides this session\'s model for this call only). Must be valid under the chosen provider; if invalid, the child fails with the LLM routing error. Omit to inherit this session\'s model.' },
      provider: { type: 'string', description: 'The provider name for the child\'s model (defaults to this session\'s provider when model is set without provider).' },
      run_in_background: { type: 'boolean', description: 'Default true: return a job id immediately and run the child independently (parallel dispatch; survives conversation abort). Set false to wait for the child\'s final output inline.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          kind: { type: 'string', required: true, enum: ['background', 'foreground'] },
          jobId: { type: 'string' },
          runId: { type: 'string' },
          preset: { type: 'string', required: true },
          provider: { type: 'string' },
          model: { type: 'string' },
          stopReason: { type: 'string' },
          output: { type: 'array', items: { type: 'json' } },
        },
      },
      render: (_args, value) => value.kind === 'background'
        ? [{ type: 'text', text: `started background subagent job ${value.jobId} on preset "${value.preset}"${value.model ? ' @ ' + value.provider + '/' + value.model : ''} — the conversation is free to continue; collect with job_output / stop with job_kill` }]
        : [{ type: 'text', text: `[subagent_routed ${value.preset}${value.model ? ' @ ' + value.provider + '/' + value.model : ''} | ${value.stopReason}]\n${(value.output ?? []).filter((b) => b && b.type === 'text').map((b) => b.text).join('')}` }],
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
      const agentOptions = {}
      if (args.provider !== undefined && args.provider !== '') agentOptions.provider = args.provider
      if (args.model !== undefined && args.model !== '') agentOptions.model = args.model

      // model availability pre-check: fail fast with a candidate list instead
      // of letting the child's LLM route fail opaquely. The original
      // resolveModelInfo error is preserved as the Error `cause` so a provider
      // outage is distinguishable from a genuinely unknown model. Runs whenever
      // a model OR provider override was given (a provider-only override
      // resolves against the parent's model, which is almost always invalid —
      // catch it here). Skipped when the harness exposes no llm service.
      if (agentOptions.model !== undefined || agentOptions.provider !== undefined) {
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
      const request = {
        label: args.description,
        prompt: [{ type: 'text', text: args.prompt }],
        parent,
        preset: args.preset,
        ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
        maxDepth: resolveMaxDepth(args.max_depth, defaultMaxDepth, toolName),
      }

      if (background) {
        // BACKGROUND: dispatch through the jobs service with an INDEPENDENT
        // AbortController. The call returns a job id immediately — the
        // conversation is free to do other work or dispatch more children in
        // parallel, and aborting this conversation does NOT cancel the child
        // (stop it explicitly with job_kill). Same semantics as the official
        // background subagent tool.
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
            return {
              cancel: (reason) => controller.abort(reason ?? 'background subagent task killed'),
              done: settleRun(ctx.subagents.start(providerName, { ...request, signal: controller.signal }), controller.signal),
            }
          },
        })
        return {
          kind: 'background',
          jobId,
          preset: args.preset,
          ...(Object.keys(agentOptions).length > 0 ? { provider: agentOptions.provider, model: agentOptions.model } : {}),
        }
      }

      const run = await ctx.subagents.start(providerName, { ...request, signal: exec.signal })
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
        ...(Object.keys(agentOptions).length > 0 ? { provider: agentOptions.provider, model: agentOptions.model } : {}),
        stopReason: result.stopReason,
        output: result.output ?? [],
      }
    },
  })), 'dsh-routed-subagent tool')
}
