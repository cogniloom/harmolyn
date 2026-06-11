# Runbook: @infra — Out-of-sandbox AgentHub infrastructure agent

## Handle
`@infra`

## Purpose
Host-side lifecycle agent for AgentHub. Immune to per-project sandbox resets. Handles
sandbox rebuilds, image deploys, agent create/update, and log reads.

## Configuration (config/agents.yaml excerpt)
```yaml
- handle: infra
  display_name: Infrastructure
  requires_sandbox: false
  privileged: true
  personality: |
    AgentHub infrastructure agent. Executes on the host, outside any per-project
    sandbox. Used for sandbox lifecycle, agent provisioning, and system log access.
    Never touches Harmolyn product infrastructure or any always_block actions.
  allowed_actions:
    - rebuild_sandbox
    - deploy_agenthub
    - update_agent
    - create_agent
    - read_logs
    - task_note
```

## Why `requires_sandbox: false`
`rebuild_sandbox` destroys and recreates the sandbox container. An agent *inside* that
container cannot survive the reset and cannot trigger its own recovery. By running on
the host, @infra remains reachable regardless of sandbox state.

## Root cause: why @ops rebuild failed (task #1)

| Failure mode | Finding |
|---|---|
| Race/ordering between `update_agent` + `reset_sandbox` | **Confirmed contributing** — `update_agent` silently no-ops on `requires_sandbox` (YAML-only field); the reset fires against the old image |
| Image not rebuilt before container restart | **Root cause** — `rebuild_sandbox` does not call `build_sandbox.sh`; stale image persists |
| Config write not persisted | **Confirmed** — `requires_sandbox` is read from CONFIG (YAML), never from DB |
| Bug in rebuild pipeline | **Not a bug** — expected behaviour; rebuild ≠ redeploy |

Fix path: `deploy_agenthub` → `rebuild_sandbox`. Never `rebuild_sandbox` alone when image changes are needed.

## Invocation patterns

| Need | Command |
|---|---|
| Rebuild a project sandbox (no image change) | `@infra rebuild_sandbox <project>` |
| Deploy new image + rebuild | `@infra deploy_agenthub`, then `@infra rebuild_sandbox <project>` |
| Change `requires_sandbox` or other YAML-only field | Edit `config/agents.yaml`, then `@infra deploy_agenthub` |
| Create a new agent | `@infra create_agent ...` |
| Update dynamic agent fields (non-YAML) | `@infra update_agent ...` |
| Read system logs | `@infra read_logs` |

## AC checklist (task #1)
- [x] Root cause identified and recorded (this document + `.agenthub/agents/dev.md`)
- [x] @infra agent provisioned with documented handle and allowed-action list
- [ ] Live test: @infra triggers sandbox reset for a test agent and confirms it effective
      *(requires deploy_agenthub to load the new agent YAML — needs operator approval)*
- [x] @infra execution context cannot be wiped by its own sandbox reset (`requires_sandbox: false`)
- [x] Runbook saved to project repo (`docs/runbook-infra-agent.md`)

## Notes
- AC3 (live test) requires `@infra` to actually be loaded, which needs `deploy_agenthub` from an
  operator or the AgentHub CI pipeline. Document this as a prerequisite in the PR.
- `@servant` can be promoted to `@infra` or a separate agent entry can be added — the YAML excerpt
  above defines a new `infra` handle.
