"""FastAPI transport preserving the existing same-origin /api contract."""
import json
import logging
from contextlib import asynccontextmanager
from pathlib import Path
from urllib.parse import urlparse

from fastapi import FastAPI, Request
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse, Response

from .actions import execute_action
from .attachments import AttachmentStore, MAX_ATTACHMENT_BYTES
from .chat_validation import parse_chat
from .database import Database, now_ms
from .errors import BackendError
from .runtime import synchronize_runtime
from .session import SessionCookies, SESSION_MAX_AGE_SECONDS
from .validation import parse_action, action_adapter


def json_response(value, status=200, headers=None):
    return JSONResponse(value, status_code=status, headers={
        'Cache-Control': 'no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff',
        'X-Wellio-Schema-Version': '4', **(headers or {}),
    })


def assert_same_origin(request, public_origins):
    allowed = {str(request.base_url).rstrip('/'), *public_origins}
    origin, referer = request.headers.get('origin'), request.headers.get('referer')
    if request.headers.get('sec-fetch-site') == 'cross-site' or (origin is not None and origin not in allowed):
        raise BackendError('ORIGIN_NOT_ALLOWED', 403)
    if origin is None and referer is not None:
        parsed = urlparse(referer)
        if f'{parsed.scheme}://{parsed.netloc}' not in allowed:
            raise BackendError('ORIGIN_NOT_ALLOWED', 403)


async def read_body(request, maximum):
    declared = request.headers.get('content-length')
    if declared is not None and (not declared.isascii() or not declared.isdigit() or int(declared) > maximum):
        raise BackendError('PAYLOAD_TOO_LARGE', 413)
    data = bytearray()
    async for chunk in request.stream():
        if len(data) + len(chunk) > maximum:
            raise BackendError('PAYLOAD_TOO_LARGE', 413)
        data.extend(chunk)
    return bytes(data)


async def read_json(request):
    if request.headers.get('content-type', '').split(';')[0].strip().lower() != 'application/json':
        raise BackendError('UNSUPPORTED_MEDIA_TYPE', 415)
    data = await read_body(request, 16 * 1024)
    def reject_constant(_value):
        raise ValueError()
    try:
        return json.loads(data.decode('utf-8'), parse_constant=reject_constant)
    except (ValueError, UnicodeError):
        raise BackendError('INVALID_INPUT', 400) from None


async def read_attachment_form(request):
    if not request.headers.get('content-type', '').startswith('multipart/form-data;'):
        raise BackendError('UNSUPPORTED_MEDIA_TYPE', 415)
    raw = await read_body(request, MAX_ATTACHMENT_BYTES + 64 * 1024)
    async def receive():
        return {'type': 'http.request', 'body': raw, 'more_body': False}
    buffered = Request(request.scope, receive)
    try:
        async with buffered.form(max_files=1, max_fields=1, max_part_size=MAX_ATTACHMENT_BYTES + 64 * 1024) as form:
            file, purpose = form.get('file'), form.get('purpose')
            if len(form.multi_items()) != 2 or not isinstance(file, UploadFile) or purpose not in ('food', 'menu'):
                raise BackendError('INVALID_INPUT', 400)
            return await file.read(MAX_ATTACHMENT_BYTES + 1), file.filename, purpose
    except (ValueError, HTTPException):
        raise BackendError('INVALID_INPUT', 400) from None


