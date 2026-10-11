import json
import os
import re
from typing import Any, Literal, TypedDict

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import interrupt

MODEL_NAME = "gemini-3.8-flash"


class NoteEntry(TypedDict):
    id: str
    time: str
    text: str


class DraftBullet(TypedDict):
    text: str
    source_ids: list[str]


class HandoffState(TypedDict):
    entries: list[NoteEntry]
    draft: list[DraftBullet]
    problems: list[str]
    retries: int
    max_retries: int
    approved: bool
    patient_id: str


def get_llm() -> Any:
    """Return the Gemini client, or the fake drafter for local testing."""
    if os.getenv("USE_FAKE_LLM") == "1":
        return None

    api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
    if not api_key:
        raise RuntimeError(
            "Set GEMINI_API_KEY (or GOOGLE_API_KEY) before running with Gemini."
        )
    return ChatGoogleGenerativeAI(
        model=MODEL_NAME,
        temperature=0,
        google_api_key=api_key,
    )


def safe_parse_json_list(raw: str) -> list[DraftBullet]:
    """Parse JSON-only LLM output into a list of bullet objects."""
    cleaned = raw.strip()
    if cleaned.startswith("```"):
        cleaned = cleaned.strip("`").strip()
        if cleaned.startswith("json"):
            cleaned = cleaned[4:].strip()
    parsed = json.loads(cleaned)
    if not isinstance(parsed, list) or not parsed:
        raise ValueError("LLM output must be a non-empty JSON list.")
    bullets: list[DraftBullet] = []
    for item in parsed:
        if not isinstance(item, dict):
            raise ValueError("Each bullet must be an object.")
        text = item.get("text")
        source_ids = item.get("source_ids")
        if not isinstance(text, str) or not text.strip() or not isinstance(source_ids, list):
            raise ValueError("Each bullet needs non-empty text and a source_ids list.")
        if not all(isinstance(source_id, str) for source_id in source_ids):
            raise ValueError("Every source id must be a string.")
        bullets.append({"text": text, "source_ids": [str(v) for v in source_ids]})
    return bullets


def draft_handoff(state: HandoffState) -> dict[str, Any]:
    """Create a draft handoff from the note entries, or generate a retry draft when issues exist."""
    entries = state["entries"]
    problems = state.get("problems", [])
    retry_count = state.get("retries", 0)
    updates: dict[str, Any] = {}
    if problems and retry_count < state.get("max_retries", 1):
        retry_count += 1
        updates["retries"] = retry_count
    llm = get_llm()

    if llm is None:
        if retry_count == 0:
            return {**updates, "draft": [{"text": "BP 90/60 noted; patient reports dizziness.", "source_ids": ["n1", "n2"]}], "problems": []}
        return {
            **updates,
            "draft": [
                {"text": f"{entry['text']} at {entry['time']}", "source_ids": [entry["id"]]}
                for entry in entries
            ],
            "problems": [],
        }

    prompt = (
        f"Write exactly {len(entries)} short handoff bullets, one bullet for each note, in the same order. "
        "Each bullet must cite exactly that note's id in source_ids. "
        "Use only the note's words and time; do not add advice, diagnoses, interpretations, or facts. "
        "Return a non-empty JSON array only, with no markdown. Each object must have exactly these fields: "
        '{"text":"short factual bullet","source_ids":["note-id"]}. '
        "Example input note: {\"id\":\"n1\",\"time\":\"16:00\",\"text\":\"BP 88/54\"}. "
        "Example output: [{\"text\":\"BP 88/54 at 16:00\",\"source_ids\":[\"n1\"]}]. "
        f"Notes: {json.dumps(entries, ensure_ascii=True)}. "
        f"Fix these previous checker problems if provided: {json.dumps(problems)}."
    )
    response = llm.invoke([
        SystemMessage(content=(
            "You write short, factual handoff bullets from fictional notes. "
            "Never infer clinical meaning. Return a non-empty JSON array and nothing else."
        )),
        HumanMessage(content=prompt),
    ])
    raw = response.content if hasattr(response, "content") else str(response)
    try:
        parsed = safe_parse_json_list(raw)
        return {**updates, "draft": parsed, "problems": []}
    except Exception as exc:  # pragma: no cover - LLM parsing error path is exercised via retry logic.
        return {**updates, "draft": [], "problems": [f"Draft response was not valid JSON: {exc}"]}


