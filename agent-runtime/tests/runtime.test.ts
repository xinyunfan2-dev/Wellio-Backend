import {afterEach, describe, expect, it, vi} from 'vitest'
import {createAgentRuntime} from '../src/runtime.js'
import type {RuntimeOptions} from '../src/contracts.js'
import {answer, deferred, gatedStep, output, scriptedModel, toolCall} from './sdk-fixtures.js'

const toolNames = ['get_day_context', 'get_gym_equipment', 'query_history', 'search_restaurant_menu', 'mutate_meal_log', 'undo_meal_change', 'propose_workout', 'record_workout_progress']
const schemas = Object.fromEntries(toolNames.map(name => [name, {type: 'object', properties: name === 'mutate_meal_log' ? {action: {type: 'string'}} : {}, additionalProperties: false}]))
const chat = {requestId: 'request-1', resetEpoch: 1, conversationId: 'thread-1', source: 'user', message: 'Review my saved day.', locale: 'en', attachmentIds: []}
const snapshot = {sessionId: 'signed-session', resetEpoch: 1, conversationId: 'thread-1', revision: 1, readiness: {id: 'authoritative-watch', score: 82, source: 'mock_watch'}}
const envelope = {requestId: chat.requestId, resetEpoch: 1}
const runInput = (patch = {}) => ({threadId: chat.conversationId, runId: chat.requestId, state: {}, messages: [], tools: [], context: [], forwardedProps: {wellio: chat}, ...patch})
const request = (input = runInput(), headers = {}, signal?: AbortSignal) => new Request('http://node.local/api/copilotkit/agent/wellio/run', {method: 'POST', headers: {'content-type': 'application/json', cookie: 'wellio_session=signed-cookie', origin: 'http://frontend.local', ...headers}, body: JSON.stringify(input), signal})
const parseEvents = (text: string) => text.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)))
const textOf = (events: any[]) => events.filter(event => event.type === 'TEXT_MESSAGE_CONTENT').map(event => event.delta).join('')

function mockRpc(hooks: Record<string, (payload: any, request: Request) => unknown | Promise<unknown>> = {}) {
  let contextRequired = true
  const calls: {name: string; payload: any; headers: Headers}[] = []
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    const name = new URL(request.url).pathname.split('/').at(-1)!
    const payload = await request.json()
    calls.push({name, payload, headers: request.headers})
    if (hooks[name]) {
      const value = await hooks[name](payload, request)
      if (value instanceof Response) return value
      if (value !== undefined) return Response.json(value)
    }
    if (name === 'open') return Response.json({runId: 'backend-run-uuid', messageId: 'assistant-id', request: payload.request ?? chat, events: [{type: 'snapshot', ...envelope, snapshot}], tools: schemas, messages: [{role: 'user', content: 'TRUSTED_USER_MESSAGE'}], instructions: 'Trusted locale en. The source is user.', contextRequired: true})
    if (name === 'status') return Response.json({active: true, contextRequired})
    if (name === 'tool') {
      contextRequired = payload.name !== 'get_day_context'
      return Response.json({result: payload.name === 'get_day_context' ? {contextReadId: 'context-1', snapshot, totals: {consumed: {kcal: 1000}}} : {status: 'succeeded', operationId: 'saved-operation'}, contextRequired, events: [{type: 'tool', ...envelope, messageId: 'assistant-id', step: {id: payload.toolCallId, toolCallId: payload.toolCallId, operation: payload.name === 'get_day_context' ? 'context' : 'meal_add', status: 'succeeded'}}]})
    }
    if (name === 'finish') return Response.json({events: [{type: 'snapshot', ...envelope, snapshot: {...snapshot, revision: 2}}, {type: 'done', ...envelope, messageId: 'assistant-id'}]})
    if (name === 'cancel') return Response.json({events: [{type: 'error', ...envelope, messageId: 'assistant-id', errorCode: payload.errorCode ?? 'RUN_STOPPED'}]})
    throw new Error(`Unexpected RPC ${name}`)
  }) as typeof fetch
  return {fetch: fetcher, calls}
}

const live: ReturnType<typeof createAgentRuntime>[] = []
function runtime(model: RuntimeOptions['model'], rpc = mockRpc(), options: Partial<RuntimeOptions> = {}) {
  const instance = createAgentRuntime({backendUrl: 'http://127.0.0.1:8000', token: 'PRIVATE_INTERNAL_TOKEN', model, fetch: rpc.fetch, ...options})
  live.push(instance)
  return instance
}
afterEach(async () => {await Promise.all(live.splice(0).map(instance => instance.close()))})

