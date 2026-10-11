import json
from pathlib import Path

import pytest
from langgraph.errors import GraphInterrupt
from langgraph.types import Command

from handoff_graph import build_initial_state, check_handoff, route_handoff, build_graph, safe_parse_json_list


ENTRIES = [
    {"id": "n1", "time": "16:00", "text": "BP 88/54"},
    {"id": "n2", "time": "16:30", "text": "Patient says feeling dizzy"},
    {"id": "n3", "time": "17:00", "text": "Recheck BP before 5 pm (task)"},
]


def test_check_handoff_flags_missing_source_id():
    state = {
        "entries": ENTRIES,
        "draft": [{"text": "BP 88/54 noted", "source_ids": ["n1", "missing-id"]}],
        "problems": [],
        "retries": 0,
        "max_retries": 1,
        "approved": False,
        "patient_id": "demo-patient-1",
    }

    result = check_handoff(state)
    assert any("missing note id 'missing-id'" in issue for issue in result["problems"])


def test_check_handoff_flags_number_not_in_cited_note():
    state = {
        "entries": ENTRIES,
        "draft": [{"text": "BP 90/60 noted", "source_ids": ["n1"]}],
        "problems": [],
        "retries": 0,
        "max_retries": 1,
        "approved": False,
        "patient_id": "demo-patient-1",
    }

    result = check_handoff(state)
    assert any("number '90'" in issue for issue in result["problems"])


def test_check_handoff_passes_correct_bullet():
    state = {
        "entries": ENTRIES,
        "draft": [
            {"text": "BP 88/54 at 16:00", "source_ids": ["n1"]},
            {"text": "Patient says feeling dizzy at 16:30", "source_ids": ["n2"]},
            {"text": "Recheck BP before 5 pm at 17:00", "source_ids": ["n3"]},
        ],
        "problems": [],
        "retries": 0,
        "max_retries": 1,
        "approved": False,
        "patient_id": "demo-patient-1",
    }

    result = check_handoff(state)
    assert result["problems"] == []


def test_check_handoff_flags_empty_draft():
    state = {
        "entries": ENTRIES,
        "draft": [],
        "problems": [],
        "retries": 0,
        "max_retries": 1,
        "approved": False,
        "patient_id": "demo-patient-1",
    }

    result = check_handoff(state)
    assert result["problems"][0] == "Draft contains no bullets."


def test_parser_rejects_empty_json_array():
    with pytest.raises(ValueError, match="non-empty JSON list"):
        safe_parse_json_list("[]")


def test_route_handoff_decides_when_to_retry_or_review():
    retry_state = {
        "entries": ENTRIES,
        "draft": [],
        "problems": ["bad draft"],
        "retries": 0,
        "max_retries": 1,
        "approved": False,
        "patient_id": "demo-patient-1",
    }
    assert route_handoff(retry_state) == "draft_handoff"

    exhausted_state = {
        "entries": ENTRIES,
        "draft": [],
        "problems": ["bad draft"],
        "retries": 1,
        "max_retries": 1,
        "approved": False,
        "patient_id": "demo-patient-1",
    }
    assert route_handoff(exhausted_state) == "human_review"


def test_end_to_end_fake_llm_resume(monkeypatch):
    monkeypatch.setenv("USE_FAKE_LLM", "1")
    output_path = Path("output/handoff_demo-patient-1.json")
    if output_path.exists():
        output_path.unlink()

    graph = build_graph()
    config = {"configurable": {"thread_id": "demo-test-thread"}}
    initial = build_initial_state(ENTRIES, "demo-patient-1")

    first_result = graph.invoke(initial, config=config)
    assert "__interrupt__" in first_result

    result = graph.invoke(Command(resume="approved"), config=config)

    assert result["approved"] is True
    assert output_path.exists()
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    assert payload["patient_id"] == "demo-patient-1"
    assert len(payload["draft"]) == 3
    assert [bullet["source_ids"] for bullet in payload["draft"]] == [["n1"], ["n2"], ["n3"]]
    assert "BP 88/54" in payload["draft"][0]["text"]
