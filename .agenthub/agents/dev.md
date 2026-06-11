# @dev agent notes — harmolyn project

## Repo layout

- Harmolyn product code: `cogniloom/harmolyn` (this repo, `/workspace`)
- AgentHub orchestration config: `cogniloom/agenthub` (cloned at `/tmp/agenthub`)
- Per-agent config: `config/agents.yaml` in `cogniloom/agenthub`

## Pipeline task branch convention

Pipeline tasks create branches named `agenthub/task-N-<slug>` on **both** repos when the change touches `cogniloom/agenthub`:
- The actual YAML/code diff lands on the branch in `/tmp/agenthub` (pushed to `cogniloom/agenthub`).
- A corresponding branch on `cogniloom/harmolyn` (this workspace) is required by the gate; use it for updating `.agenthub/agents/dev.md` or other harmolyn-side artifacts.

## Known facts

- `servant` `allowed_actions` was missing `github_merge_pr` (fixed in task-31, commit `4f51696` on `cogniloom/agenthub`). The `require_approval` tier for this action is unchanged.
- `config/agents.yaml` field name for GitHub Projects is `Task Type`, not `Type` (discovered during task-31 grooming).