describe('BuiltInAgent factory with the real AI SDK 6 tool loop', () => {
  it('forces real context, uses trusted prompt, validates finish and emits canonical AG-UI/legacy events', async () => {
    const model = scriptedModel([() => toolCall(), () => output()])
    const rpc = mockRpc()
    const instance = runtime(model, rpc)
    const response = await instance.handleRequest(request())
    expect(response.status).toBe(200)
    const events = parseEvents(await response.text())
    expect(events[0]).toMatchObject({type: 'RUN_STARTED', threadId: 'thread-1', runId: 'request-1'})
    expect(events.at(-1)).toMatchObject({type: 'RUN_FINISHED', threadId: 'thread-1', runId: 'request-1'})
    expect(textOf(events)).toBe(answer.markdown)
    expect(events.some(event => event.type === 'TOOL_CALL_ARGS')).toBe(false)
    expect(events.filter(event => event.type === 'CUSTOM' && event.value.type === 'text').map(event => event.value.delta).join('')).toBe(answer.markdown)
    expect(model.doStreamCalls).toHaveLength(2)
    expect(model.doStreamCalls[0].toolChoice).toEqual({type: 'tool', toolName: 'get_day_context'})
    expect(model.doStreamCalls[0].tools?.map(tool => tool.name)).toEqual(['get_day_context'])
    expect(model.doStreamCalls[1].tools?.map(tool => tool.name).sort()).toEqual([...toolNames].sort())
    expect(JSON.stringify(model.doStreamCalls[1].prompt)).toContain('authoritative-watch')
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain('wellio-prompt/0.1.0')
    expect(JSON.stringify(model.doStreamCalls[0].prompt)).toContain('knowledge retrieval is not connected')
    expect(JSON.stringify(model.doStreamCalls)).not.toContain('PRIVATE_INTERNAL_TOKEN')
    expect(rpc.calls.map(call => call.name)).toEqual(['open', 'status', 'tool', 'status', 'finish'])
    expect(rpc.calls.find(call => call.name === 'finish')!.payload.output).toEqual(answer)
    for (const call of rpc.calls) {
      expect(call.headers.get('authorization')).toBe('Bearer PRIVATE_INTERNAL_TOKEN')
      expect(call.headers.get('cookie')).toBe('wellio_session=signed-cookie')
      expect(call.headers.get('origin')).toBe('http://frontend.local')
    }
  })

  it('does not publish raw prose or tool arguments while Python finish is still pending', async () => {
    const entered = deferred<void>(), release = deferred<void>()
    const rpc = mockRpc({finish: async () => {entered.resolve(); await release.promise}})
    const instance = runtime(scriptedModel([() => toolCall(), () => output()]), rpc)
    const response = await instance.handleRequest(request())
    const reader = response.body!.getReader()
    const seen: string[] = []
    const reading = (async () => {while (true) {const {value, done} = await reader.read(); if (done) break; seen.push(new TextDecoder().decode(value))}})()
    await entered.promise
    expect(seen.join('')).not.toContain(answer.markdown)
    expect(seen.join('')).not.toContain('trainingSummary')
    expect(seen.join('')).not.toContain('TOOL_CALL_ARGS')
    release.resolve()
    await reading
    expect(textOf(parseEvents(seen.join('')))).toBe(answer.markdown)
  })

  it('re-reads context after a successful mutation before generating final summaries', async () => {
    const model = scriptedModel([() => toolCall(), () => toolCall('mutate_meal_log', {action: 'add'}, 'meal-write'), () => toolCall('get_day_context', {}, 'fresh-context'), () => output()])
    const rpc = mockRpc()
    const response = await runtime(model, rpc).handleRequest(request())
    expect(textOf(parseEvents(await response.text()))).toBe(answer.markdown)
    expect(model.doStreamCalls).toHaveLength(4)
    expect(model.doStreamCalls[2].toolChoice).toEqual({type: 'tool', toolName: 'get_day_context'})
    expect(model.doStreamCalls[2].tools?.map(tool => tool.name)).toEqual(['get_day_context'])
    expect(rpc.calls.filter(call => call.name === 'tool').map(call => call.payload.name)).toEqual(['get_day_context', 'mutate_meal_log', 'get_day_context'])
  })

  it('rejects late output after a concurrent version change without publishing it', async () => {
    const rpc = mockRpc({finish: () => Response.json({errorCode: 'VERSION_CONFLICT'}, {status: 409})})
    const events = parseEvents(await (await runtime(scriptedModel([() => toolCall(), () => output()]), rpc).handleRequest(request())).text())
    expect(textOf(events)).toBe('')
    expect(events.some(event => event.type === 'RUN_FINISHED')).toBe(false)
    expect(JSON.stringify(events)).toContain('VERSION_CONFLICT')
    expect(rpc.calls.filter(call => call.name === 'cancel')).toHaveLength(1)
  })

  it('does not retry provider failure or leak provider secrets, and leaves committed tool facts intact', async () => {
    const model = scriptedModel([() => toolCall(), () => toolCall('mutate_meal_log', {action: 'add'}, 'saved-meal'), () => {throw new Error('PROVIDER_SECRET_DO_NOT_EXPOSE')}])
    const rpc = mockRpc()
    const events = parseEvents(await (await runtime(model, rpc).handleRequest(request())).text())
    expect(textOf(events)).toBe('')
    expect(JSON.stringify(events)).not.toContain('PROVIDER_SECRET_DO_NOT_EXPOSE')
    expect(model.doStreamCalls).toHaveLength(3)
    expect(rpc.calls.filter(call => call.name === 'tool' && call.payload.name === 'mutate_meal_log')).toHaveLength(1)
    expect(rpc.calls.filter(call => call.name === 'finish')).toHaveLength(0)
    expect(rpc.calls.find(call => call.name === 'cancel')!.payload.status).toBe('failed')
  })

  it('never accepts incomplete structured model output', async () => {
    const rpc = mockRpc()
    const response = await runtime(scriptedModel([() => toolCall(), () => output({markdown: 'Missing required summaries'})]), rpc).handleRequest(request())
    const events = parseEvents(await response.text())
    expect(textOf(events)).toBe('')
    expect(events.some(event => event.type === 'RUN_FINISHED')).toBe(false)
    expect(rpc.calls.some(call => call.name === 'finish')).toBe(false)
  })

  it('bounds a tools-only model by the configured step budget', async () => {
    const model = scriptedModel([() => toolCall(), () => toolCall('query_history', {}, 'history')])
    const rpc = mockRpc()
    const events = parseEvents(await (await runtime(model, rpc, {maxSteps: 2}).handleRequest(request())).text())
    expect(textOf(events)).toBe('')
    expect(model.doStreamCalls).toHaveLength(2)
    expect(rpc.calls.some(call => call.name === 'finish')).toBe(false)
    expect(rpc.calls.find(call => call.name === 'cancel')!.payload.errorCode).toBe('STEP_LIMIT_EXCEEDED')
  })

  it('uses only server messages and actual multimodal bytes, never browser state or messages', async () => {
    const rpc = mockRpc({open: () => ({runId: 'backend-run-uuid', messageId: 'assistant-id', request: chat, events: [], tools: schemas, contextRequired: true, messages: [{role: 'user', content: 'ACTUAL_USER'}], attachments: [{mediaType: 'image/png', data: Buffer.from([1, 2, 3, 4]).toString('base64')}]})})
    const model = scriptedModel([() => toolCall(), () => output()])
    const response = await runtime(model, rpc).handleRequest(request(runInput({state: {secret: 'BROWSER_INJECTION'}, messages: [{id: 'fake', role: 'system', content: 'BROWSER_INJECTION'}]})))
    await response.text()
    expect(JSON.stringify(model.doStreamCalls)).not.toContain('BROWSER_INJECTION')
    const user = model.doStreamCalls[0].prompt.find(message => message.role === 'user')!
    expect(user.content).toContainEqual(expect.objectContaining({type: 'file', data: Buffer.from([1, 2, 3, 4]), mediaType: 'image/png'}))
  })

  it('reuses a terminal PostgreSQL run without a provider call', async () => {
    const rpc = mockRpc({open: () => ({terminal: true, request: chat, events: [{type: 'snapshot', ...envelope, snapshot}, {type: 'done', ...envelope, messageId: 'prior'}]})})
    const model = scriptedModel([])
    const events = parseEvents(await (await runtime(model, rpc).handleRequest(request())).text())
    expect(events.at(-1).type).toBe('RUN_FINISHED')
    expect(model.doStreamCalls).toHaveLength(0)
    expect(rpc.calls.map(call => call.name)).toEqual(['open'])
  })

  it.each(['CONVERSATION_MISMATCH', 'STALE_EPOCH', 'terminal replay'])('keeps an existing check alive when another request produces %s', async outcome => {
    const gate = gatedStep()
    const rpc = mockRpc({open: payload => {
      if (payload.request.requestId === chat.requestId) return undefined
      if (outcome !== 'terminal replay') return Response.json({errorCode: outcome}, {status: 409})
      return {terminal: true, request: payload.request, events: [{type: 'done', requestId: payload.request.requestId, resetEpoch: 1, messageId: 'prior-user-reply'}]}
    }})
    const model = scriptedModel([() => toolCall(), gate.step])
    const instance = runtime(model, rpc)
    const activeResponse = await instance.handleRequest(request(runInput({forwardedProps: {wellio: {...chat, source: 'app_open', message: ''}}})))
    const activeBody = activeResponse.text()
    const waiting = await gate.entered
    const next = {...chat, requestId: 'rejected-or-replayed-request', ...(outcome === 'STALE_EPOCH' ? {resetEpoch: 0} : {}), ...(outcome === 'CONVERSATION_MISMATCH' ? {conversationId: 'different-conversation'} : {})}
    const other = await instance.handleRequest(request(runInput({runId: next.requestId, threadId: next.conversationId, forwardedProps: {wellio: next}})))
    expect(other.status).toBe(outcome === 'terminal replay' ? 200 : 409)
    await other.text()
    expect(waiting.abortSignal?.aborted).toBe(false)
    expect(rpc.calls.filter(call => call.name === 'cancel')).toHaveLength(0)
    expect(model.doStreamCalls).toHaveLength(2)
    gate.release(output())
    expect(textOf(parseEvents(await activeBody))).toBe(answer.markdown)
  })

  it('isolates simultaneous sessions with the same public thread id and has no shared message cache', async () => {
    const gate = gatedStep()
    const rpc = mockRpc({open: (payload, httpRequest) => ({
      runId: httpRequest.headers.get('cookie')!.includes('second') ? 'backend-second' : 'backend-first', messageId: 'assistant-id', request: payload.request,
      events: [], tools: schemas, contextRequired: true,
      messages: [{role: 'user', content: httpRequest.headers.get('cookie')!.includes('second') ? 'SECOND_PRIVATE_HISTORY' : 'FIRST_PRIVATE_HISTORY'}],
    })})
    const model = scriptedModel([() => toolCall(), gate.step, () => toolCall(), () => output()])
    const instance = runtime(model, rpc)
    const first = await instance.handleRequest(request())
    const firstBody = first.text()
    const waiting = await gate.entered
    const second = await instance.handleRequest(request(runInput(), {cookie: 'wellio_session=second'}))
    expect(textOf(parseEvents(await second.text()))).toBe(answer.markdown)
    expect(waiting.abortSignal?.aborted).toBe(false)
    expect(JSON.stringify(model.doStreamCalls[2].prompt)).toContain('SECOND_PRIVATE_HISTORY')
    expect(JSON.stringify(model.doStreamCalls[2].prompt)).not.toContain('FIRST_PRIVATE_HISTORY')
    expect(rpc.calls.filter(call => call.name === 'cancel')).toHaveLength(0)
    gate.release(output())
    expect(textOf(parseEvents(await firstBody))).toBe(answer.markdown)
    expect(rpc.calls.filter(call => call.name === 'finish').map(call => call.payload.runId)).toEqual(['backend-second', 'backend-first'])
  })

  it('propagates disconnect to the SDK and sends cancel with an independent live signal', async () => {
    const gate = gatedStep()
    const rpc = mockRpc({cancel: (_payload, request) => {expect(request.signal.aborted).toBe(false)}})
    const model = scriptedModel([() => toolCall(), gate.step])
    const controller = new AbortController()
    const response = await runtime(model, rpc).handleRequest(request(runInput(), {}, controller.signal))
    const reading = response.text()
    const options = await gate.entered
    controller.abort()
    await reading
    expect(options.abortSignal?.aborted).toBe(true)
    expect(rpc.calls.find(call => call.name === 'cancel')!.payload).toMatchObject({status: 'stopped', errorCode: 'RUN_STOPPED'})
    expect(model.doStreamCalls).toHaveLength(2)
  })

  it('bounds a hung provider with a real abort and durable failed TIMEOUT', async () => {
    const gate = gatedStep(), rpc = mockRpc()
    const model = scriptedModel([() => toolCall(), gate.step])
    const response = await runtime(model, rpc, {timeoutMs: 80}).handleRequest(request())
    const options = await gate.entered
    const events = parseEvents(await response.text())
    expect(options.abortSignal?.aborted).toBe(true)
    expect(textOf(events)).toBe('')
    expect(rpc.calls.find(call => call.name === 'cancel')!.payload).toMatchObject({status: 'failed', errorCode: 'TIMEOUT'})
  })

  it('authenticates explicit Stop to the active cookie and never stops another cookie', async () => {
    const gate = gatedStep(), rpc = mockRpc()
    const instance = runtime(scriptedModel([() => toolCall(), gate.step]), rpc)
    const response = await instance.handleRequest(request())
    const reading = response.text()
    const options = await gate.entered
    const stop = (cookie: string) => instance.handleRequest(new Request('http://node.local/api/copilotkit/agent/wellio/stop/thread-1', {method: 'POST', headers: {cookie}}))
    expect(await (await stop('wellio_session=another-cookie')).json()).toEqual({stopped: false})
    expect(options.abortSignal?.aborted).toBe(false)
    expect(await (await stop('wellio_session=signed-cookie')).json()).toEqual({stopped: true})
    await reading
    expect(options.abortSignal?.aborted).toBe(true)
  })
})

