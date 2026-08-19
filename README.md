# dsh-routed-subagent


![License](https://img.shields.io/badge/license-MIT-blue) ![Version](https://img.shields.io/github/v/release/bpc-oss/dsh-routed-subagent) ![CI](https://github.com/bpc-oss/dsh-routed-subagent/actions/workflows/ci.yml/badge.svg)

A global [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lets **any session dispatch a one-shot subagent fully mounted on ANY agent preset**, with **per-call model/provider override** and a **model-availability pre-check**.

The stock `subagent` / `subagent_fork` tools force children to inherit the PARENT's preset. This plugin replaces that with a custom subagent provider whose async child setup calls `agentPresets.mount(childCtx, <preset>)` — so the child adopts the TARGET preset's complete composition: persona, prompt sections, skill catalog, and tools.

## Features


- **Background by default, parallel dispatch** — the call returns a job id immediately (like the stock subagent tool); the conversation stays free to do other work or dispatch more children in parallel, and aborting the conversation does NOT cancel the child (stop it with job_kill). Set un_in_background: false to wait inline.**
- **Full preset mount** — the child runs under the target preset's standing composition (not a persona copy): identity, mission section, skills, tools.
- **Per-call model override** — `model` / `provider` arguments route the child's LLM call to a different model than this session's (via the official `resolveChildAgentOptions` channel).
- **Model pre-check** — an invalid model fails fast with the provider's candidate list instead of an opaque child failure.
- **Official subagent ecosystem** — one-shot lifecycle events, UI rows, trajectory; returns the child's final output.
- **Idempotent provider registration** — multiple presets can mount the row; the host-plane provider registry is never duplicated.

## Distribution

**GitHub-only.** This plugin is not published to npm. Install it by mounting the package directory (see below). `peerDependencies` are declared with real semver ranges as metadata; they are not used for npm resolution.

**Compatibility**: targets DeepSeek Harness **rc.7** (behavior verified against rc.7 sources) (the async child setup that this plugin relies on is a recent harness behavior).

## Install

The plugin is a plain ESM package with a `cordis.patch.yml` bundle declaration.

### 1. Link the package into the harness install

The plugin statically imports `@deepseek-ai/*` packages, which resolve via Node ESM from the package location. Create a `node_modules` junction/symlink in the package directory pointing at the harness install:

```bat
:: Windows
mklink /J "<plugin-dir>\node_modules" "<harness>\resources\host\node_modules"
```

```sh
# POSIX (Linux/macOS)
ln -s "<harness>/resources/host/node_modules" "<plugin-dir>/node_modules"
```

### 2. Add the bundle to a profile

Add the package to your profile's `dsh.profile.bundles` list (e.g. `<dshHome>/profiles/web/package.json`):

```json
{
  "dependencies": { "dsh-routed-subagent": "link:<plugin-dir>" },
  "dsh": { "profile": { "bundles": ["...", "dsh-routed-subagent"] } }
}
```

`cordis.patch.yml` in this repo is the bundle layer that registers the plugin; it is applied automatically when the package is listed in `bundles`.

> Tip: if your deployment provides a hot-assembly helper (e.g. a super-injector-style `dev_install_package(dir=...)`), you can use it instead of the manual steps above; restarts re-assemble from the `bundles` list either way.

## Usage

```
subagent_routed(prompt="Use the dev engineer standard to review this repository", preset="dev", description="dev review")          # background one-shot
subagent_routed(prompt="Continue the review", preset="dev-reviewer", description="follow-up", fork=true)  # inherits THIS conversation
subagent_routed(preset="dev", prompt="Audit this repo", description="audit", continuable=true)            # send_message(<subagentId>, ...) later
```

Behavior:

Modes (one tool, four shapes):

| mode | how | returns |
|---|---|---|
| one-shot background (default) | `run_in_background: true` (default) | job id immediately; collect with `job_output` (live progress) / stop with `job_kill`; aborting the conversation leaves the child running |
| one-shot foreground | `run_in_background: false` | blocks until the child returns its final output |
| fork | `fork: true` | job id / run result — the child is seeded with this conversation's COMPLETED turns (inherits the context) then mounts the requested preset on top |
| continuable | `continuable: true` | durable subagent id — continue it later with `send_message(subagentId, ...)`; the child mounts the requested preset and keeps it across resumes |

Parameters:

| input | behavior |
|---|---|
| `preset` invalid / unresolvable | error, with the roster's available preset ids |
| `model` / `provider` | per-call model override (fail-fast pre-check lists the provider's candidates; original error preserved as `cause`) |
| `max_tokens` | output/token cap for the child's LLM calls (positive integer) |
| `tool_filter` | DENY-only tool mask on top of the preset's tool surface (`{ deny: string[] }`, e.g. deny shell tools for a read-only audit) |
| `max_depth` not a positive integer | tool-layer validation error |
| `fork` + `continuable` together | supported (continuable fork seeds the parent's completed turns) |
| valid call | child fully mounted on the target preset |

## How it works

1. A custom subagent provider (`routed-mount`) re-implements the official one-shot in-process driver (`dsh-subagent-in-process-driver`'s `startInProcessRun`) with **one load-bearing change**: the child setup is `async` and awaits `agentPresets.mount(childCtx, targetPreset)` instead of composing from the parent.
2. `agents.create` awaits the setup (verified in `dsh-agent-loop`), so the async mount runs inside the unpublished creation window; a failure rolls the whole child back.
3. The child's session header records `agentPreset: <target>` (overriding the parent value), so cold reads rebuild the child under the composition it actually ran.
4. The tool settles the run in two sequential fault-tolerant phases — result first, then dispose — matching the official `settleForegroundRun` ordering (racing dispose against result would skip the child's turn and return "aborted").

## Known limitations

- **preset generation drift (known limitation)** — `mount` re-resolves the preset by id on every creation/resume, so editing a preset file between continuable turns hands later turns a NEWER generation of that preset (the official `composeFrom` path joins the parent's exact standing instance instead). Documented behavior; restore the preset to its original state to keep turns consistent.
- **Failure semantics** — like the official foreground subagent tool, a child that ends with `error` / `refusal` / `max-tokens` makes the tool call THROW (with any partial output attached); only `completed` and caller-initiated `aborted` return as values. Low-level LLM error details live in the child session log.
- **Pre-check is conditional** — the model pre-check runs only when the harness exposes an `llm` service AND a provider route exists (explicit `provider` or the parent's). Without either, it is skipped and the call proceeds.
- **Provider availability is environment-specific** — the pre-check validates against the runtime model catalog, but a reachable provider with a valid key is still required for the call to succeed.


## Platform patch (continuable + preset mount)

`continuable` mode mounts the requested preset on the child **and keeps it across resumes** — that required a small, additive patch to the open-source `@deepseek-ai/dsh-subagent`:

- **install-level junction** (single assembly point): `resources\host\node_modules\@deepseek-ai\dsh-subagent` → the patched fork (the original package is backed up beside it). The plugin's startup assertion logs a loud warning if the loaded instance is not the patched fork — continuable+preset will silently degrade to the parent composition, so check the log on upgrade. Do NOT add a profile-local `link:` dependency to `@deepseek-ai/dsh-subagent` (that would split module identity and defeat the patch).
- **patch surface** (additive only — official paths with no `preset` are byte-identical):
  - `applyChildComposition`: `composition.preset` mounts the TARGET preset instead of joining the parent's (`composeFrom` skipped — a second bind would throw; delegation context / persona / toolFilter kept); appends `agent-preset/selected(target)` so fork seeds replaying the parent's selection events cannot shadow the header on cold rebuild
  - `materializeTracked` setup is async (awaited by the agent factory) and still returns the `{ commit }` contract
  - continuable descriptors gain an optional `preset` field (version 2 → 3 for continuable only; one-shot stays 2 — a rollback rejects v3 descriptors cleanly as NOT_RESUMABLE, and legacy v2 continuable descriptors still parse)
  - `coldResume` rebuilds the child under the SAME preset from `descriptor.preset`; a missing/broken preset surfaces a named-preset error instead of a generic "unavailable"
- **rollback**: delete the install junction (esources\host\node_modules\@deepseek-ai\dsh-subagent), copy E:\ai-files\@deepseek-ai\dsh-subagent.orig back into place, restart — official behavior returns (pre-existing preset-continuable children become NOT_RESUMABLE, as designed). Note: keep the fork directory present if any other profile tree junctions to it (dsh-continuous-worker\node_modules\@deepseek-ai\dsh-subagent) still exist, or re-point them.

## Disabling the stock subagent tools

Once the full stock surface is ported, `subagent_routed` becomes the single delegation entry point: a global `tools.guard` denies `subagent` / `subagent_fork` at execution with a redirect message (`config.disableStockSubagent ?? true`; set `false` to keep them). Scope: every preset that mounts this plugin row.

## Development

```bash
node --check lib/index.js   # syntax
```

The plugin is a single ~350-line file with zero build step. CI runs `node --check` on every push.

## License

MIT








