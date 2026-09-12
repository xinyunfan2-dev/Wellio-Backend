import {BuiltInAgent} from '@copilotkit/runtime/v2'
import type {BaseEvent, RunAgentInput} from '@ag-ui/client'
import {jsonSchema, Output, stepCountIs, streamText, tool, type ModelMessage, type ToolSet} from 'ai'
import {z} from 'zod'
import {BusinessRpc} from './rpc.js'
import {PROMPT_VERSION, SYSTEM_PROMPT, TOOL_DESCRIPTIONS} from './prompt.js'
import {RuntimeError, type FinishReply, type LegacyEvent, type OpenReply, type RuntimeOptions, type StoredReply, type ToolReply} from './contracts.js'

const answerSchema = z.object({markdown: z.string().min(1).max(12000), trainingSummary: z.string().min(1).max(2000), nutritionSummary: z.string().min(1).max(2000)}).strict()
const TOOL_NAMES = new Set(['get_day_context', 'get_gym_equipment', 'query_history', 'search_restaurant_menu', 'mutate_meal_log', 'undo_meal_change', 'propose_workout', 'record_workout_progress'])

function modelMessages(opened: OpenReply): ModelMessage[] {
  const messages = structuredClone(opened.messages ?? [])
  if (opened.attachments?.length) {
    const last = messages.at(-1)
    if (!last || last.role !== 'user') throw new RuntimeError('AGENT_SERVICE_INVALID_RESPONSE', 502)
    last.content = [
      {type: 'text', text: typeof last.content === 'string' ? last.content : opened.request!.message},
      ...opened.attachments.map(attachment => ({type: 'image' as const, image: Buffer.from(attachment.data, 'base64'), mediaType: attachment.mediaType})),
    ]
  }
  return messages
}

export interface ExecuteRun {
  opened: OpenReply; input: RunAgentInput; headers: Headers; signal: AbortSignal;
  onEvent: (event: BaseEvent) => void; onLegacy: (event: LegacyEvent) => void;
  onAgent?: (agent: BuiltInAgent) => void;
  dispatch?: (agent: BuiltInAgent) => Promise<void>;
}

