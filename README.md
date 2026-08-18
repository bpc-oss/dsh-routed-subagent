# dsh-preset-subagent

A global [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that lets **any session dispatch a one-shot subagent fully mounted on ANY agent preset**, with **per-call model/provider override** and a **model-availability pre-check**.

The stock `subagent` / `subagent_fork` tools force children to inherit the PARENT's preset. This plugin replaces that with a custom subagent provider whose async child setup calls `agentPresets.mount(childCtx, <preset>)` — so the child adopts the TARGET preset's complete composition: persona, prompt sections, skill catalog, and tools.

## Features

- **Any preset, any session** — registered on the host plane (global layer); every preset's conversations get the tool. New presets need zero configuration.
- **Full preset mount** — the child runs under the target preset's standing composition (not a persona copy): identity, mission section, skills, tools.
- **Per-call model override** — `model` / `provider` arguments route the child's LLM call to a different model than this session's (via the official `resolveChildAgentOptions` channel).
- **Model pre-check** — an invalid model fails fast with the provider's candidate list instead of an opaque child failure.
- **Official subagent ecosystem** — one-shot lifecycle events, UI rows, trajectory; returns the child's final output.
- **Idempotent provider registration** — multiple presets can mount the row; the host-plane provider registry is never duplicated.

## Install

The plugin is a plain ESM package. Point the package directory at the DeepSeek Harness installation and hot-install it:

```bash
# the package's node_modules junction must point at the harness install:
#   E:\ai-files\dsh-preset-subagent\node_modules  ->  <harness>\resources\host\node_modules
# (create it with: mklink /J node_modules "<harness>\resources\host\node_modules")
```

Then install into the profile:

```
dev_install_package(dir=E:\ai-files\dsh-preset-subagent)
```

This hot-assembles the plugin (no restart) and persists it in the profile `bundles` list so it survives restarts. To reload after editing: `dev_reload_package(dsh-preset-subagent)`.

> **Windows junction requirement** — the plugin statically imports `@deepseek-ai/*` packages. Those resolve via Node ESM from the package location, so the package directory needs a `node_modules` junction to the harness install (Node resolves through realpath). See the note above.

## Usage

```
subagent_as_preset(
  prompt="Use the dev engineer standard to review this repository",
  preset="dev",                    # any preset id from the roster
  description="dev review",        # display label
  max_depth=2,                     # recursion budget (default 3)
  model="deepseek-v4-flash-free",  # optional: per-call model for the child
  provider="opencode",             # optional: provider for that model
)
```

Behavior:

| input | behavior |
|---|---|
| `preset` missing/invalid | error listing all available preset ids |
| `model` invalid for the provider | fail-fast error listing the provider's candidate models |
| `model` omitted | child inherits this session's model (backwards compatible) |
| valid call | child fully mounted on the target preset, runs one turn, returns final output |

## How it works

1. A custom subagent provider (`preset-mount`) re-implements the official one-shot in-process driver (`dsh-subagent-in-process-driver`'s `startInProcessRun`) with **one load-bearing change**: the child setup is `async` and awaits `agentPresets.mount(childCtx, targetPreset)` instead of composing from the parent.
2. `agents.create` awaits the setup (verified in `dsh-agent-loop`), so the async mount runs inside the unpublished creation window; a failure rolls the whole child back.
3. The child's session header records `agentPreset: <target>` (overriding the parent value), so cold reads rebuild the child under the composition it actually ran.
4. The tool settles the run in two sequential fault-tolerant phases — result first, then dispose — matching the official `settleForegroundRun` (racing dispose against result would skip the child's turn and return "aborted").

## Known limitations

- **One-shot only** — the child is a single-turn expert call (great for review / audit / research). Continuable children (`send_message`) still inherit the parent preset; that is a platform constraint.
- **Model errors surface as `error`** — like the official tools, the plugin returns `stopReason`; low-level LLM error details are not embedded in the tool result (visible in the child session log).
- **Provider availability is environment-specific** — the pre-check validates the model against the runtime model catalog, but a reachable provider with a valid key is still required for the call to succeed.

## Development

```bash
node --check lib/index.js   # syntax
```

The plugin is intentionally small (~270 lines) with zero build step.

## License

MIT
