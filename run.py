import json
import re
from pathlib import Path

from langgraph.types import Command

from handoff_graph import NoteEntry, build_graph, build_initial_state


def read_notes(notes_path: str) -> dict:
    """Read notes typed in the terminal, or use the sample file if no notes are entered."""
    print("Enter fictional notes one per line as HH:MM note text.")
    print("Press Enter on an empty line to use data/notes.json.")
    entries: list[NoteEntry] = []
    while True:
        line = input(f"Note {len(entries) + 1}: ").strip()
        if not line:
            if entries:
                break
            with open(notes_path, "r", encoding="utf-8") as handle:
                return json.load(handle)

        match = re.fullmatch(r"(\d{1,2}:\d{2})\s+(.+)", line)
        if not match:
            print("Use the format HH:MM note text, for example: 16:00 BP 88/54")
            continue
        hour, minute = (int(part) for part in match.group(1).split(":"))
        if hour > 23 or minute > 59:
            print("Enter a valid 24-hour time.")
            continue

        entries.append({
            "id": f"n{len(entries) + 1}",
            "time": f"{hour:02d}:{minute:02d}",
            "text": match.group(2),
        })

    return {"patient_id": "demo-patient-1", "entries": entries}


def print_review(draft, problems, entries):
    """Display the draft and any problems before asking for approval."""
    note_numbers = {entry["id"]: index for index, entry in enumerate(entries, start=1)}
    print("\nDraft bullets:")
    for i, bullet in enumerate(draft, start=1):
        citations = ", ".join(
            f"[{note_numbers[source_id]}]" if source_id in note_numbers else f"[unknown: {source_id}]"
            for source_id in bullet.get("source_ids", [])
        )
        print(f"  - {bullet.get('text', '')} {citations}")

    print("\nProblems:")
    if problems:
        for problem in problems:
            print(f"  - {problem}")
    else:
        print("  none")


def run_handoff_demo(notes_path: str = "data/notes.json", thread_id: str = "demo-thread") -> None:
    """Load the synthetic notes, run the graph, and pause for terminal approval."""
    notes = read_notes(notes_path)

    patient_id = notes["patient_id"]
    state = build_initial_state(notes["entries"], patient_id)
    graph = build_graph()
    config = {"configurable": {"thread_id": thread_id}}

    result = graph.invoke(state, config=config)
    while "__interrupt__" in result:
        payload = result["__interrupt__"][0].value if isinstance(result["__interrupt__"], list) else result["__interrupt__"]
        draft = payload.get("draft", []) if isinstance(payload, dict) else []
        problems = payload.get("problems", []) if isinstance(payload, dict) else []
        print_review(draft, problems, notes["entries"])

        answer = input("Approve? (y/n): ").strip().lower()
        while answer not in {"y", "n"}:
            answer = input("Approve? (y/n): ").strip().lower()

        result = graph.invoke(Command(resume="approved" if answer == "y" else "rejected"), config=config)

    output_path = Path("output") / f"handoff_{patient_id}.json"
    if result.get("approved"):
        print(f"\nApproved. Saved to {output_path}")
    else:
        print("\nRejected. No handoff file was saved.")


if __name__ == "__main__":
    run_handoff_demo()
