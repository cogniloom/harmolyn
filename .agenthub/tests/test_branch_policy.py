#!/usr/bin/env python3
"""
Tests for task #199: Create development branch and enforce it as the agent push target.

Acceptance criteria:
  AC1 — A branch named `development` exists on the cogniloom/harmolyn remote.
  AC2 — CLAUDE.md contains an explicit rule stating agents must push to `development`
        and must never push directly to `main`.
  AC3 — AGENTS.md contains the same push-target rule AND states that @ops owns the
        `development → main` promotion including CI verification and merge.
  AC4 — The doc changes are committed on `development` and pushed to cogniloom/harmolyn.
        (Verified by checking that the remote branch `development` contains the policy.)

No live services beyond the cogniloom/harmolyn git remote are required.
"""

import pathlib
import re
import subprocess

REPO_ROOT = pathlib.Path(__file__).parent.parent.parent
CLAUDE_MD = REPO_ROOT / "CLAUDE.md"
AGENTS_MD = REPO_ROOT / "AGENTS.md"
COGNILOOM_REMOTE = "cogniloom"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _remote_branches():
    """Return a set of short branch names on the cogniloom remote."""
    result = subprocess.run(
        ["git", "ls-remote", "--heads", COGNILOOM_REMOTE],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    branches = set()
    for line in result.stdout.splitlines():
        # format: <sha>\trefs/heads/<name>
        if "\t" in line:
            ref = line.split("\t", 1)[1]
            branches.add(ref.removeprefix("refs/heads/"))
    return branches


def _remote_file(branch, rel_path):
    """Return the content of `rel_path` from the cogniloom remote at `branch`."""
    result = subprocess.run(
        ["git", "show", f"{COGNILOOM_REMOTE}/{branch}:{rel_path}"],
        capture_output=True, text=True, cwd=str(REPO_ROOT),
    )
    if result.returncode != 0:
        return None
    return result.stdout


# ---------------------------------------------------------------------------
# AC1 — development branch exists on remote
# ---------------------------------------------------------------------------

def test_development_branch_exists_on_remote():
    """cogniloom/harmolyn must have a branch named `development`."""
    branches = _remote_branches()
    assert "development" in branches, (
        f"`development` branch not found on {COGNILOOM_REMOTE} remote. "
        f"Branches found: {sorted(branches)}"
    )


# ---------------------------------------------------------------------------
# AC2 — CLAUDE.md has branch policy
# ---------------------------------------------------------------------------

def test_claude_md_exists():
    """CLAUDE.md must exist in the repo root."""
    assert CLAUDE_MD.exists(), f"CLAUDE.md not found at {CLAUDE_MD}"


def test_claude_md_agents_push_to_development():
    """CLAUDE.md must state agents push to `development`, not `main`."""
    text = CLAUDE_MD.read_text()
    assert re.search(r"(?i)(agents?|all).{0,80}push.{0,40}development", text) or \
           re.search(r"(?i)push.{0,40}development", text), (
        "CLAUDE.md must contain a rule stating that agents push to `development`."
    )


def test_claude_md_no_direct_push_to_main():
    """CLAUDE.md must prohibit direct pushes to `main`."""
    text = CLAUDE_MD.read_text()
    assert re.search(r"(?i)(never|not|must not|prohibit|forbidden).{0,60}(push.{0,20}main|main.{0,20}push)", text) or \
           re.search(r"(?i)(push.{0,60}main).{0,40}(never|not|forbidden|prohibit)", text), (
        "CLAUDE.md must explicitly prohibit direct pushes to `main`."
    )


def test_claude_md_policy_committed_on_development():
    """The branch-policy rule must be committed on the remote `development` branch, not just locally."""
    content = _remote_file("development", "CLAUDE.md")
    assert content is not None, (
        f"Could not read CLAUDE.md from {COGNILOOM_REMOTE}/development. "
        "Has the branch been pushed?"
    )
    assert re.search(r"(?i)push.{0,40}development", content), (
        "CLAUDE.md on remote `development` branch does not contain the push-to-development rule."
    )


# ---------------------------------------------------------------------------
# AC3 — AGENTS.md has branch policy + @ops owns dev→main
# ---------------------------------------------------------------------------

def test_agents_md_exists():
    """AGENTS.md must exist in the repo root."""
    assert AGENTS_MD.exists(), f"AGENTS.md not found at {AGENTS_MD}"


def test_agents_md_push_to_development_rule():
    """AGENTS.md must state that agents push to `development`, never directly to `main`."""
    text = AGENTS_MD.read_text()
    assert re.search(r"(?i)(push.{0,40}development|development.{0,40}push)", text), (
        "AGENTS.md must contain a rule requiring agents to push to `development`."
    )
    assert re.search(r"(?i)(never|not|must not|prohibit|forbidden).{0,80}(push.{0,20}main|direct.{0,20}main)", text) or \
           re.search(r"(?i)(main).{0,40}(never|not|forbidden|must not)", text), (
        "AGENTS.md must prohibit direct pushes to `main`."
    )


def test_agents_md_ops_owns_promotion():
    """AGENTS.md must name @ops as the owner of the development→main promotion."""
    text = AGENTS_MD.read_text()
    assert re.search(r"(?i)@?ops.{0,120}(development|develop).{0,60}main", text) or \
           re.search(r"(?i)(development|develop).{0,60}main.{0,120}@?ops", text), (
        "AGENTS.md must state that @ops owns the development → main promotion."
    )


def test_agents_md_ops_ci_merge():
    """AGENTS.md must mention BOTH CI verification AND merge as part of @ops promotion ownership."""
    text = AGENTS_MD.read_text()
    has_ci = re.search(r"(?i)\bCI\b|continuous.integrat|CI.verif", text)
    has_merge = re.search(r"(?i)\bmerge\b", text)
    assert has_ci and has_merge, (
        "AGENTS.md must mention both CI verification and merge as part of @ops's "
        "development → main promotion responsibility. "
        f"has_ci={bool(has_ci)}, has_merge={bool(has_merge)}"
    )


def test_agents_md_policy_committed_on_development():
    """The branch-policy rule must be committed on the remote `development` branch."""
    content = _remote_file("development", "AGENTS.md")
    assert content is not None, (
        f"Could not read AGENTS.md from {COGNILOOM_REMOTE}/development. "
        "Has the branch been pushed?"
    )
    assert re.search(r"(?i)push.{0,40}development|development.{0,40}push", content), (
        "AGENTS.md on remote `development` branch does not contain the push-to-development rule."
    )
    assert re.search(r"(?i)@?ops.{0,120}(development|develop).{0,60}main|"
                     r"(development|develop).{0,60}main.{0,120}@?ops", content), (
        "AGENTS.md on remote `development` branch does not name @ops as promotion owner."
    )
    has_ci = re.search(r"(?i)\bCI\b|continuous.integrat|CI.verif", content)
    has_merge = re.search(r"(?i)\bmerge\b", content)
    assert has_ci and has_merge, (
        "AGENTS.md on remote `development` branch must mention both CI verification and merge "
        "as part of @ops promotion. "
        f"has_ci={bool(has_ci)}, has_merge={bool(has_merge)}"
    )


# ---------------------------------------------------------------------------
# CI workflow — self-hosted runner workspace cleanup guard
# ---------------------------------------------------------------------------

WORKFLOWS_DIR = REPO_ROOT / ".github" / "workflows"


def _workflow_text(filename):
    path = WORKFLOWS_DIR / filename
    assert path.exists(), f"Workflow file not found: {path}"
    return path.read_text()


def _jobs_missing_pre_checkout_cleanup(wf_text):
    """
    Parse the workflow YAML text line-by-line to find self-hosted jobs that lack
    a sudo chown/chmod/rm step before their first actions/checkout step.

    Returns a list of job ids (strings) that are missing the cleanup.
    """
    missing = []
    lines = wf_text.splitlines()

    # Split into per-job blocks by finding top-level "  <job_id>:" lines under "jobs:"
    # We look for lines at exactly 2-space indent (job keys) after we see "jobs:".
    in_jobs = False
    job_blocks = {}  # job_id -> list of lines
    current_job = None

    for line in lines:
        if line.rstrip() == "jobs:":
            in_jobs = True
            continue
        if not in_jobs:
            continue
        # top-level key inside jobs (2-space indent, no deeper)
        m = re.match(r'^  (\w[\w-]*):\s*$', line)
        if m:
            current_job = m.group(1)
            job_blocks[current_job] = []
            continue
        if current_job is not None:
            job_blocks[current_job].append(line)

    for jid, block in job_blocks.items():
        block_text = "\n".join(block)
        if "self-hosted" not in block_text:
            continue
        # Find the position of the first actions/checkout line
        checkout_pos = None
        for i, ln in enumerate(block):
            if re.search(r"actions/checkout", ln):
                checkout_pos = i
                break
        if checkout_pos is None:
            continue  # no checkout step — not our concern
        pre_block = "\n".join(block[:checkout_pos])
        has_cleanup = bool(re.search(r"(chown|chmod|rm\s+-rf)", pre_block))
        if not has_cleanup:
            missing.append(jid)

    return missing


def test_ci_yml_self_hosted_jobs_have_pre_checkout_cleanup():
    """Every self-hosted job in ci.yml must fix workspace permissions before checkout."""
    wf_text = _workflow_text("ci.yml")
    missing = _jobs_missing_pre_checkout_cleanup(wf_text)
    assert not missing, (
        f"ci.yml self-hosted job(s) {missing} have no workspace cleanup step before "
        "actions/checkout. Runner workspace contamination causes EACCES on clean. "
        "Add a 'sudo chown -R $(id -u):$(id -g) .' step before the checkout."
    )


def test_agenthub_ci_yml_self_hosted_jobs_have_pre_checkout_cleanup():
    """Every self-hosted job in agenthub-ci.yml must fix workspace permissions before checkout."""
    wf_text = _workflow_text("agenthub-ci.yml")
    missing = _jobs_missing_pre_checkout_cleanup(wf_text)
    assert not missing, (
        f"agenthub-ci.yml self-hosted job(s) {missing} have no workspace cleanup step before "
        "actions/checkout. Runner workspace contamination causes EACCES on clean. "
        "Add a 'sudo chown -R $(id -u):$(id -g) .' step before the checkout."
    )


# ---------------------------------------------------------------------------
# Manual runner
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    tests = [
        test_development_branch_exists_on_remote,
        test_claude_md_exists,
        test_claude_md_agents_push_to_development,
        test_claude_md_no_direct_push_to_main,
        test_claude_md_policy_committed_on_development,
        test_agents_md_exists,
        test_agents_md_push_to_development_rule,
        test_agents_md_ops_owns_promotion,
        test_agents_md_ops_ci_merge,
        test_agents_md_policy_committed_on_development,
        test_ci_yml_self_hosted_jobs_have_pre_checkout_cleanup,
        test_agenthub_ci_yml_self_hosted_jobs_have_pre_checkout_cleanup,
    ]
    passed = 0
    failed = 0
    for t in tests:
        try:
            t()
            print(f"  PASS  {t.__name__}")
            passed += 1
        except (AssertionError, FileNotFoundError, OSError) as e:
            print(f"  FAIL  {t.__name__}: {e}")
            failed += 1
    print(f"\n{passed} passed, {failed} failed")
    if failed:
        raise SystemExit(1)
