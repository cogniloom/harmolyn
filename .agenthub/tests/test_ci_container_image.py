"""
TDD: verify all self-hosted runner jobs use container: debian:trixie.
Owner instruction (wenga): "use ONLY self-hosted runners with the container image debian:trixie"
"""
import re
from pathlib import Path

WORKFLOWS = [
    Path(__file__).parent.parent.parent / ".github/workflows/ci.yml",
    Path(__file__).parent.parent.parent / ".github/workflows/agenthub-ci.yml",
    Path(__file__).parent.parent.parent / ".github/workflows/release.yml",
]

REQUIRED_IMAGE = "debian:trixie"


def _self_hosted_jobs(text: str) -> list[dict]:
    """Return list of {name, has_container, image} for every self-hosted job."""
    jobs = []
    # Split on top-level job keys (2-space indent, word chars, colon)
    job_blocks = re.split(r"\n(?=  \w)", text)
    for block in job_blocks:
        if "runs-on: self-hosted" not in block:
            continue
        name_m = re.search(r"^\s{2}(\w[\w-]*):", block, re.MULTILINE)
        job_name = name_m.group(1) if name_m else "<unknown>"
        container_m = re.search(r"^\s+container:\s*(.+)$", block, re.MULTILINE)
        if container_m:
            image = container_m.group(1).strip()
            jobs.append({"name": job_name, "has_container": True, "image": image})
        else:
            jobs.append({"name": job_name, "has_container": False, "image": None})
    return jobs


def test_ci_yml_self_hosted_jobs_use_debian_trixie():
    text = WORKFLOWS[0].read_text()
    jobs = _self_hosted_jobs(text)
    assert jobs, "ci.yml: no self-hosted jobs found"
    bad = [j for j in jobs if not j["has_container"] or j["image"] != REQUIRED_IMAGE]
    assert not bad, (
        f"ci.yml: these self-hosted jobs are missing 'container: {REQUIRED_IMAGE}': "
        + ", ".join(j["name"] for j in bad)
    )


def test_agenthub_ci_yml_self_hosted_jobs_use_debian_trixie():
    text = WORKFLOWS[1].read_text()
    jobs = _self_hosted_jobs(text)
    assert jobs, "agenthub-ci.yml: no self-hosted jobs found"
    bad = [j for j in jobs if not j["has_container"] or j["image"] != REQUIRED_IMAGE]
    assert not bad, (
        f"agenthub-ci.yml: these self-hosted jobs are missing 'container: {REQUIRED_IMAGE}': "
        + ", ".join(j["name"] for j in bad)
    )


def test_release_yml_self_hosted_jobs_use_debian_trixie():
    text = WORKFLOWS[2].read_text()
    jobs = _self_hosted_jobs(text)
    assert jobs, "release.yml: no self-hosted jobs found"
    bad = [j for j in jobs if not j["has_container"] or j["image"] != REQUIRED_IMAGE]
    assert not bad, (
        f"release.yml: these self-hosted jobs are missing 'container: {REQUIRED_IMAGE}': "
        + ", ".join(j["name"] for j in bad)
    )


def test_trust_gate_uses_self_hosted_debian_trixie():
    """Owner directive: ALL runners must use self-hosted + container: debian:trixie, including trust-gate."""
    text = WORKFLOWS[1].read_text()
    blocks = re.split(r"\n(?=  \w)", text)
    gate_block = next((b for b in blocks if "trust-gate:" in b), None)
    assert gate_block is not None, "trust-gate job not found in agenthub-ci.yml"
    assert "runs-on: self-hosted" in gate_block, (
        "trust-gate must use 'runs-on: self-hosted' (owner directive: ONLY self-hosted runners)"
    )
    assert "ubuntu-latest" not in gate_block, (
        "trust-gate must NOT use 'ubuntu-latest' (owner directive: ONLY self-hosted runners)"
    )
    container_m = re.search(r"container:\s*(.+)", gate_block)
    assert container_m is not None, (
        f"trust-gate is missing 'container: {REQUIRED_IMAGE}'"
    )
    assert container_m.group(1).strip() == REQUIRED_IMAGE, (
        f"trust-gate container must be '{REQUIRED_IMAGE}', got '{container_m.group(1).strip()}'"
    )


# ── sysbox no_new_privs constraints ──────────────────────────────────────────
# Inside container: debian:trixie on the self-hosted sysbox runner, sudo is
# unavailable (no_new_privs blocks privilege escalation) and --with-deps on
# playwright calls sudo internally.  These tests enforce that neither construct
# appears in any self-hosted job block.

CI_YML = WORKFLOWS[0]
AGENTHUB_CI_YML = WORKFLOWS[1]
RELEASE_YML = WORKFLOWS[2]


def _job_block(text: str, job_key: str) -> str:
    """Return the raw YAML block for a named top-level job key."""
    blocks = re.split(r"\n(?=  \w)", text)
    match = next((b for b in blocks if re.match(rf"\s{{2}}{re.escape(job_key)}:", b)), None)
    assert match is not None, f"job '{job_key}' not found"
    return match


def test_browser_smoke_no_with_deps():
    """browser-smoke runs inside debian:trixie; --with-deps calls sudo internally — must be absent."""
    block = _job_block(CI_YML.read_text(), "browser-smoke")
    assert "--with-deps" not in block, (
        "ci.yml browser-smoke: --with-deps on playwright install invokes sudo "
        "internally and fails under sysbox no_new_privs. Remove --with-deps."
    )


def test_tauri_check_no_sudo():
    """tauri-check runs inside debian:trixie; sudo is unusable under sysbox no_new_privs."""
    block = _job_block(CI_YML.read_text(), "tauri-check")
    assert "sudo " not in block, (
        "ci.yml tauri-check: 'sudo' found in job block — fails under sysbox no_new_privs "
        "inside container: debian:trixie. Drop the sudo prefix from all apt-get calls."
    )


def test_release_build_no_sudo():
    """release build job (linux matrix) runs inside debian:trixie; sudo fails under no_new_privs."""
    block = _job_block(RELEASE_YML.read_text(), "build")
    assert "sudo " not in block, (
        "release.yml build: 'sudo' found in job block — fails under sysbox no_new_privs "
        "inside container: debian:trixie. Drop the sudo prefix from all apt-get calls."
    )


def test_agenthub_ci_browser_smoke_no_with_deps():
    """agenthub-ci browser-smoke runs inside debian:trixie; --with-deps calls sudo internally."""
    block = _job_block(AGENTHUB_CI_YML.read_text(), "browser-smoke")
    assert "--with-deps" not in block, (
        "agenthub-ci.yml browser-smoke: --with-deps on playwright install invokes sudo "
        "internally and fails under sysbox no_new_privs. Remove --with-deps."
    )


def test_agenthub_ci_tauri_check_no_sudo():
    """agenthub-ci tauri-check runs inside debian:trixie; sudo is unusable under no_new_privs."""
    block = _job_block(AGENTHUB_CI_YML.read_text(), "tauri-check")
    assert "sudo " not in block, (
        "agenthub-ci.yml tauri-check: 'sudo' found in job block — fails under sysbox no_new_privs "
        "inside container: debian:trixie. Drop the sudo prefix from all apt-get calls."
    )
