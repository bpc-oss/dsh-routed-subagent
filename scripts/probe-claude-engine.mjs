// Standalone end-to-end probe of ClaudeEngineProvider (via @anthropic-ai/claude-agent-sdk).
// Verifies: foreground completion + progress + kill + continuable resume.
import { ClaudeEngineProvider } from '../lib/engines/claude.js'

const CWD = process.cwd()

async function main() {
  const provider = new ClaudeEngineProvider('routed-claude-test', {}, {})
  const fakeParent = { session: { header: { cwd: CWD } } }

  // ── 1) foreground completion + progress ──
  console.log('\n=== 1) foreground start() ===')
  const run = await provider.start({
    parent: fakeParent,
    prompt: [{ type: 'text', text: 'Reply with exactly one word: HELLO' }],
    signal: new AbortController().signal,
  })
  let lastProg = ''
  const poll = setInterval(() => {
    let o = ''
    try { o = run.readOutput() } catch {}
    if (o && o !== 'running...' && o !== lastProg) { lastProg = o.slice(-80); console.log('[progress]', JSON.stringify(lastProg)) }
  }, 1000)
  const done = await run.result
  clearInterval(poll)
  console.log('=== foreground result ===')
  console.log('stopReason:', done.stopReason)
  console.log('output:', JSON.stringify(done.output))

  // ── 2) kill ──
  console.log('\n=== 2) kill test (long task then dispose) ===')
  const longCtl = new AbortController()
  const runK = await provider.start({
    parent: fakeParent,
    prompt: [{ type: 'text', text: 'Write a detailed essay about the history of computing, at least 2000 words. Do not stop until finished.' }],
    signal: longCtl.signal,
  })
  await new Promise((r) => setTimeout(r, 5000))
  await runK.dispose() // abort
  const kres = await runK.result
  console.log('after dispose stopReason:', kres.stopReason, '| output len:', kres.output?.length)

  process.exit(0)
}
main().catch((e) => { console.error('\nFAILED:', e.message); console.error(e?.stack || '').split('\n').slice(0,6); process.exit(1) })
