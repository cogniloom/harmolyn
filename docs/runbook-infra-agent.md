# Runbook: @infra — Out-of-sandbox AgentHub infrastructure agent

## Handle

`@infra`

## Purpose

Host-side lifecycle agent for AgentHub. Immune to per-project sandbox resets. Handles
sandbox resets, image deploys, agent create/update, and log reads.

## Configuration (config/agents.yaml)

The full definition lives in `config/agents.yaml` (committed to this repo):

```yaml
- handle: infra
  display_name: Infrastructure
  requires_sandbox: false
  privileged: true
  allowed_actions:
    - reset_sandbox
    - deploy_agenthub
    - update_agent
    - create_agent
    - read_logs
    - task_note
  excluded_scopes:
    - harmolyn_prod_infra
    - secrets_outside_agenthub
```

## Why `requires_sandbox: false`

`reset_sandbox` destroys and recreates the sandbox container. An agent _inside_ that
container cannot survive the reset and cannot trigger its own recovery. By running on
the host, @infra remains reachable regardless of sandbox state.

## Root cause: why @ops rebuild failed (task #1)

| Failure mode                                            | Finding                                                                                                                                      |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Race/ordering between `update_agent` + `reset_sandbox`  | **Confirmed contributing** — `update_agent` silently no-ops on `requires_sandbox` (YAML-only field); the reset fired against the old image   |
| Image not rebuilt before container restart              | **Root cause** — `reset_sandbox` does not call `build_sandbox.sh`; stale image persists                                                     |
| Config write not persisted                              | **Confirmed** — `requires_sandbox` is read from CONFIG (YAML) at startup, never from DB                                                     |
| Bug in rebuild pipeline                                 | **Not a bug** — expected behaviour; `reset_sandbox` ≠ `deploy_agenthub`                                                                     |

Fix path: `deploy_agenthub` (builds new image) → `reset_sandbox` (restarts container from new image).
Never `reset_sandbox` alone when image changes are needed.

### Log evidence (task #1)

Extracted from AgentHub system logs covering the `update_agent` + `reset_sandbox` sequence for `@ops`:

```
[2026-06-07 08:31:14] INFO  update_agent: writing requires_sandbox=true→false to dynamic_agents DB for ops
[2026-06-07 08:31:14] WARN  update_agent: requires_sandbox is a YAML-only field; DB write will be ignored at runtime
[2026-06-07 08:31:15] INFO  reset_sandbox: stopping container agenthub-ops-sandbox
[2026-06-07 08:31:16] INFO  reset_sandbox: recreating container from image agenthub-sandbox:latest (image unchanged)
[2026-06-07 08:31:17] INFO  reset_sandbox: container started — requires_sandbox still reads True from YAML CONFIG
[2026-06-07 08:31:17] WARN  _agent_requires_sandbox(ops): returning True (YAML); DB value False ignored
```

These log lines confirm: (a) the DB write was acknowledged with a warning, (b) `reset_sandbox` reused
the existing image without calling `build_sandbox.sh`, and (c) the runtime re-read `requires_sandbox`
from YAML, discarding the DB update.

## Invocation patterns

| Need                                                | Command                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------ |
| Reset a project sandbox (container only)            | `@infra reset_sandbox <project>`                                   |
| Deploy new image + reset                            | `@infra deploy_agenthub`, then `@infra reset_sandbox <project>`    |
| Change `requires_sandbox` or other YAML-only field  | Edit `config/agents.yaml`, then `@infra deploy_agenthub`           |
| Create a new agent                                  | `@infra create_agent ...`                                          |
| Update dynamic agent fields (non-YAML)              | `@infra update_agent ...`                                          |
| Read system logs                                    | `@infra read_logs`                                                 |

## AC checklist (task #1)

- [x] Root cause identified and recorded (this document + `.agenthub/agents/dev.md` + log evidence above)
- [x] @infra agent provisioned with documented handle and allowed-action list including `reset_sandbox`
      (`config/agents.yaml` committed to this branch)
- [ ] Live test: @infra triggers `reset_sandbox` for a test agent and confirms it effective
      _(requires `deploy_agenthub` to load the new agent YAML — needs operator approval)_
- [x] @infra execution context cannot be wiped by its own sandbox reset (`requires_sandbox: false`)
- [x] Runbook for invoking @infra saved to project repo (`docs/runbook-infra-agent.md`)

## Notes

- AC3 (live test) requires `@infra` to actually be loaded, which needs `deploy_agenthub` from an
  operator or the AgentHub CI pipeline. This is the only remaining open item.
- `config/agents.yaml` is the source of truth for agent definitions. Load order:
  1. `deploy_agenthub` runs `build_sandbox.sh` and reloads YAML CONFIG
  2. `reset_sandbox` restarts the container from the newly built image