def create_app(database_url, attachments_path=None, public_origins=(), cookie_secure=None, search_service=None):
    database = Database(database_url)
    cookies = SessionCookies(database.signing_key)
    attachments = AttachmentStore(attachments_path or Path('.data/attachments').absolute())

    @asynccontextmanager
    async def lifespan(_app):
        try:
            yield
        finally:
            try:
                if search_service is not None:
                    await search_service.close()
            finally:
                database.close()

    app = FastAPI(title='Wellio API', version='1.0.0', lifespan=lifespan, redirect_slashes=False)
    app.state.database = database
    app.state.attachments = attachments
    app.state.search = search_service

    @app.exception_handler(HTTPException)
    async def http_error(_request, error):
        return json_response({'errorCode': 'METHOD_NOT_ALLOWED' if error.status_code == 405 else 'NOT_FOUND'}, error.status_code, error.headers)

    @app.get('/healthz')
    async def health():
        return {'status': 'ok', 'backend': 'fastapi', 'schemaVersion': 4}

    async def handle(request: Request):
        action = None
        secure = cookie_secure if cookie_secure is not None else request.url.scheme == 'https'
        try:
            assert_same_origin(request, public_origins)
            sid = cookies.read(request)
            path = request.url.path
            if path == '/api/state':
                headers = {}
                if not sid:
                    expires = now_ms() + SESSION_MAX_AGE_SECONDS * 1000
                    snapshot = await run_in_threadpool(database.create_session, expires)
                    sid = snapshot['sessionId']
                    headers['Set-Cookie'] = cookies.issue(sid, expires, secure)
                capabilities = {'agent': False, 'menuSearch': bool(search_service and search_service.available)}
                snapshot = await run_in_threadpool(synchronize_runtime, database, sid, capabilities)
                return json_response(snapshot, headers=headers)
            if not sid:
                raise BackendError('SESSION_REQUIRED', 401)
            current = await run_in_threadpool(database.get_snapshot, sid)
            if path.startswith('/api/attachments/'):
                stored = await run_in_threadpool(attachments.read, sid, current['resetEpoch'], request.path_params['attachment_id'])
                return Response(stored['bytes'], headers={'Content-Type': stored['mediaType'], 'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'"})
            if path == '/api/attachments':
                data, name, purpose = await read_attachment_form(request)
                saved = await run_in_threadpool(attachments.upload, sid, current['resetEpoch'], data, name, purpose)
                if (await run_in_threadpool(database.get_snapshot, sid))['resetEpoch'] != current['resetEpoch']:
                    await run_in_threadpool(attachments.reset, sid, current['resetEpoch'])
                    raise BackendError('STALE_EPOCH', 409)
                return json_response(saved)
            if path == '/api/chat':
                raise BackendError('PROVIDER_NOT_CONFIGURED', 503)
            action = parse_action(await read_json(request))
            reply = await run_in_threadpool(execute_action, database, sid, action)
            if action['kind'] == 'reset_demo' and reply['result']['status'] == 'succeeded':
                await run_in_threadpool(attachments.reset, sid, action['resetEpoch'])
            return json_response(reply['result'], reply['httpStatus'])
        except Exception as error:
            known = isinstance(error, BackendError)
            code, status = (error.code, error.http_status) if known else ('INTERNAL_ERROR', 500)
            if not known:
                logging.getLogger('wellio').error('Backend request failed (%s)', type(error).__name__)
            headers = {'Set-Cookie': cookies.clear(secure)} if code == 'INVALID_SESSION' and request.method == 'GET' and request.url.path == '/api/state' else {}
            return json_response({**({'requestId': action['requestId'], 'resetEpoch': action['resetEpoch']} if action else {}), 'status': 'conflict' if status == 409 else 'failed', 'errorCode': code}, status, headers)

    app.add_api_route('/api/state', handle, methods=['GET'], name='get_state')
    action_schema = action_adapter.json_schema(ref_template='#/components/schemas/{model}')
    definitions = action_schema.pop('$defs', {})
    app.add_api_route('/api/actions', handle, methods=['POST'], name='execute_action', openapi_extra={'requestBody': {'required': True, 'content': {'application/json': {'schema': action_schema}}}})
    original_openapi = app.openapi
    def openapi():
        schema = original_openapi()
        schema.setdefault('components', {}).setdefault('schemas', {}).update(definitions)
        return schema
    app.openapi = openapi
    app.add_api_route('/api/chat', handle, methods=['POST'], name='chat')
    app.add_api_route('/api/attachments', handle, methods=['POST'], name='upload_attachment')
    app.add_api_route('/api/attachments/{attachment_id}', handle, methods=['GET'], name='read_attachment')
    return app
