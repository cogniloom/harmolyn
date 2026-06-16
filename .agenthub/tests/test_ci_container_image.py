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


def test_trust_gate_has_no_container():
    """trust-gate runs on GitHub-hosted (ubuntu-latest); it must NOT have a container override."""
    text = WORKFLOWS[1].read_text()
    # Extract only the trust-gate block
    blocks = re.split(r"\n(?=  \w)", text)
    gate_block = next((b for b in blocks if "trust-gate:" in b), None)
    assert gate_block is not None, "trust-gate job not found in agenthub-ci.yml"
    assert "container:" not in gate_block, (
        "trust-gate must NOT have a container: directive (it runs on GitHub-hosted ubuntu-latest)"
    )
