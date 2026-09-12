"""Eight controlled business tools, independent of any model execution SDK."""
from copy import deepcopy
from dataclasses import dataclass
from hashlib import sha256
from typing import Any, Callable

from .agent_state import assert_run, save_tool_step, update_run
from .authorization import authorize_user_mutation
from .errors import BackendError
from .meals import mutate_meal_log, undo_meal
from .read_services import get_day_context, query_history
from .validation import canonical_json, strict_object
from .workouts import get_exercise_catalog, get_gym_equipment, propose_workout, record_workout_progress


def tool_request_id(run_id, tool_call_id):
    return 'tool-' + sha256((run_id + '\0' + tool_call_id).encode()).hexdigest()


def _object(properties, required=None):
    return {'type': 'object', 'properties': properties, 'required': list(properties) if required is None else required, 'additionalProperties': False}


ID = {'type': 'string', 'pattern': '^[A-Za-z0-9_-]{1,128}$'}
TEXT = {'type': 'string', 'minLength': 1, 'maxLength': 2000}
LOCALIZED = _object({'en': TEXT, 'zh-CN': TEXT})
GYM = {'type': 'string', 'enum': ['gym-a', 'gym-b']}
STATUS = {'type': 'string', 'enum': ['available', 'temporarily_occupied', 'unavailable']}
BASELINE = {'portion': LOCALIZED, 'originalPortion': _object({'quantity': {'type': 'number', 'exclusiveMinimum': 0, 'maximum': 100000}, 'unit': {'enum': ['g', 'ml', 'piece', 'serving']}}),
            'base': _object({key: {'type': 'number', 'minimum': 0, 'maximum': 10000 if key == 'kcal' else 2000} for key in ('kcal', 'protein', 'carbs', 'fat')}),
            'nutrientUnits': _object({'energy': {'const': 'kcal'}, 'mass': {'const': 'g'}})}
MEAL_ITEM = _object({**BASELINE, 'name': LOCALIZED, 'consumedFraction': {'type': 'number', 'minimum': 0, 'maximum': 1}, 'estimated': {'type': 'boolean'}})
MEAL = _object({'period': {'enum': ['breakfast', 'lunch', 'dinner', 'snack']}, 'time': {'type': 'string', 'pattern': '^(?:[01][0-9]|2[0-3]):[0-5][0-9]$'}, 'items': {'type': 'array', 'items': MEAL_ITEM, 'minItems': 1, 'maxItems': 30}})
LOAD = _object({'value': {'type': ['number', 'null'], 'minimum': 0}, 'unit': {'const': 'kg'}, 'basis': {'enum': ['per_hand', 'machine_stack', 'bodyweight']},
                'source': {'enum': ['mock_history', 'user', 'missing']}, 'reason': LOCALIZED, 'sourceHistoryId': ID, 'sourceMessageId': ID}, ['value', 'unit', 'basis', 'source', 'reason'])
EXERCISE = _object({'id': ID, 'catalogId': ID, 'name': LOCALIZED, 'equipmentId': ID, 'equipment': LOCALIZED, 'sets': {'type': 'integer', 'minimum': 1, 'maximum': 6},
                    'reps': {'type': 'integer', 'minimum': 1, 'maximum': 30}, 'restSeconds': {'type': 'integer', 'minimum': 15, 'maximum': 300}, 'suggestedLoad': LOAD,
                    'completed': {'type': 'boolean'}, 'instructions': LOCALIZED, 'animation': {'enum': ['row', 'pulldown', 'lateral', 'squat']}, 'replacesId': ID, 'equipmentStatus': STATUS},
                   ['id', 'catalogId', 'name', 'equipmentId', 'equipment', 'sets', 'reps', 'restSeconds', 'suggestedLoad', 'completed', 'instructions'])
WORKOUT = _object({'id': ID, 'trainingSessionId': ID, 'version': {'type': 'integer', 'minimum': 1}, 'dayKey': {'type': 'string'}, 'name': LOCALIZED, 'gymId': GYM,
                   'estimatedMinutes': {'type': 'integer', 'minimum': 1, 'maximum': 180}, 'status': {'enum': ['planned', 'in_progress', 'completed']},
                   'exercises': {'type': 'array', 'items': EXERCISE, 'minItems': 1, 'maxItems': 12}, 'startedAt': {'type': 'string'}, 'endedAt': {'type': 'string'},
                   'actualMinutes': {'type': 'number'}, 'source': {'enum': ['demo_preset', 'agent_proposal']}},
                  ['id', 'trainingSessionId', 'version', 'dayKey', 'name', 'gymId', 'estimatedMinutes', 'status', 'exercises'])