describe('HTTP and RPC boundaries', () => {
  it('serves info honestly while model configuration is missing', async () => {
    const rpc = mockRpc(), instance = runtime(undefined, rpc)
    expect((await (await instance.handleRequest(new Request('http://node.local/api/copilotkit/info'))).json()).agents.wellio.className).toBe('BuiltInAgent')
    const response = await instance.handleRequest(request())
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({errorCode: 'PROVIDER_NOT_CONFIGURED'})
    expect(rpc.calls).toHaveLength(0)
  })

  it.each([{threadId: 'forged-thread'}, {runId: 'forged-run'}, {tools: [{name: 'arbitrary_write', description: 'bad', parameters: {type: 'object'}}]}])('rejects forged public identity or browser tools: %j', async patch => {
    const rpc = mockRpc(), model = scriptedModel([])
    expect((await runtime(model, rpc).handleRequest(request(runInput(patch)))).status).toBe(400)
    expect(model.doStreamCalls).toHaveLength(0)
    expect(rpc.calls).toHaveLength(0)
  })

  it('preserves an open rejection as a non-stream HTTP error without calling a model', async () => {
    const rpc = mockRpc({open: () => Response.json({errorCode: 'STALE_EPOCH'}, {status: 409})})
    const model = scriptedModel([])
    const response = await runtime(model, rpc).handleRequest(request())
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({status: 'conflict', errorCode: 'STALE_EPOCH'})
    expect(model.doStreamCalls).toHaveLength(0)
  })

  it('passes a proposal action to open and returns its original ActionResult receipt', async () => {
    const original = {status: 'succeeded', requestId: 'proposal-request', resetEpoch: 1, proposalId: 'saved-proposal'}
    const rpc = mockRpc({open: () => ({terminal: true, events: [], reply: {httpStatus: 200, result: original}})})
    const response = await runtime(scriptedModel([]), rpc).handleRequest(new Request('http://node.local/api/copilotkit/proposal', {method: 'POST', headers: {'content-type': 'application/json', cookie: 'wellio_session=signed-cookie'}, body: JSON.stringify({kind: 'request_proposal', requestId: 'proposal-request', resetEpoch: 1, source: 'today'})}))
    expect(await response.json()).toEqual(original)
    expect(rpc.calls[0].payload.action.kind).toBe('request_proposal')
  })

  it('runs a fresh proposal through the official runner and validates the final receipt after re-reading context', async () => {
    const original = {status: 'succeeded', requestId: 'proposal-request', resetEpoch: 1, proposalId: 'saved-proposal'}
    const rpc = mockRpc({finish: () => ({events: [{type: 'done', ...envelope, messageId: 'assistant-id'}], reply: {httpStatus: 200, result: original}})})
    const model = scriptedModel([() => toolCall(), () => toolCall('propose_workout', {}, 'proposal-tool'), () => toolCall('get_day_context', {}, 'context-after-proposal'), () => output()])
    const response = await runtime(model, rpc).handleRequest(new Request('http://node.local/api/copilotkit/proposal', {method: 'POST', headers: {'content-type': 'application/json', cookie: 'wellio_session=signed-cookie'}, body: JSON.stringify({kind: 'request_proposal', requestId: 'proposal-request', resetEpoch: 1, source: 'today'})}))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(original)
    expect(model.doStreamCalls[2].toolChoice).toEqual({type: 'tool', toolName: 'get_day_context'})
    expect(rpc.calls.filter(call => call.name === 'tool').map(call => call.payload.name)).toEqual(['get_day_context', 'propose_workout', 'get_day_context'])
  })
})
