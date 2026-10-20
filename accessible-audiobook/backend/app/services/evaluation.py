"""HCI evaluation: study tasks, metric extraction and questionnaire scoring.

Study design: within-subjects, System A (traditional audiobook: play, pause,
seek, repeat) versus System B (RAG audiobook). Each task starts the participant
in a section that uses a term defined elsewhere in the book, which is exactly
the situation where a listener has to stop and look something up.
"""
from __future__ import annotations

from statistics import mean, median, stdev

SAMPLE_BOOK_ID = "operating-systems"

TASKS = [
    {"id": "T1", "set": "X", "chapter_index": 2, "section": "Page Faults",
     "goal": "While you listen, find out what the valid bit is. Then carry on listening from where you were.",
     "question": "What is the valid bit?",
     "answer_key": "A bit in each page table entry that says whether the page is currently in main memory."},
    {"id": "T2", "set": "X", "chapter_index": 2, "section": "Page Replacement Algorithms",
     "goal": "While you listen, find out what locality of reference means. Then carry on listening from where you were.",
     "question": "What does locality of reference mean?",
     "answer_key": "A program tends to use the same small group of pages again and again over a short period."},
    {"id": "T3", "set": "Y", "chapter_index": 2, "section": "Thrashing and the Working Set",
     "goal": "While you listen, find out what the page fault rate is. Then carry on listening from where you were.",
     "question": "What is the page fault rate?",
     "answer_key": "The fraction of memory accesses that cause a page fault."},
    {"id": "T4", "set": "Y", "chapter_index": 1, "section": "Pages and Frames",
     "goal": "While you listen, find out what external fragmentation is. Then carry on listening from where you were.",
     "question": "What is external fragmentation?",
     "answer_key": "Enough total memory is free, but it is split into small holes and no single hole is big enough."},
]

# Counterbalancing: condition order x which task set goes with the first condition.
ORDERS = [("AB", "XY"), ("BA", "XY"), ("AB", "YX"), ("BA", "YX")]

TLX_ITEMS = ["Mental demand", "Physical demand", "Temporal demand", "Performance", "Effort", "Frustration"]
SUS_ITEMS = [
    "I think that I would like to use this system frequently.",
    "I found the system unnecessarily complex.",
    "I thought the system was easy to use.",
    "I think that I would need the support of a technical person to be able to use this system.",
    "I found the various functions in this system were well integrated.",
    "I thought there was too much inconsistency in this system.",
    "I would imagine that most people would learn to use this system very quickly.",
    "I found the system very cumbersome to use.",
    "I felt very confident using the system.",
    "I needed to learn a lot of things before I could get going with this system.",
]

METRICS = ["task_time_s", "interactions", "time_to_answer_s", "time_to_resume_s", "resume_error_sentences"]


def assignment(participant_number: int) -> tuple[str, str]:
    """(condition order, task-set order) for the n-th participant (1-based)."""
    return ORDERS[(participant_number - 1) % len(ORDERS)]


def compute_metrics(events: list[dict], duration_ms: int) -> dict:
    """Derive the dependent measures from a trial's event log."""
    def first(kind: str, after: float = -1) -> dict | None:
        return next((e for e in events if e["type"] == kind and e["t"] > after), None)

    search = first("search_start")
    found = first("answer_found", search["t"] if search else -1)
    resumed = first("resumed", found["t"]) if found else None
    return {
        "task_time_s": round(duration_ms / 1000, 2),
        "interactions": sum(1 for e in events if e["type"] == "interaction"),
        "questions": sum(1 for e in events if e["type"] == "question"),
        "errors": sum(1 for e in events if e["type"] == "error"),
        "time_to_answer_s": round((found["t"] - search["t"]) / 1000, 2) if search and found else None,
        "time_to_resume_s": round((resumed["t"] - found["t"]) / 1000, 2) if resumed else None,
        # How far from the interruption point reading actually resumed (0 = did not lose their place).
        "resume_error_sentences": resumed.get("data", {}).get("offset_sentences") if resumed else None,
    }


def score_questionnaire(kind: str, responses: list[float]) -> float:
    if kind == "tlx":  # Raw TLX: mean of six 0-100 subscales (higher = more workload)
        if len(responses) != 6 or not all(0 <= r <= 100 for r in responses):
            raise ValueError("NASA-TLX needs six ratings from 0 to 100.")
        return round(mean(responses), 1)
    if kind == "sus":  # 0-100, higher = more usable
        if len(responses) != 10 or not all(1 <= r <= 5 for r in responses):
            raise ValueError("SUS needs ten ratings from 1 to 5.")
        total = sum((r - 1) if i % 2 == 0 else (5 - r) for i, r in enumerate(responses))
        return total * 2.5
    if len(responses) != 1 or not 1 <= responses[0] <= 7:
        raise ValueError("Satisfaction is a single rating from 1 to 7.")
    return responses[0]


def describe(values: list[float]) -> dict | None:
    values = [v for v in values if v is not None]
    if not values:
        return None
    return {"n": len(values), "mean": round(mean(values), 2), "median": round(median(values), 2),
            "sd": round(stdev(values), 2) if len(values) > 1 else 0.0}
