from uuid import uuid4
from .seed import create_seed


def execute_action(database, session_id, request):
    from .workouts import record_workout_progress, apply_proposal, dismiss_proposal
    from .meals import undo_meal
    kind = request["kind"]
    if kind in ("start_workout", "complete_exercise", "undo_exercise", "finish_workout"):
        return record_workout_progress(database, session_id, request)
    if kind == "apply_proposal":
        return apply_proposal(database, session_id, request)
    if kind == "dismiss_proposal":
        return dismiss_proposal(database, session_id, request)
    if kind == "undo_meal":
        return undo_meal(database, session_id, request)

    def execute(current):
        if kind == "set_locale":
            current["locale"] = request["locale"]
            current["revision"] += 1
            return {"httpStatus": 200, "result": {"status": "succeeded", "operationId": str(uuid4())}, "snapshot": current}
        if kind == "reset_demo":
            snapshot = create_seed(session_id, request["scenario"], current["locale"])
            snapshot["resetEpoch"] = current["resetEpoch"] + 1
            snapshot["revision"] = current["revision"] + 1
            return {"httpStatus": 200, "result": {"status": "succeeded", "operationId": str(uuid4())}, "snapshot": snapshot}
        provider = kind in ("check_readiness", "request_proposal")
        return {"httpStatus": 503 if provider else 501, "result": {"status": "failed", "errorCode": "PROVIDER_NOT_CONFIGURED" if provider else "ACTION_NOT_AVAILABLE"}}

    return database.mutate(session_id, request, execute)