SCHEMAS = {
    'get_day_context': _object({}),
    'get_gym_equipment': _object({'gymId': GYM}),
    'query_history': _object({'metric': {'enum': ['weight', 'training', 'nutrition', 'exercise_load']}, 'from': {'type': 'string', 'format': 'date'}, 'to': {'type': 'string', 'format': 'date'}, 'exerciseId': ID, 'equipmentId': ID}, ['metric', 'from', 'to']),
    'search_restaurant_menu': _object({key: {'type': 'string', 'minLength': 1, 'maxLength': 120} for key in ('restaurant', 'city', 'branch')}, ['restaurant', 'city']),
    'mutate_meal_log': _object({'action': {'enum': ['add', 'update', 'delete']}, 'meal': MEAL, 'mealId': ID, 'mealItemId': ID,
                              'changes': {'anyOf': [_object({'consumedFraction': {'type': 'number', 'minimum': 0, 'maximum': 1}}), _object({'baseline': _object(BASELINE)})]}}, ['action']),
    'undo_meal_change': _object({'operationId': ID}),
    'propose_workout': _object({'scope': {'enum': ['workout', 'schedule']}, 'reason': LOCALIZED, 'contextReadId': ID, 'workout': WORKOUT}, ['scope', 'reason', 'contextReadId']),
    'record_workout_progress': _object({'kind': {'enum': ['start_workout', 'complete_exercise', 'undo_exercise', 'finish_workout']}, 'workoutId': ID, 'exerciseId': ID,
                                      'actualMinutes': {'type': 'integer', 'minimum': 1, 'maximum': 1440}, 'confirmIncomplete': {'type': 'boolean'}}, ['kind', 'workoutId']),
}
OPERATIONS = {'get_day_context': 'context', 'get_gym_equipment': 'equipment', 'query_history': 'history', 'search_restaurant_menu': 'menu_search',
              'undo_meal_change': 'meal_undo', 'propose_workout': 'workout_proposal', 'record_workout_progress': 'workout_progress'}


@dataclass
class AgentDependencies:
    db: Any
    run: dict
    now: Callable
    search_service: Any
    emit: Callable

    def context(self):
        current = assert_run(self.db, self.run, self.now())
        if not current.get('lastContextReadId'):
            raise BackendError('CONTEXT_READ_REQUIRED', 409)
        return self.db.get_context_read(self.run['sessionId'], current['lastContextReadId'], self.run['id'], self.run['resetEpoch'])

    def context_required(self):
        try:
            self.context()
            return False
        except BackendError as error:
            if error.code in ('CONTEXT_READ_REQUIRED', 'CONTEXT_STALE', 'VERSION_CONFLICT'):
                return True
            raise

    def intent(self):
        current = assert_run(self.db, self.run, self.now())
        if current['source'] != 'user' or not current.get('sourceMessageId'):
            raise BackendError('USER_INTENT_REQUIRED', 403)
        source = self.db.get_user_input(current['sessionId'], current['resetEpoch'], current['sourceMessageId'])
        intent = current.get('preparedIntent')
        if not source or not intent:
            raise BackendError('USER_INTENT_REQUIRED', 403)
        if intent['kind'] == 'needs_input':
            raise BackendError(intent['errorCode'], 200)
        return source, intent


