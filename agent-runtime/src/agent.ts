import {BuiltInAgent} from '@copilotkit/runtime/v2'
import type {BaseEvent, RunAgentInput} from '@ag-ui/client'
import {Output, jsonSchema, stepCountIs, streamText, tool, type ModelMessage, type ToolSet} from 'ai'
import {z} from 'zod'
import {BusinessRpc} from './rpc.js'
import {PROMPT_VERSION, SYSTEM_PROMPT, TOOL_DESCRIPTIONS} from './prompt.js'
import {RuntimeError, type FinishReply, type LegacyEvent, type OpenReply, type RuntimeOptions, type StoredReply, type ToolReply} from './contracts.js'

const answerSchema = z.object({markdown: z.string().min(1).max(12000).refine(value => !/^[\s.…)\]_-]*$/.test(value), 'A substantive answer is required').describe('The complete standalone answer to the user: include every requested fact, image reading, source link and operation outcome here. The summary fields are separate Today cards and are NOT displayed in the chat. Never return only an introduction, a future promise, or a placeholder.'), trainingSummary: z.string().trim().min(1).max(2000).nullable(), nutritionSummary: z.string().trim().min(1).max(2000).nullable()}).strict()
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
  const intent = opened.preparedIntent
  const requiredTool = intent?.kind === 'meal' && ['meal_update', 'meal_delete'].includes(intent.constraint?.scope ?? '') ? 'mutate_meal_log' : intent?.kind === 'undo' ? 'undo_meal_change' : intent?.kind === 'progress' ? 'record_workout_progress' : undefined
  const simpleChat = opened.preparedIntent?.kind === 'read_only' && !opened.attachments?.length && /^(?:你好|您好|嗨|早上好|晚上好|谢谢|多谢|hi|hello|hey|thanks|thank you)[\s!！.。]*$/i.test(opened.request.message.trim())
  let requiredToolAttempted = false
  let stepCount = 0
  let contextSequence = 0
  let contextMessages: ModelMessage[] = []
  const sendLegacy = (events: LegacyEvent[]) => {for (const event of events) run.onLegacy(event)}
  // Leave time to persist a terminal receipt before the FastAPI lease expires.
  const leaseBudget = opened.leaseExpiresAt === undefined ? Infinity : Math.max(1, opened.leaseExpiresAt - Date.now() - 1000)
  const signal = AbortSignal.any([run.signal, AbortSignal.timeout(Math.min(options.timeoutMs ?? 115000, leaseBudget))])
  const tools: ToolSet = Object.fromEntries(Object.entries(opened.tools).filter(([name]) => TOOL_NAMES.has(name)).map(([name, schema]) => [name, tool({
    description: TOOL_DESCRIPTIONS[name],
    inputSchema: jsonSchema(schema),
    execute: async (input, {toolCallId}) => {
      const result = await rpc.call<ToolReply>('tool', {runId: backendRunId, toolCallId, name, input}, headers, signal)
      contextRequired = result.contextRequired
      if (name === 'get_day_context') contextMessages = []
      if (name === requiredTool) requiredToolAttempted = true
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
            model: options.model!, system: simpleChat ? 'You are Wellio, a friendly fitness companion. Briefly acknowledge this greeting or thanks in the language the user used. Do not give unsolicited advice or discuss personal records. Return JSON with exactly markdown (your short reply), trainingSummary: null, nutritionSummary: null.' : `${SYSTEM_PROMPT}\nPrompt version: ${PROMPT_VERSION}.\nCurrent capabilities: knowledge retrieval is not connected. Do not claim retrieved expert knowledge or invent citations. Only the eight registered tools are available.\nFinal response contract: after completing the requested tool work, return ONLY valid JSON with exactly these keys: {"markdown":"Your complete reply","trainingSummary":null,"nutritionSummary":null}. markdown must be a non-empty string. Each summary must be either a non-empty string when updating that Today card or JSON null to preserve it. For greetings and unrelated chat use null for both summaries. Never use an object, array, empty string, or extra keys. markdown is the COMPLETE standalone chat answer, including all requested facts, image readings, source links and actual outcomes. trainingSummary and nutritionSummary are short factual Today cards; they are NOT displayed in the chat. Use actual content, not placeholders. Do not promise future tool work and stop; execute the necessary tool now.\nThe runtime already calls get_day_context before your first step and after changes; its latest result is attached to your messages. Do not repeat that read unless necessary.\nTrusted current-run context: ${opened.instructions ?? ''}`,
            messages: simpleChat ? [{role: 'user', content: opened.request!.message}] : modelMessages(opened), tools,
            ...(simpleChat ? {output: Output.object({schema: answerSchema}), maxOutputTokens: 256} : {}),
            stopWhen: stepCountIs(maxSteps), maxRetries: 0, abortSignal: modelSignal,
            prepareStep: async ({messages}) => {
              const status = await rpc.call<{active: boolean; contextRequired: boolean}>('status', {runId: backendRunId}, headers, modelSignal)
              if (!status.active) throw new RuntimeError('RUN_NOT_ACTIVE', 409)
              contextRequired ||= status.contextRequired
              // Context is mandatory, so execute the authenticated read directly.
              // Spending a model round trip just to ask for this read adds no value.
              if (contextRequired) {
                const toolCallId = `runtime-context-${contextSequence++}`
                const result = await rpc.call<ToolReply>('tool', {runId: backendRunId, toolCallId, name: 'get_day_context', input: {}}, headers, modelSignal)
                contextRequired = result.contextRequired
                sendLegacy(result.events)
                if (contextRequired) throw new RuntimeError('CONTEXT_READ_REQUIRED', 409)
                contextMessages = [
                  {role: 'assistant', content: [{type: 'tool-call', toolCallId, toolName: 'get_day_context', input: {}}]},
                  {role: 'tool', content: [{type: 'tool-result', toolCallId, toolName: 'get_day_context', output: {type: 'json', value: result.result as any}}]},
                ]
              }
              return {messages: simpleChat ? messages : [...messages, ...contextMessages],
                ...(simpleChat ? {activeTools: [], toolChoice: 'none' as const} : {}),
                ...(requiredTool && !requiredToolAttempted ? {activeTools: [requiredTool], toolChoice: {type: 'tool' as const, toolName: requiredTool}} : {})}
            },
            onStepFinish: ({usage, finishReason}) => {
              stepCount++
              console.info('[wellio:model-step]', JSON.stringify({step: stepCount, finishReason, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, reasoningTokens: usage.reasoningTokens}))
            },
            onError: ({error}) => {
              const detail = error as {name?: string; statusCode?: number; cause?: {code?: string}; stack?: string}
              console.warn('[wellio:model-error]', JSON.stringify({name: detail?.name, statusCode: detail?.statusCode, causeCode: detail?.cause?.code, frames: detail?.stack?.split('\n').slice(1, 4).filter(line => line.includes('/node_modules/'))}))
            },
          })
          // Consume the real SDK tool loop. Never forward raw model JSON, reasoning,
          // tool arguments, or unvalidated prose into the AG-UI converter.
          for await (const part of generated.fullStream) {
            if (part.type === 'error') throw new RuntimeError('MODEL_ERROR', 502)
            if (part.type === 'abort') throw new RuntimeError('RUN_STOPPED', 499)
          }
          modelSignal.throwIfAborted()
          const finalText = (await generated.text).trim()
          const jsonText = /^```(?:json)?\s*\n([\s\S]*?)\n?```$/i.exec(finalText)?.[1]?.trim() ?? finalText
          const output = answerSchema.parse(JSON.parse(jsonText))
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
  let rejectAborted!: (error: RuntimeError) => void
  const aborted = new Promise<never>((_, reject) => {rejectAborted = reject})
  const abort = () => {
    agent.abortRun()
    rejectAborted(new RuntimeError(run.signal.aborted ? 'RUN_STOPPED' : 'TIMEOUT', 499))
  }
  signal.addEventListener('abort', abort, {once: true})
  if (signal.aborted) abort()
  try {
    // Do not pass browser state/messages/tools/resume to the SDK. Python rebuilt
    // the model history; this lifecycle input carries public identity only.
    const dispatched = run.dispatch ? run.dispatch(agent) : agent.runAgent({runId: run.input.runId, tools: [], context: [], forwardedProps: {}}, {onEvent: ({event}) => {run.onEvent(event)}})
    // Some provider streams do not settle promptly after abort. Finish the HTTP
    // lifecycle independently; the aborted signal and lease reject late writes.
    await Promise.race([dispatched, aborted])
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
