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
- `servant` must NOT have `create_task` in `allowed_actions`; dev-work requests go through `github_open_issue` to preserve the intake pipeline (inbox → PO spec → PM grooming → ready → in_progress). Fixed in task-32. See deploy checklist below.
- `all_agents()` in `agenthub.py` overlays `dynamic_agents` DB rows on top of static YAML — a DB row for an agent silently wins over any YAML-only edit. After deploying a YAML `allowed_actions` change for `servant`, check for and delete any stale `dynamic_agents` row:
  ```sql
  SELECT name, allowed_actions_json FROM dynamic_agents WHERE name='servant';
  DELETE FROM dynamic_agents WHERE name='servant';  -- then !reload to re-seed from YAML
  ```
- **task-34 (auto-add issues to board):** New `github.auto_add_project` config key (default `0` = disabled). After deploying, set in the live config:
  ```yaml
  github:
    auto_add_project: 1   # cogniloom org, project board #1
    project_owner: cogniloom  # should already be set
  ```
  The webhook handler calls `gh_project_item_add` on every `issues.opened` event, before trust-screening. PRs are skipped. Fires for both agent API calls and human GitHub UI submissions.


If you learn a durable fact about this project (gotcha, convention, decision), update /workspace/.agenthub/agents/dev.md — in the same branch as your change when working a pipeline task.
