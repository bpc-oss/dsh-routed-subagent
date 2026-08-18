# dsh-routed-subagent


![License](https://img.shields.io/badge/license-MIT-blue) ![Version](https://img.shields.io/github/v/release/bpc-oss/dsh-routed-subagent) ![CI](https://github.com/bpc-oss/dsh-routed-subagent/actions/workflows/ci.yml/badge.svg)

A global [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lets **any session dispatch a one-shot subagent fully mounted on ANY agent preset**, with **per-call model/provider override** and a **model-availability pre-check**.

The stock `subagent` / `subagent_fork` tools force children to inherit the PARENT's preset. This plugin replaces that with a custom subagent provider whose async child setup calls `agentPresets.mount(childCtx, <preset>)` — so the child adopts the TARGET preset's complete composition: persona, prompt sections, skill catalog, and tools.

## Features

- **Any preset, any session** — registered on the host plane (global layer); every preset's conversations get the tool. **New presets need zero configuration.**
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
subagent_routed(
  prompt="Use the dev engineer standard to review this repository",
  preset="dev",                    # any preset id from the roster
  description="dev review",        # display label
  max_depth=2,                     # recursion budget (default 3; positive integer >= 1)
  model="deepseek-v4-flash-free",  # optional: per-call model for the child
  provider="opencode",             # optional: provider for that model
)
```

Behavior:

| input | behavior |
|---|---|
| `preset` invalid / unresolvable | error, with the roster's available preset ids |
| `model` invalid for the provider | fail-fast error listing the provider's candidate models (original error preserved as `cause`) |
| `model` omitted | child inherits this session's model (backwards compatible) |
| `max_depth` not a positive integer | tool-layer validation error |
| valid call | child fully mounted on the target preset, runs one turn, returns final output |

## How it works

1. A custom subagent provider (`routed-mount`) re-implements the official one-shot in-process driver (`dsh-subagent-in-process-driver`'s `startInProcessRun`) with **one load-bearing change**: the child setup is `async` and awaits `agentPresets.mount(childCtx, targetPreset)` instead of composing from the parent.
2. `agents.create` awaits the setup (verified in `dsh-agent-loop`), so the async mount runs inside the unpublished creation window; a failure rolls the whole child back.
3. The child's session header records `agentPreset: <target>` (overriding the parent value), so cold reads rebuild the child under the composition it actually ran.
4. The tool settles the run in two sequential fault-tolerant phases — result first, then dispose — matching the official `settleForegroundRun` ordering (racing dispose against result would skip the child's turn and return "aborted").

## Known limitations

- **One-shot only** — the child is a single-turn expert call (great for review / audit / research). Continuable children (`send_message`) still inherit the parent preset; that is a platform constraint.
- **Failure semantics** — like the official foreground subagent tool, a child that ends with `error` / `refusal` / `max-tokens` makes the tool call THROW (with any partial output attached); only `completed` and caller-initiated `aborted` return as values. Low-level LLM error details live in the child session log.
- **Pre-check is conditional** — the model pre-check runs only when the harness exposes an `llm` service AND a provider route exists (explicit `provider` or the parent's). Without either, it is skipped and the call proceeds.
- **Provider availability is environment-specific** — the pre-check validates against the runtime model catalog, but a reachable provider with a valid key is still required for the call to succeed.

## Development

```bash
node --check lib/index.js   # syntax
```

The plugin is a single ~350-line file with zero build step. CI runs `node --check` on every push.

## License

MIT


