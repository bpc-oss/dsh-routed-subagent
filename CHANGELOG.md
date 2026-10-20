# Changelog

## [0.4.0] - 20261020 — durable-only dispatch, Agent Team integration, roster archiving

### Behaviour change (breaking)

- **One-shot children removed.** The foreground and background-job dispatch paths were deleted,
  not defaulted off: `run_in_background: true` is refused and a guard throws if a future edit
  falls through. Every dispatch returns a durable id that stays addressable with `send_message`.
- **`tool_filter` is refused on the team path** (a teammate inherits the Lead's route and preset
  composition) and honoured on the dsh durable path through host patch P47.

### Added

- `team: true` — creates a real Agent Team roster teammate (provider + `agentPreset` passthrough).
- `archive_teammate` — retires a teammate: frees the roster slot and the name, hides it from
  `list_agents`, keeps the journal history. Refused while provisioning or owning unfinished tasks.
- `target_agent_id` + `message` — continue an existing durable child from ANY conversation.
- `help: true` — full in-tool usage guide (MODE 1-6, parameters, precedence, refusals).
- A control tool (`send_message` when the name is free, otherwise `continue_subagent`).

### Host patches required (maintained in oh-my-whale)

| patch | fixes |
|---|---|
| P45 | `team:identity` no longer kills descriptor-bearing subagents with `TEAM_NOT_MEMBER` |
| P46 | `spawnAdmitted` forwards `agentPreset`, so a teammate mounts the requested preset |
| P47 | `startLocal` carries `request.toolFilter` into the descriptor and composition |
| P48 | roster archiving: `archived` phase, slot/name release, archived-aware folds |

### Kernel contracts aligned (0.2.1-rc.2)

- `capabilities` declares `agentOptions` and `agentPreset`; `inheritsParentContext` is always
  published `false` (fork seeds through the plugin's own `completedTurnPrefix`).
- `childSessionMeta(parent, childDepth, isSeeded, preset)`, `parentAgent`, and
  `seed` + `inheritedEventCount` match the host; the patch assertion resolves via `createRequire`.

### Verified

- Durable dispatch returns an id and the child answers; a child dispatched with
  `tool_filter: { deny: [write, edit, pwsh, shell, terminal] }` reported none of those tools.
- 9 teammates coexisted (old cap was 8); archive/name-reuse round-trips verified.
- Independent review `review-guide-p48-20261020`: 14 findings, all closed.
