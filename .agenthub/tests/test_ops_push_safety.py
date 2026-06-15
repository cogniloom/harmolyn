"""
Tests for ops.md push-safety rule (task #170).
These verify that the ops agent definition contains the required guidance
to prevent pushing to the wrong remote when the owner names a destination.

Run with: python -m pytest .agenthub/tests/test_ops_push_safety.py -v
"""
import os
import pathlib
import pytest

OPS_MD = pathlib.Path(__file__).parent.parent / "agents" / "ops.md"


def _read_ops_md():
    return OPS_MD.read_text()


def test_ops_md_exists():
    assert OPS_MD.exists(), f"ops.md not found at {OPS_MD}"


def test_push_safety_section_present():
    text = _read_ops_md()
    assert "push safety" in text.lower(), (
        "ops.md must contain a 'Push safety' section header"
    )


def test_remote_verification_required():
    text = _read_ops_md()
    assert "git remote" in text, (
        "ops.md must require running `git remote` before pushing"
    )


def test_select_matching_remote_not_origin():
    text = _read_ops_md()
    # Must explicitly address the 'origin' assumption problem
    assert "origin" in text and (
        "must not" in text.lower() or "do not" in text.lower() or "not assume" in text.lower()
    ), (
        "ops.md must contain an explicit prohibition on assuming `origin` as the "
        "push target when the owner has named a specific destination repo"
    )


def test_stop_and_ask_if_no_remote_matches():
    text = _read_ops_md()
    # Must instruct to stop and ask when no remote matches
    assert "stop" in text.lower() and ("ask" in text.lower() or "owner" in text.lower()), (
        "ops.md must instruct ops to stop and ask the owner when no remote matches "
        "the stated destination"
    )


def test_cogniloom_example_or_equivalent():
    text = _read_ops_md()
    # Should have a concrete example showing correct vs incorrect remote selection
    assert "cogniloom" in text or "destination" in text.lower(), (
        "ops.md should include a concrete example of resolving the correct push remote"
    )
