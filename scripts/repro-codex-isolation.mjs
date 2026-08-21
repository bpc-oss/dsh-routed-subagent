// Repro script: two sequential runs on the SHARED codex wire — the exact
// scenario that produced mixed output (probe + full task) and bogus
// "interrupted". Verifies the turn/thread isolation fix.
import { CodexEngineProvider } from '../lib/engines/codex.js'

const CWD = process.cwd()
const fakeParent = { session: { header: { cwd: CWD } }, options: { model: 'gpt-5.6-sol' } }

async function main() {
  const provider = new CodexEngineProvider('routed-codex-test', {}, {})
  console.log('bin =', provider._bin())

  // ── Run 1: minimal probe (like the CODEX_ENGINE_OK check) ──
  console.log('\n=== RUN 1: minimal probe ===')
  const r1 = await provider.start({
    parent: fakeParent,
    prompt: [{ type: 'text', text: 'Reply with exactly one word: PONG. Do not use any tools.' }],
    model: 'gpt-5.6-sol',
    signal: new AbortController().signal,
  })
  const d1 = await r1.result
  console.log('run1 stopReason:', d1.stopReason)
  console.log('run1 output:', JSON.stringify((d1.output || []).map(b => b.text).join('').slice(0, 120)))
  await r1.dispose()

  // ── Run 2: longer task on the SAME wire (would previously leak run-1 events) ──
  console.log('\n=== RUN 2: longer task (same wire) ===')
  const r2 = await provider.start({
    parent: fakeParent,
    prompt: [{ type: 'text', text: 'Write a short 3-line poem about the ocean. Do not use any tools.' }],
    model: 'gpt-5.6-sol',
    signal: new AbortController().signal,
  })
  const poll = setInterval(() => {
    const o = r2.readOutput()
    if (o && o !== 'starting…') console.log('[progress]', JSON.stringify(o.slice(-100)))
  }, 1500)
  const d2 = await r2.result
  clearInterval(poll)
  console.log('run2 stopReason:', d2.stopReason)
  const t2 = (d2.output || []).map(b => b.text).join('')
  console.log('run2 output head:', JSON.stringify(t2.slice(0, 200)))
  await r2.dispose()

  // ── Run 3: concurrent with run 2 pattern — two parallel runs on same wire ──
  console.log('\n=== RUN 3+4: parallel runs on same wire ===')
  const [ra, rb] = await Promise.all([
    provider.start({
      parent: fakeParent,
      prompt: [{ type: 'text', text: 'Reply with exactly one word: ALPHA. Do not use any tools.' }],
      model: 'gpt-5.6-sol',
      signal: new AbortController().signal,
    }),
    provider.start({
      parent: fakeParent,
      prompt: [{ type: 'text', text: 'Reply with exactly one word: BETA. Do not use any tools.' }],
      model: 'gpt-5.6-sol',
      signal: new AbortController().signal,
    }),
  ])
  const [da, db] = await Promise.all([ra.result, rb.result])
  const ta = (da.output || []).map(b => b.text).join('')
  const tb = (db.output || []).map(b => b.text).join('')
  console.log('A stopReason:', da.stopReason, 'output:', JSON.stringify(ta.slice(0, 80)))
  console.log('B stopReason:', db.stopReason, 'output:', JSON.stringify(tb.slice(0, 80)))
  const clean = !(ta.includes('BETA') || tb.includes('ALPHA'))
  console.log('parallel isolation:', clean ? 'OK (no cross-contamination)' : 'FAIL (mixed outputs!)')
  await Promise.all([ra.dispose(), rb.dispose()])

  // teardown: provider.dispose must kill the wire process
  console.log('\n=== teardown ===')
  await provider.dispose()
  console.log('provider.dispose() done — wire killed')
}

main().then(() => process.exit(0)).catch((e) => { console.error('REPRO FAIL:', e); process.exit(1) })
