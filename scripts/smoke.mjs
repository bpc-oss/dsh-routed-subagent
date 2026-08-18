// CI smoke test (M3): verifies the module LOADS against the real published
// @deepseek-ai peer packages (this catches API drift — renamed exports,
// changed signatures — which `node --check` cannot) and that apply() registers
// the provider and tool without throwing.
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const assert = require('node:assert/strict')

const mod = await import('../lib/index.js')
assert.equal(mod.name, 'dsh-routed-subagent')

const tools = []
const providers = []
const ctx = {
  effect(fn) { return fn() },
  logger: { info() {}, warn() {} },
  tools: { register(t) { tools.push(t); return () => {} } },
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
}

mod.apply(ctx, {})
assert.equal(providers.length, 1)
assert.equal(providers[0].name, 'routed-mount')
assert.equal(providers[0].inheritsParentContext, false)
assert.deepEqual(providers[0].capabilities, { toolFilter: false, persona: false, depthLimit: true, outputSchema: false })
assert.equal(tools.length, 1)
assert.equal(tools[0].name, 'subagent_routed')
assert.ok(tools[0].parameters.properties.max_depth)

// max_depth validation boundaries (m7): reject 0, fractions, negatives, non-numbers
const t = tools[0]
const call = (args) => t.execute(args, { agent: { id: 'p', options: { provider: 'bai', model: 'm' } } })
for (const bad of [0, -1, 2.5, '3', NaN]) {
  await assert.rejects(call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: bad }), /max_depth/)
}
// unknown preset is rejected by the resolve pre-check (message passed through)
await assert.rejects(call({ prompt: 'x', preset: 'nope', description: 'd', max_depth: 3 }), /cannot resolve agent preset/)
// a valid call dispatches through the stub provider and returns the result
const ok = await call({ prompt: 'x', preset: 'dev', description: 'd', max_depth: 3 })
assert.equal(ok.kind, 'foreground')
assert.equal(ok.stopReason, 'completed')
assert.equal(ok.output[0].text, 'ok')

console.log('smoke OK: module loads against real peers, provider + tool registered, schema compiled, boundaries + dispatch path verified')