/** One fresh official BuiltInAgent factory per request; PostgreSQL owns all history. */
export async function executeRun(options: RuntimeOptions, rpc: BusinessRpc, run: ExecuteRun): Promise<StoredReply | undefined> {
  if (!options.model) throw new RuntimeError('PROVIDER_NOT_CONFIGURED', 503)
  const {opened, headers} = run
  if (!opened.runId || !opened.request || !opened.messageId || !opened.tools) throw new RuntimeError('AGENT_SERVICE_INVALID_RESPONSE', 502)
  const backendRunId = opened.runId
  const maxSteps = options.maxSteps ?? 6
  let reply: StoredReply | undefined
  let finished = false
  let failureCode = 'MODEL_ERROR'
  let contextRequired = opened.contextRequired !== false
  let stepCount = 0
  const sendLegacy = (events: LegacyEvent[]) => {for (const event of events) run.onLegacy(event)}
  const signal = AbortSignal.any([run.signal, AbortSignal.timeout(options.timeoutMs ?? 20000)])
  const tools: ToolSet = Object.fromEntries(Object.entries(opened.tools).filter(([name]) => TOOL_NAMES.has(name)).map(([name, schema]) => [name, tool({
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: jsonSchema(schema),
    execute: async (input, {toolCallId}) => {
      const result = await rpc.call<ToolReply>('tool', {runId: backendRunId, toolCallId, name, input}, headers, signal)
      contextRequired = result.contextRequired
      sendLegacy(result.events)
      return result.result
    },
  })]))
  if (!tools.get_day_context || Object.keys(tools).length !== 8) throw new RuntimeError('AGENT_SERVICE_INVALID_RESPONSE', 502)
  const agent = new BuiltInAgent({
    type: 'aisdk',
    factory: ({abortSignal}) => ({
      fullStream: (async function* () {
        const modelSignal = AbortSignal.any([signal, abortSignal])
        try {
          const generated = streamText({
            model: options.model!, system: `${SYSTEM_PROMPT}\nPrompt version: ${PROMPT_VERSION}.\nCurrent capabilities: knowledge retrieval is not connected. Do not claim retrieved expert knowledge or invent citations. Only the eight registered tools are available.\nTrusted current-run context: ${opened.instructions ?? ''}`,
            messages: modelMessages(opened), tools, output: Output.object({schema: answerSchema}),
            stopWhen: stepCountIs(maxSteps), maxRetries: 0, abortSignal: modelSignal,
            prepareStep: async () => {
              const status = await rpc.call<{active: boolean; contextRequired: boolean}>('status', {runId: backendRunId}, headers, modelSignal)
              if (!status.active) throw new RuntimeError('RUN_NOT_ACTIVE', 409)
              contextRequired ||= status.contextRequired
              return contextRequired ? {activeTools: ['get_day_context'], toolChoice: {type: 'tool' as const, toolName: 'get_day_context'}} : {}
            },
            onStepFinish: () => {stepCount++}, onError: () => {},
          })
          // Consume the real SDK tool loop. Never forward raw model JSON, reasoning,
          // tool arguments, or unvalidated prose into the AG-UI converter.
          for await (const part of generated.fullStream) {
            if (part.type === 'error') throw new RuntimeError('MODEL_ERROR', 502)
            if (part.type === 'abort') throw new RuntimeError('RUN_STOPPED', 499)
          }
          modelSignal.throwIfAborted()
          const output = answerSchema.parse(await generated.output)
          if (contextRequired) throw new RuntimeError('CONTEXT_READ_REQUIRED', 409)
          const result = await rpc.call<FinishReply>('finish', {runId: backendRunId, output}, headers, modelSignal)
          finished = true
          reply = result.reply
          // Both views receive only the server-accepted answer. Domain snapshots
          // from tools were already durable and remain visible if generation fails.
          sendLegacy([{type: 'text', requestId: opened.request!.requestId, resetEpoch: opened.request!.resetEpoch, messageId: opened.messageId, delta: output.markdown}])
          yield {type: 'text-start', id: opened.messageId}
          yield {type: 'text-delta', id: opened.messageId, text: output.markdown}
          yield {type: 'text-end', id: opened.messageId}
          sendLegacy(result.events.filter(event => event.type !== 'text'))
          yield {type: 'finish', finishReason: 'stop'}
        } catch (error) {
          if (modelSignal.aborted) throw new RuntimeError(run.signal.aborted || abortSignal.aborted ? 'RUN_STOPPED' : 'TIMEOUT', 499)
          if (error instanceof RuntimeError) throw error
          throw new RuntimeError(stepCount >= maxSteps ? 'STEP_LIMIT_EXCEEDED' : 'INVALID_MODEL_OUTPUT', 502)
        }
      })(),
    }),
  })
  agent.threadId = run.input.threadId
  run.onAgent?.(agent)
  const abort = () => agent.abortRun()
  signal.addEventListener('abort', abort, {once: true})
  try {
    // Do not pass browser state/messages/tools/resume to the SDK. Python rebuilt
    // the model history; this lifecycle input carries public identity only.
    if (run.dispatch) await run.dispatch(agent)
    else await agent.runAgent({runId: run.input.runId, tools: [], context: [], forwardedProps: {}}, {onEvent: ({event}) => {run.onEvent(event)}})
    if (!finished) {
      if (signal.aborted) throw new RuntimeError(run.signal.aborted ? 'RUN_STOPPED' : 'TIMEOUT', 499)
      throw new RuntimeError('MODEL_ERROR', 502)
    }
    return reply
  } catch (error) {
    failureCode = error instanceof RuntimeError ? error.code : run.signal.aborted ? 'RUN_STOPPED' : signal.aborted ? 'TIMEOUT' : 'MODEL_ERROR'
    throw error instanceof RuntimeError ? error : new RuntimeError(failureCode, 502)
  } finally {
    signal.removeEventListener('abort', abort)
    if (!finished) {
      const code = ['MODEL_ERROR', 'INVALID_MODEL_OUTPUT', 'TIMEOUT', 'STEP_LIMIT_EXCEEDED', 'RUN_STOPPED'].includes(failureCode) ? failureCode : 'MODEL_ERROR'
      try {sendLegacy((await rpc.cancel(backendRunId, headers, code === 'RUN_STOPPED' ? 'stopped' : 'failed', code)).events)} catch {/* Preserve the original failure; the durable lease is the recovery fallback. */}
    }
  }
}
