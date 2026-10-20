import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')

// The full integration smoke needs the PATCHED @deepseek-ai/dsh-subagent fork
// (its `registerExternalContinuation` export). On public CI npm installs the
// official package instead, so skip the integration part there while keeping
// the job green — the patched environment runs it locally.
let patched = false
try {
  const sub = await import('@deepseek-ai/dsh-subagent')
  patched = typeof sub.registerExternalContinuation === 'function'
} catch { patched = false }
if (!patched) {
  console.log('SKIP: patched @deepseek-ai/dsh-subagent not available (official package on public CI) — run smoke locally in the patched harness')
  process.exit(0)
}

const mod = await import('../lib/index.js')
assert.equal(mod.name, 'dsh-routed-subagent')

const tools = []
const providers = []
let bgSpec = null
let continuableCall = null
  let lastSend = null
const services = {
  subagents: {
    registerProvider(p) { providers.push(p) },
    getProvider() { return undefined },
    start: async () => ({
      id: 'run-1',
      result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
      dispose: async () => {},
    }),
    startContinuable: async (spec) => { continuableCall = spec; return { childId: 'sub-ct-1' } },
    sendMessage: async (sender, childId, blocks, opts) => { lastSend = { sender, childId, blocks, opts }; return 'msg-1' },
  },
  agentPresets: {
    resolve: async (id) => {
      if (id === 'nope') throw new Error('unknown preset "nope"')
      return { id, path: 'x' }
    },
    list: async () => [{ id: 'x' }],
  },
  jobs: { start(spec) { bgSpec = spec; return 'job-1' } },
}
const guards = []
const ctx = {
  effect(fn) { return fn() },
  logger: { info() {}, warn() {} },
  tools: { register(t) { tools.push(t); return () => {} }, guard(g) { guards.push(g); return () => {} } },
  subagents: services.subagents,
  agentPresets: services.agentPresets,
  get(key) { return services[key] },
}

mod.apply(ctx, {})
// stock-subagent guard registered (exec.name based)
assert.equal(guards.length, 1)
assert.equal(guards[0]({ name: 'subagent' }), 'the stock subagent tool is disabled — use subagent_routed instead (full preset mount, background by default, live progress, fork + continuable modes)')
assert.equal(guards[0]({ name: 'subagent_fork' }), 'the stock subagent_fork tool is disabled — use subagent_routed instead (full preset mount, background by default, live progress, fork + continuable modes)')
assert.equal(guards[0]({ name: 'subagent_routed' }), undefined, 'guard does not touch subagent_routed')
assert.equal(guards[0]({ name: 'other' }), undefined)
assert.equal(providers.length, 5)
const mount = providers.find((p) => p.name === 'routed-mount')
const fork = providers.find((p) => p.name === 'routed-fork')
const claude = providers.find((p) => p.name === 'routed-claude')
const codex = providers.find((p) => p.name === 'routed-codex')
const codebuddy = providers.find((p) => p.name === 'routed-codebuddy')
assert.ok(mount && fork, 'both routed-mount and routed-fork providers registered')
assert.ok(claude && codex && codebuddy, 'external engine providers registered (claude/codex/codebuddy)')
assert.equal(mount.inheritsParentContext, false)
// Host >= 0.2.0-rc.1 rejects `agentPreset` + inheritsParentContext:true, so BOTH
// providers must publish false; fork inherits context via this plugin's own seed.
assert.equal(fork.inheritsParentContext, false, 'fork must not advertise host-level context inheritance')
assert.deepEqual(mount.capabilities, { agentOptions: true, agentPreset: true, toolFilter: true, persona: false, depthLimit: true, outputSchema: false })
assert.deepEqual(fork.capabilities, mount.capabilities)
assert.equal(mount.capabilities.agentPreset, true, 'host 0.2 gates preset requests on capabilities.agentPreset')
assert.deepEqual(claude.capabilities, { toolFilter: false, persona: false, depthLimit: false, outputSchema: false })
assert.deepEqual(codex.capabilities, claude.capabilities)
assert.deepEqual(codebuddy.capabilities, claude.capabilities)
// The internal seed split survived the decoupling: fork still seeds, fresh does not.
const seedParent = { session: { events: [{ type: 'turn/end', seq: 0 }, { type: 'turn/end', seq: 1 }, { type: 'other' }] } }
assert.equal((await mount.prepareContinuable({ parent: seedParent })).seed, undefined, 'fresh mount carries no parent seed')
const forkSeed = await fork.prepareContinuable({ parent: seedParent })
assert.equal(Array.isArray(forkSeed.seed) && forkSeed.seed.length, 2, 'fork still seeds from the parent turn prefix')
const t = tools.find((x) => x.name === 'subagent_routed')
const controlTool = tools.find((x) => x.name === 'send_message' || x.name === 'continue_subagent')
assert.ok(controlTool, 'control tool (send_message / continue_subagent) registered')
assert.ok(controlTool.parameters.properties.agent_id, 'agent_id parameter present')
assert.ok(controlTool.parameters.properties.message, 'message parameter present')
assert.equal(tools.length, 2)
assert.ok(t, 'subagent_routed registered')
assert.ok(t.parameters.properties.max_depth)
assert.ok(t.parameters.properties.run_in_background)
assert.ok(t.parameters.properties.fork)
assert.deepEqual(t.parameters.properties.tool_filter.required, ['deny'])
assert.ok(!t.parameters.properties.persona, 'persona parameter removed')

