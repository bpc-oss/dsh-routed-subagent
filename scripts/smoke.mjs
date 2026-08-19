import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')

const mod = await import('../lib/index.js')
assert.equal(mod.name, 'dsh-routed-subagent')

const tools = []
const providers = []
let bgSpec = null
const services = {
  subagents: {
    registerProvider(p) { providers.push(p) },
    getProvider() { return undefined },
    start: async () => ({
      id: 'run-1',
      result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }], stopReason: 'completed' }),
      dispose: async () => {},
    }),
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
const ctx = {
  effect(fn) { return fn() },
  logger: { info() {}, warn() {} },
  tools: { register(t) { tools.push(t); return () => {} } },
  subagents: services.subagents,
  agentPresets: services.agentPresets,
  get(key) { return services[key] },
}

mod.apply(ctx, {})
assert.equal(providers.length, 1)
assert.equal(providers[0].name, 'routed-mount')
assert.equal(providers[0].inheritsParentContext, false)
assert.deepEqual(providers[0].capabilities, { toolFilter: false, persona: false, depthLimit: true, outputSchema: false })
assert.equal(tools.length, 1)
assert.equal(tools[0].name, 'subagent_routed')
assert.ok(tools[0].parameters.properties.max_depth)
assert.ok(tools[0].parameters.properties.run_in_background)

const t = tools[0]
const call = (args) => t.execute(args, { agent: { id: 'p', options: { provider: 'bai', model: 'm' } } })

for (const bad of [0, -1, 2.5, '3', NaN]) {
  await assert.rejects(call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: bad }), /max_depth/)
}
await assert.rejects(call({ prompt: 'x', preset: 'nope', description: 'd', max_depth: 3 }), /cannot resolve agent preset/)

const bg = await call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3 })
assert.equal(bg.kind, 'background')
assert.equal(bg.jobId, 'job-1')
assert.ok(bgSpec && bgSpec.kind === 'subagent' && bgSpec.owner.id === 'p')
assert.ok(bgSpec.run && typeof bgSpec.run === 'function')
const bgRun = bgSpec.run()
assert.ok(bgRun.cancel && typeof bgRun.cancel === 'function')
assert.ok(bgRun.done && typeof bgRun.done.then === 'function')

const fg = await call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3, run_in_background: false })
assert.equal(fg.kind, 'foreground')
assert.equal(fg.stopReason, 'completed')
assert.equal(fg.output[0].text, 'ok')

console.log('smoke OK: background (default) + foreground verified')
