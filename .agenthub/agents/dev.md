# @dev — Developer Agent Notes

## Project: harmolyn

### AgentHub sandbox lifecycle (task #1 findings)

**Root cause of @ops rebuild failure:**

1. `rebuild_sandbox` removes and recreates the container from the *existing* `agenthub-sandbox:latest`
   image — it does **not** rebuild the image. Stale image → stale container after rebuild.
   Fix path: run `deploy_agenthub` first (triggers `build_sandbox.sh`), then `rebuild_sandbox`.

2. `update_agent` cannot change `requires_sandbox` — `_agent_requires_sandbox()` reads from the
   YAML `CONFIG` object at startup, not from the `dynamic_agents` DB. The DB write is silently
   ignored. Changing it requires a YAML edit to `config/agents.yaml` + `!reload` or
   `deploy_agenthub`.

3. `@ops` has `requires_sandbox: true` and `rebuild_sandbox` is not in its `allowed_actions` —
   it cannot trigger its own recovery.

**Out-of-sandbox infra agent (@infra):**

- `requires_sandbox: false`, `privileged: true` — host-side process, immune to sandbox resets.
- `allowed_actions`: `rebuild_sandbox`, `deploy_agenthub`, `update_agent`, `create_agent`,
  `read_logs`, `task_note`.
- Explicitly excludes: Harmolyn prod infra, secrets outside AgentHub scope, any `always_block` actions.
- Runbook: `docs/runbook-infra-agent.md` in this repo.

**GitHub is source of truth:** every task must have a GitHub issue in `cogniloom/harmolyn` before
it exists. AgentHub's internal ledger is a cache only.