const call = (args) => t.execute(args, { agent: { id: 'p', options: { provider: 'bai', model: 'm' } } })

for (const bad of [0, -1, 2.5, '3', NaN]) {
  await assert.rejects(call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: bad }), /max_depth/)
}
await assert.rejects(call({ prompt: 'x', preset: 'nope', description: 'd', max_depth: 3 }), /cannot resolve agent preset/)
// new-param validation
await assert.rejects(call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3, max_tokens: 0 }), /max_tokens/)
await assert.rejects(call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3, tool_filter: {} }), /tool_filter/)
await assert.rejects(call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3, tool_filter: { allow: ['read'] } }), /allow/)
await assert.rejects(call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3, tool_filter: { deny: [] } }), /tool_filter/)

// ── Continue mode: old conversations reach children through THIS tool ────
const sent = await call({ target_agent_id: 'child-1', message: 'continue please' })
assert.equal(sent.kind, 'message')
assert.equal(sent.agentId, 'child-1')
assert.equal(sent.messageId, 'msg-1')
assert.equal(lastSend.childId, 'child-1')
assert.equal(lastSend.blocks[0].text, 'continue please')
await assert.rejects(call({ target_agent_id: 'child-1' }), /continue mode needs BOTH/)

// ── Durability policy: one-shot dispatch is refused ──────────────────────
await assert.rejects(call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3, run_in_background: true }), /one-shot background dispatch is disabled/)
await assert.rejects(call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3, tool_filter: { allow: ['read'] } }), /tool_filter/)

// continuable is the ONLY dispatch path now
const ct = await call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3 })
assert.equal(ct.kind, 'continuable')
assert.equal(ct.subagentId, 'sub-ct-1')
assert.equal(ct.preset, 'dev')
assert.ok(continuableCall, 'startContinuable called')
assert.equal(continuableCall.provider, 'routed-mount')
assert.equal(continuableCall.request.preset, 'dev')
const tfCall = await call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3, tool_filter: { deny: ['write', 'shell'] } })
assert.equal(tfCall.kind, 'continuable')
assert.deepEqual(continuableCall.request.toolFilter, { deny: ['write', 'shell'] }, 'deny-only mask rides the durable request (P47 applies it host-side)')
const ctFork = await call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3, fork: true })
assert.equal(continuableCall.provider, 'routed-fork', 'fork routes to routed-fork')

// ── Team mode refuses parameters it cannot honour ────────────────────────
await assert.rejects(call({ prompt: 'x', preset: 'dev', description: 'd', team: true, model: 'm' }), /team mode does not support model/)
await assert.rejects(call({ prompt: 'x', preset: 'dev', description: 'd', team: true, tool_filter: { deny: ['write'] } }), /team mode does not support tool_filter/)

console.log('smoke OK: durable-only policy (one-shot refused), continuable + fork routing, team param guards, inherited route, start() emits boolean isSeeded + parentAgent')