def check_handoff(state: HandoffState) -> dict[str, Any]:
    """Validate each bullet against its cited note IDs and numbers."""
    entries = state["entries"]
    entry_by_id = {entry["id"]: f"{entry['time']} {entry['text']}" for entry in entries}
    problems: list[str] = list(state.get("problems", []))
    draft = state.get("draft", [])
    if not draft:
        problems.append("Draft contains no bullets.")

    cited_ids: list[str] = []
    for index, bullet in enumerate(draft, start=1):
        text = str(bullet.get("text", ""))
        source_ids = bullet.get("source_ids", [])
        if not source_ids:
            problems.append(f"Bullet {index} has no source_ids.")
            continue
        if len(source_ids) != 1:
            problems.append(f"Bullet {index} must cite exactly one note.")

        cited_texts = []
        for source_id in source_ids:
            if source_id not in entry_by_id:
                problems.append(f"Bullet {index} cites missing note id '{source_id}'.")
            else:
                cited_texts.append(entry_by_id[source_id])
                cited_ids.append(source_id)

        numbers = re.findall(r"\d+", text)
        for number in numbers:
            if not any(number in cited_text for cited_text in cited_texts):
                problems.append(f"Bullet {index} includes number '{number}' that is not in its cited notes.")

    if len(cited_ids) != len(set(cited_ids)):
        problems.append("A note is cited by more than one bullet.")
    missing_ids = set(entry_by_id) - set(cited_ids)
    if missing_ids:
        problems.append(f"No bullet cites note(s): {', '.join(sorted(missing_ids))}.")

    return {"problems": problems}


def route_handoff(state: HandoffState) -> Literal["draft_handoff", "human_review"]:
    """Retry while a retry slot remains; otherwise pause for human review."""
    if state.get("problems") and state.get("retries", 0) < state.get("max_retries", 1):
        return "draft_handoff"
    return "human_review"


def human_review(state: HandoffState) -> dict[str, bool]:
    """Pause the graph and wait for a plain 'approved' or 'rejected' answer."""
    decision = interrupt({
        "draft": state.get("draft", []),
        "problems": state.get("problems", []),
        "message": "Review the draft and decide whether it is acceptable.",
    })
    if decision not in {"approved", "rejected"}:
        raise ValueError("Only approved or rejected are valid values.")
    return {"approved": decision == "approved"}


def route_after_review(state: HandoffState) -> Literal["save_handoff", "__end__"]:
    """Route the review node based on the human approval decision."""
    return "save_handoff" if state.get("approved") else END


def save_handoff(state: HandoffState) -> dict[str, Any]:
    """Write the approved draft to output/handoff_<patient_id>.json."""
    patient_id = state.get("patient_id", "unknown")
    output_dir = "output"
    os.makedirs(output_dir, exist_ok=True)
    payload = {"patient_id": patient_id, "draft": state.get("draft", [])}
    output_path = os.path.join(output_dir, f"handoff_{patient_id}.json")
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    return {"approved": True}


def build_graph() -> StateGraph:
    """Create the LangGraph workflow that drafts, checks, reviews, and saves a handoff."""
    builder = StateGraph(HandoffState)
    builder.add_node("draft_handoff", draft_handoff)
    builder.add_node("check_handoff", check_handoff)
    builder.add_node("human_review", human_review)
    builder.add_node("save_handoff", save_handoff)

    builder.add_edge(START, "draft_handoff")
    builder.add_edge("draft_handoff", "check_handoff")
    builder.add_conditional_edges("check_handoff", route_handoff, {
        "draft_handoff": "draft_handoff",
        "human_review": "human_review",
    })
    builder.add_conditional_edges("human_review", route_after_review, {
        "save_handoff": "save_handoff",
        END: END,
    })
    builder.add_edge("save_handoff", END)

    return builder.compile(checkpointer=MemorySaver())


def build_initial_state(entries: list[NoteEntry], patient_id: str) -> HandoffState:
    """Create the initial graph state for a new handoff run."""
    return {
        "entries": entries,
        "draft": [],
        "problems": [],
        "retries": 0,
        "max_retries": 1,
        "approved": False,
        "patient_id": patient_id,
    }
