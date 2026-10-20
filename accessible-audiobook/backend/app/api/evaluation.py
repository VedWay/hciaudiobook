"""Researcher-facing evaluation API (System A vs System B)."""
from __future__ import annotations

import csv
import io

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from ..db import get_db
from ..models import EvalParticipant, EvalQuestionnaire, EvalTrial
from ..models.schemas import ParticipantCreate, QuestionnaireSubmit, TrialCreate, TrialFinish
from ..services import evaluation as ev
from .deps import current_user, researcher

router = APIRouter(prefix="/api/eval", tags=["evaluation"])
guarded = [Depends(researcher)]


def _participant_out(p: EvalParticipant) -> dict:
    return {
        "id": p.id, "code": p.code, "profile": p.profile, "condition_order": p.condition_order,
        "task_sets": p.profile.get("_task_sets", "XY"), "created_at": p.created_at.isoformat(),
        "trials": [{"id": t.id, "condition": t.condition, "task_id": t.task_id, "finished": t.finished,
                    "completed": t.completed, "comprehension": t.comprehension, "metrics": t.metrics,
                    "notes": t.notes} for t in p.trials],
        "questionnaires": [{"condition": q.condition, "kind": q.kind, "score": q.score, "responses": q.responses}
                           for q in p.questionnaires],
    }


def _participants(db: Session) -> list[EvalParticipant]:
    return list(db.scalars(select(EvalParticipant).options(
        selectinload(EvalParticipant.trials), selectinload(EvalParticipant.questionnaires))
        .order_by(EvalParticipant.id)))


@router.get("/design", dependencies=[Depends(current_user)])
def design() -> dict:
    return {"book_id": ev.SAMPLE_BOOK_ID, "tasks": ev.TASKS, "tlx_items": ev.TLX_ITEMS, "sus_items": ev.SUS_ITEMS}


@router.get("/participants", dependencies=guarded)
def list_participants(db: Session = Depends(get_db)) -> list[dict]:
    return [_participant_out(p) for p in _participants(db)]


@router.post("/participants", dependencies=guarded, status_code=status.HTTP_201_CREATED)
def create_participant(body: ParticipantCreate, db: Session = Depends(get_db)) -> dict:
    number = (db.scalar(select(func.max(EvalParticipant.id))) or 0) + 1
    order, task_sets = ev.assignment(number)
    participant = EvalParticipant(code=f"P{number:02d}", condition_order=order,
                                  profile={**body.profile, "_task_sets": task_sets})
    db.add(participant)
    db.commit()
    return _participant_out(participant)


@router.delete("/participants/{participant_id}", dependencies=guarded, status_code=status.HTTP_204_NO_CONTENT)
def delete_participant(participant_id: int, db: Session = Depends(get_db)) -> Response:
    """Supports a participant's right to withdraw their data."""
    participant = db.get(EvalParticipant, participant_id)
    if participant is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Participant not found.")
    db.delete(participant)
    db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/trials", dependencies=guarded, status_code=status.HTTP_201_CREATED)
def create_trial(body: TrialCreate, db: Session = Depends(get_db)) -> dict:
    if db.get(EvalParticipant, body.participant_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Participant not found.")
    task = next((t for t in ev.TASKS if t["id"] == body.task_id), None)
    if task is None:
        raise HTTPException(422, "Unknown task.")
    trial = EvalTrial(participant_id=body.participant_id, condition=body.condition, task_id=body.task_id)
    db.add(trial)
    db.commit()
    return {"id": trial.id, "condition": trial.condition, "task": task}


@router.post("/trials/{trial_id}/finish", dependencies=guarded)
def finish_trial(trial_id: int, body: TrialFinish, db: Session = Depends(get_db)) -> dict:
    trial = db.get(EvalTrial, trial_id)
    if trial is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Trial not found.")
    events = [e.model_dump() for e in body.events]
    trial.events = events
    trial.metrics = ev.compute_metrics(events, body.duration_ms)
    trial.finished, trial.completed = True, body.completed
    trial.comprehension, trial.notes = body.comprehension, body.notes
    db.commit()
    return {"id": trial.id, "metrics": trial.metrics}


@router.post("/questionnaires", dependencies=guarded)
def submit_questionnaire(body: QuestionnaireSubmit, db: Session = Depends(get_db)) -> dict:
    if db.get(EvalParticipant, body.participant_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Participant not found.")
    try:
        score = ev.score_questionnaire(body.kind, body.responses)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    row = db.scalar(select(EvalQuestionnaire).where(
        EvalQuestionnaire.participant_id == body.participant_id,
        EvalQuestionnaire.condition == body.condition, EvalQuestionnaire.kind == body.kind))
    if row is None:
        row = EvalQuestionnaire(participant_id=body.participant_id, condition=body.condition, kind=body.kind)
        db.add(row)
    row.responses, row.score = body.responses, score
    db.commit()
    return {"kind": body.kind, "condition": body.condition, "score": score}


@router.get("/summary", dependencies=guarded)
def summary(db: Session = Depends(get_db)) -> dict:
    participants = _participants(db)
    conditions = {}
    for condition in ("A", "B"):
        trials = [t for p in participants for t in p.trials if t.condition == condition and t.finished]
        scores = {kind: [q.score for p in participants for q in p.questionnaires
                         if q.condition == condition and q.kind == kind]
                  for kind in ("tlx", "sus", "satisfaction")}
        conditions[condition] = {
            "trials": len(trials),
            "completion_rate": round(sum(t.completed for t in trials) / len(trials), 2) if trials else None,
            "comprehension": ev.describe([t.comprehension for t in trials]),
            **{m: ev.describe([t.metrics.get(m) for t in trials]) for m in ev.METRICS},
            **{kind: ev.describe(values) for kind, values in scores.items()},
        }
    return {"participants": len(participants), "conditions": conditions}


@router.get("/export.csv", dependencies=guarded)
def export_csv(db: Session = Depends(get_db)) -> Response:
    """One row per trial, with the participant's per-condition questionnaire scores repeated."""
    buffer = io.StringIO()
    profile_keys = ["vision", "onset", "screen_reader", "braille", "audiobook_use", "voice_assistant_use"]
    writer = csv.writer(buffer)
    writer.writerow(["participant", "condition_order", *profile_keys, "trial_id", "condition", "task", "completed",
                     "comprehension", *ev.METRICS, "questions", "errors", "tlx", "sus", "satisfaction", "notes"])
    for p in _participants(db):
        scores = {(q.condition, q.kind): q.score for q in p.questionnaires}
        for t in p.trials:
            if not t.finished:
                continue
            writer.writerow([
                p.code, p.condition_order, *[p.profile.get(k, "") for k in profile_keys], t.id, t.condition,
                t.task_id, int(t.completed), t.comprehension if t.comprehension is not None else "",
                *[t.metrics.get(m, "") if t.metrics.get(m) is not None else "" for m in ev.METRICS],
                t.metrics.get("questions", ""), t.metrics.get("errors", ""),
                *[scores.get((t.condition, kind), "") for kind in ("tlx", "sus", "satisfaction")], t.notes,
            ])
    return Response(content=buffer.getvalue(), media_type="text/csv",
                    headers={"Content-Disposition": 'attachment; filename="evaluation.csv"'})
