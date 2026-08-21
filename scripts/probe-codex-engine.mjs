// Standalone end-to-end probe of CodexEngineProvider.start(...) run contract.
// Bypasses the DSH host so it runs anywhere node has @deepseek-ai modules resolved.
// Verifies: foreground completion + progress + kill + model fields.
import { CodexEngineProvider } from '../lib/engines/codex.js'

const CWD = process.cwd()
const fakeParent = { session: { header: { cwd: CWD } }, options: { model: 'gpt-5.6-sol' } }

async function main() {
  const provider = new CodexEngineProvider('routed-codex-test', {}, {})
  console.log('provider ready, CODEX_BIN =', process.env.CODEX_BIN)
  console.log('provider ready, bin =', provider._bin())

  // ── 1) foreground completion ──
  const controller = new AbortController()
  const request = {
    parent: fakeParent,
    prompt: [{ type: 'text', text: 'Reply with exactly one word: PONG' }],
    model: 'gpt-5.6-sol',
    signal: controller.signal,
  }
  console.log('\n=== start() ===')
  const run = await provider.start(request)

  // poll readOutput a few times to show live progress
  const poll = setInterval(() => {
    const o = run.readOutput()
    if (o && o !== 'starting…') console.log('[progress]', JSON.stringify(o.slice(-80)))
  }, 800)

  const done = await run.result
  clearInterval(poll)
  console.log('\n=== run.result ===')
  console.log('stopReason:', done.stopReason)
  console.log('output:', JSON.stringify(done.output))

  // ── 2) background-style: start, poll readOutput for live progress, then await ──
  console.log('\n=== background-style run (poll readOutput for live progress) ===')
  const runB = await provider.start({
    parent: fakeParent,
    prompt: [{ type: 'text', text: 'Write a short Node.js function that computes fibonacci(n). Do not use any tools. Then explain it in one sentence.' }],
    model: 'gpt-5.6-sol',
    signal: new AbortController().signal,
  })
  let probes = 0
  const pollB = setInterval(() => {
    const o = runB.readOutput()
    probes++
    console.log(`[progress #${probes}]`, JSON.stringify(o).slice(-120))
  }, 1200)
  await new Promise((r) => setTimeout(r, 6000))
  clearInterval(pollB)
  const rb = await runB.result
  console.log('=== background-style result ===')
  console.log('stopReason:', rb.stopReason)
  console.log('output len:', rb.output?.[0]?.text?.length, '| progress polls seen:', probes)

  // ── 3) kill path ──
  console.log('\n=== kill test (dispose on an active turn) ===')
  const run2 = await provider.start({
    parent: fakeParent,
    prompt: [{ type: 'text', text: 'List all prime numbers from 1 to 500000, one per line, no other text.' }],
    model: 'gpt-5.6-sol',
    signal: new AbortController().signal,
  })
  await new Promise((r) => setTimeout(r, 3000))
  await run2.dispose() // interrupt
  const r2 = await run2.result
  console.log('after dispose, stopReason:', r2.stopReason, '| output len:', r2.output?.[0]?.text?.length)

  process.exit(0)
}
main().catch((e) => { console.error('\nFAILED:', e.message); console.error(e); process.exit(1) })
