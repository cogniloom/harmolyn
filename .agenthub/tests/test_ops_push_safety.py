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
    # Must contain the exact phrase binding "origin" to the prohibition
    assert "origin" in text and "must not be assumed" in text.lower(), (
        "ops.md must contain an explicit statement that `origin` must not be assumed "
        "as the push target when the owner has named a specific destination repo"
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
    # Must have a concrete named-remote example (e.g. cogniloom) — not just generic wording
    assert "cogniloom" in text, (
        "ops.md must include a concrete example using a named remote (cogniloom) "
        "to illustrate correct vs incorrect push target selection"
    )
