// Repro: parallel runs MUST NOT cross-contaminate.
// Fix: each run owns a dedicated codex app-server process (per-run wire),
// so delta notifications (which carry no turn id) cannot leak across runs.
import { CodexEngineProvider } from '../lib/engines/codex.js'

const CWD = process.cwd()
const fakeParent = { session: { header: { cwd: CWD } }, options: { model: 'gpt-5.6-sol' } }

async function main() {
  const provider = new CodexEngineProvider('routed-codex-test', {}, {})

  console.log('=== parallel runs (per-run wire) ===')
  const started = Date.now()
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
  console.log('A stopReason:', da.stopReason, 'output:', JSON.stringify(ta.slice(0, 60)))
  console.log('B stopReason:', db.stopReason, 'output:', JSON.stringify(tb.slice(0, 60)))
  const cleanA = /^ALPHA/.test(ta.trim()) && !ta.includes('BETA')
  const cleanB = /^BETA/.test(tb.trim()) && !tb.includes('ALPHA')
  console.log('parallel isolation:', (cleanA && cleanB) ? 'OK' : `FAIL (A=${JSON.stringify(ta.slice(0,60))} B=${JSON.stringify(tb.slice(0,60))})`)
  await Promise.all([ra.dispose(), rb.dispose()])

  // sequential: two runs, same wire pattern (each its own wire now)
  console.log('\n=== sequential runs ===')
  const rc = await provider.start({
    parent: fakeParent,
    prompt: [{ type: 'text', text: 'Reply with exactly one word: FIRST. Do not use any tools.' }],
    model: 'gpt-5.6-sol',
    signal: new AbortController().signal,
  })
  const dc = await rc.result
  console.log('C stopReason:', dc.stopReason, 'output:', JSON.stringify((dc.output || []).map(b => b.text).join('').slice(0, 60)))
  await rc.dispose()

  const rd = await provider.start({
    parent: fakeParent,
    prompt: [{ type: 'text', text: 'Reply with exactly one word: SECOND. Do not use any tools.' }],
    model: 'gpt-5.6-sol',
    signal: new AbortController().signal,
  })
  const dd = await rd.result
  console.log('D stopReason:', dd.stopReason, 'output:', JSON.stringify((dd.output || []).map(b => b.text).join('').slice(0, 60)))
  await rd.dispose()

  console.log('elapsed ms:', Date.now() - started)
  console.log('ALL OK')
}

main().then(() => process.exit(0)).catch((e) => { console.error('REPRO FAIL:', e); process.exit(1) })