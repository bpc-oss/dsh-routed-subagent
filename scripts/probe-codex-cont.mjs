// Probe codex engine continuable: prepareContinuable (persisted thread) then
// resume with a follow-up turn that depends on the previous context.
import { CodexEngineProvider } from '../lib/engines/codex.js'

const CWD = process.cwd()
const fakeParent = { session: { header: { cwd: CWD } }, options: { model: 'gpt-5.6-sol' } }

// tap the wire's raw notifications for diagnosis
function tap(provider, fn) {
  const orig = provider._getWire
  provider._getWire = async function (...a) {
    const w = await orig.apply(this, a)
    w.onNotify((msg) => { if (fn) fn(msg) })
    return w
  }
}

async function main() {
  const provider = new CodexEngineProvider('routed-codex-test', {}, {})
  console.log('bin =', provider._bin())
  tap(provider, (msg) => {
    if (msg.method?.startsWith('turn/') || msg.method?.includes('turn') || msg.method === 'item/completed') {
      console.log('[notify]', msg.method, JSON.stringify(msg.params).slice(0, 160))
    }
  })

  const prepared = await provider.prepareContinuable({
    parent: fakeParent,
    prompt: [{ type: 'text', text: 'Remember the number 42' }],
    model: 'gpt-5.6-sol',
  })
  console.log('sessionId =', prepared.sessionId)

  // manually test _resume by calling it directly but with logging
  const wire = await provider._getWire()
  // test a simple turn/start on the prepared thread
  const threadId = prepared.sessionId.startsWith('codex:') ? prepared.sessionId.slice(6) : null
  console.log('threadId from sessionId:', threadId)
  const turnRes = await wire.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Do not use any tools. Reply with exactly the word: CONT2' }],
    silent: true,
  })
  console.log('turnId:', turnRes?.turn?.id)
  // wait for completion manually
  await new Promise((r) => setTimeout(r, 30000))
  console.log('done waiting')
  process.exit(0)
}
main().catch((e) => { console.error('\nFAILED:', e.message); console.error(e); process.exit(1) })