async def _execute(deps, name, input, request_id, call_id):
    db, run = deps.db, deps.run
    sid, epoch = run['sessionId'], run['resetEpoch']
    if name != 'get_day_context':
        deps.context()
    write = lambda execute: db.with_agent_tool({'sessionId': sid, 'runId': run['id'], 'toolCallId': call_id, 'now': deps.now}, execute)
    if name == 'get_day_context':
        strict_object(input, set())
        context = get_day_context(db, sid, {'runId': run['id'], 'requestId': request_id, 'resetEpoch': epoch})
        update_run(db, run, deps.now, lambda snapshot, current, message: current.update(lastContextReadId=context['id'], lastVersions=context['versions']))
        result = deepcopy(context)
        result['snapshot']['messages'] = []
        return result
    if name == 'get_gym_equipment':
        strict_object(input, {'gymId'})
        return {**get_gym_equipment(input['gymId'], db.get_snapshot(sid)['conditions'].get('equipmentStatus', {})), 'catalog': get_exercise_catalog(input['gymId'])}
    if name == 'query_history':
        return query_history(db, sid, {**input, 'resetEpoch': epoch})
    if name == 'search_restaurant_menu':
        def reserve(snapshot, current, message):
            if current['searchUsed']:
                raise BackendError('SEARCH_LIMIT_REACHED', 429)
            current['searchUsed'] = True
        update_run(db, run, deps.now, reserve)
        return await deps.search_service.search_restaurant_menu(input)
    if name == 'mutate_meal_log':
        _, intent = deps.intent()
        if intent['kind'] != 'meal':
            raise BackendError('USER_INTENT_REQUIRED', 403)
        context = deps.context()
        meal = next((item for item in context['snapshot']['meals'] if item['id'] == input.get('mealId')), None)
        request = {**input, 'kind': 'mutate_meal_log', 'requestId': request_id, 'resetEpoch': epoch, 'runId': run['id'], 'expectedMealRevision': context['snapshot']['mealRevision']}
        if input.get('action') != 'add':
            request['expectedMealVersion'] = meal['version'] if meal else 1
        def apply_meal():
            grant = authorize_user_mutation(db, sid, {'sourceMessageId': run['sourceMessageId'], 'resetEpoch': epoch, 'runId': run['id']})
            return mutate_meal_log(db, sid, {**request, 'authorizationId': grant['id']})
        return write(apply_meal)
    if name == 'undo_meal_change':
        strict_object(input, {'operationId'})
        source, intent = deps.intent()
        if intent['kind'] != 'undo' or intent['operationId'] != input['operationId']:
            raise BackendError('USER_INTENT_REQUIRED', 403)
        if source['versions']['meal'] != db.get_snapshot(sid)['mealRevision']:
            raise BackendError('VERSION_CONFLICT', 409)
        return write(lambda: undo_meal(db, sid, {'kind': 'undo_meal', **input, 'requestId': request_id, 'resetEpoch': epoch, 'source': 'agent'}))
    if name == 'propose_workout':
        context = deps.context()
        if context['id'] != input.get('contextReadId'):
            raise BackendError('CONTEXT_STALE', 409)
        if run.get('requestedGymId') and (input.get('scope') != 'workout' or input.get('workout', {}).get('gymId') != run['requestedGymId']):
            raise BackendError('UI_GYM_MISMATCH', 409)
        return write(lambda: propose_workout(db, sid, {**input, 'kind': 'propose_workout', 'requestId': request_id, 'resetEpoch': epoch, 'runId': run['id']}))
    if name == 'record_workout_progress':
        source, intent = deps.intent()
        if intent['kind'] != 'progress' or canonical_json(intent['action']) != canonical_json(input):
            raise BackendError('USER_INTENT_REQUIRED', 403)
        snapshot = deps.context()['snapshot']
        if source['versions'].get('workout') != (snapshot.get('workout') or {}).get('version') or source['versions'].get('plan') != snapshot['plan']['version']:
            raise BackendError('VERSION_CONFLICT', 409)
        return write(lambda: record_workout_progress(db, sid, {**input, 'requestId': request_id, 'resetEpoch': epoch, 'source': 'agent', 'expectedWorkoutVersion': snapshot['workout']['version']}))
    raise BackendError('TOOL_NOT_AVAILABLE', 403)


async def execute_tool(deps, name, input, call_id):
    run = deps.run
    if name not in SCHEMAS:
        raise BackendError('TOOL_NOT_AVAILABLE', 403)
    if not isinstance(call_id, str) or not call_id or len(call_id) > 256:
        raise BackendError('INVALID_TOOL_CALL_ID', 400)
    current = assert_run(deps.db, run, deps.now())
    if call_id in current['toolIds']:
        return {'status': 'failed', 'errorCode': 'TOOL_CALL_ID_REUSED'}
    request_id = tool_request_id(run['id'], call_id)
    operation = 'meal_' + str(input.get('action', 'update')) if name == 'mutate_meal_log' else OPERATIONS[name]
    if operation not in ('meal_add', 'meal_update', 'meal_delete') and name == 'mutate_meal_log':
        operation = 'meal_update'
    step = {'id': request_id, 'toolCallId': call_id, 'operation': operation, 'status': 'started'}
    envelope = {'requestId': run['requestId'], 'resetEpoch': run['resetEpoch'], 'messageId': run['messageId']}
    save_tool_step(deps.db, run, step, deps.now, initial=True)
    deps.emit({'type': 'tool', **envelope, 'step': deepcopy(step)})
    try:
        # Model-facing JSON schemas advertise flat input; native domain
        # validators still reject every unknown field and authority claim.
        schema = SCHEMAS[name]
        strict_object(input, set(schema['required']), set(schema['properties']) - set(schema['required']))
        value = await _execute(deps, name, input, request_id, call_id)
        assert_run(deps.db, run, deps.now())
        result = value.get('result', value) if isinstance(value, dict) else {}
        status = result.get('status')
        step['status'] = 'awaiting_user' if status == 'needs_input' else 'failed' if status in ('failed', 'conflict') else 'succeeded'
        if result.get('errorCode'):
            step['errorCode'] = result['errorCode']
        snapshot = save_tool_step(deps.db, run, step, deps.now)
        deps.emit({'type': 'tool', **envelope, 'step': deepcopy(step)})
        deps.emit({'type': 'snapshot', 'requestId': run['requestId'], 'resetEpoch': run['resetEpoch'], 'snapshot': snapshot})
        return value
    except BackendError as error:
        step.update(status='awaiting_user' if error.http_status in (200, 422) else 'failed', errorCode=error.code)
        save_tool_step(deps.db, run, step, deps.now)
        deps.emit({'type': 'tool', **envelope, 'step': step})
        return {'status': 'needs_input' if step['status'] == 'awaiting_user' else 'failed', 'errorCode': error.code}
