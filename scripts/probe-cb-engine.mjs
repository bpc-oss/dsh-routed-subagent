// Standalone E2E probe of CodebuddyEngineProvider.
// Verifies: foreground completion + kill + continuable.
import { CodebuddyEngineProvider } from '../lib/engines/codebuddy.js'

const CWD = process.cwd()
const fakeParent = { session: { header: { cwd: CWD } } }

async function main() {
  const provider = new CodebuddyEngineProvider('routed-cb-test', {}, {})
  console.log('bin =', provider._bin())

  // ── 1) foreground completion ──
  console.log('\n=== 1) foreground start() ===')
  const run = await provider.start({
    parent: fakeParent,
    prompt: [{ type: 'text', text: 'Reply with exactly one word: ACE' }],
    signal: new AbortController().signal,
  })
  let lastProg = ''
  const poll = setInterval(() => {
    try { const o = run.readOutput(); if (o && o !== lastProg && o !== 'starting…') { lastProg = o.slice(-80); console.log('[progress]', JSON.stringify(lastProg)) } } catch {}
  }, 800)
  const done = await run.result
  clearInterval(poll)
  console.log('=== result ===')
  console.log('stopReason:', done.stopReason)
  console.log('output:', JSON.stringify(done.output))

  // ── 2) continuable: prepareContinuable + resume ──
  console.log('\n=== 2) continuable ===')
  const prep = await provider.prepareContinuable({
    parent: fakeParent,
    prompt: [{ type: 'text', text: 'Remember the number 99. Reply with: DONE' }],
  })
  console.log('sessionId:', prep.sessionId)
  const r1 = await prep.resume([{ type: 'text', text: 'What number did I remember? Reply with just that number.' }], new AbortController().signal)
  console.log('resume stopReason:', r1.stopReason)
  console.log('resume output:', JSON.stringify(r1.output))

  // ── 3) kill ──
  console.log('\n=== 3) kill test ===')
  const runK = await provider.start({
    parent: fakeParent,
    prompt: [{ type: 'text', text: 'Write a very long essay about the history of AI, at least 500 words.' }],
    signal: new AbortController().signal,
  })
  await new Promise((r) => setTimeout(r, 5000))
  await runK.dispose()
  const kres = await runK.result
  console.log('after dispose stopReason:', kres.stopReason)
  console.log('output len:', kres.output?.[0]?.text?.length)

  process.exit(0)
}
main().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1) })