import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')

const mod = await import('../lib/index.js')
assert.equal(mod.name, 'dsh-routed-subagent')

const tools = []
const providers = []
let bgSpec = null
let continuableCall = null
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
assert.equal(fork.inheritsParentContext, true)
assert.deepEqual(mount.capabilities, { toolFilter: true, persona: false, depthLimit: true, outputSchema: false })
assert.deepEqual(fork.capabilities, mount.capabilities)
assert.deepEqual(claude.capabilities, { toolFilter: false, persona: false, depthLimit: false, outputSchema: false })
assert.deepEqual(codex.capabilities, claude.capabilities)
assert.deepEqual(codebuddy.capabilities, claude.capabilities)
assert.equal(tools.length, 1)
assert.equal(tools[0].name, 'subagent_routed')
assert.ok(tools[0].parameters.properties.max_depth)
assert.ok(tools[0].parameters.properties.run_in_background)
assert.ok(tools[0].parameters.properties.fork)
assert.ok(!tools[0].parameters.properties.persona, 'persona parameter removed')

const t = tools[0]
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

const bg = await call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3, max_tokens: 4096, tool_filter: { deny: ['write'] } })
assert.equal(bg.kind, 'background')
assert.equal(bg.jobId, 'job-1')
assert.ok(bgSpec && bgSpec.kind === 'subagent' && bgSpec.owner.id === 'p')
assert.ok(bgSpec.run && typeof bgSpec.run === 'function')
const bgRun = bgSpec.run()
assert.ok(bgRun.cancel && typeof bgRun.cancel === 'function')
assert.ok(bgRun.done && typeof bgRun.done.then === 'function')
assert.ok(bgRun.readOutput && typeof bgRun.readOutput === 'function', 'readOutput hook present (live progress)')
const prog = bgRun.readOutput()
assert.ok(typeof prog === 'string' && prog.length > 0, 'readOutput returns a progress string')

// fork dispatch routes to the routed-fork provider
const fk = await call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3, fork: true })
assert.equal(fk.kind, 'background')
assert.equal(fk.jobId, 'job-1')
assert.ok(bgSpec, 'fork jobs.start received a run spec')
assert.equal(typeof bgSpec.run, 'function')
const fkRun = bgSpec.run()
assert.ok(fkRun.cancel && fkRun.done, 'fork background run has cancel+done')

// continuable dispatch returns a durable subagent id via startContinuable
const ct = await call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3, continuable: true })
assert.equal(ct.kind, 'continuable')
assert.equal(ct.subagentId, 'sub-ct-1')
assert.ok(continuableCall, 'startContinuable called with a spec')
assert.equal(continuableCall.provider, 'routed-mount')
assert.equal(continuableCall.request.preset, 'dev')
const ctFork = await call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3, continuable: true, fork: true })
assert.equal(continuableCall.provider, 'routed-fork', 'continuable+fork routes to routed-fork')

const fg = await call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3, run_in_background: false })
assert.equal(fg.kind, 'foreground')
assert.equal(fg.stopReason, 'completed')
assert.equal(fg.output[0].text, 'ok')

console.log('smoke OK: background + foreground + fork + continuable verified; persona removed; tool_filter deny-only; capabilities.toolFilter=true; routed-fork provider registered')


