import {RuntimeError, type FinishReply, type JsonObject} from './contracts.js'

const METHODS = new Set(['open', 'tool', 'finish', 'cancel', 'status'])
export class BusinessRpc {
  private readonly endpoint: URL
  constructor(backendUrl: string, private readonly token: string, private readonly transport: typeof fetch = fetch) {
    this.endpoint = new URL(backendUrl)
    if (!['http:', 'https:'].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash) throw new Error('INVALID_BACKEND_URL')
  }
  async call<T>(method: string, payload: JsonObject, headers: Headers, signal?: AbortSignal): Promise<T> {
    if (!METHODS.has(method)) throw new RuntimeError('INTERNAL_RPC_METHOD_INVALID')
    if (!this.token) throw new RuntimeError('AGENT_SERVICE_NOT_CONFIGURED', 503)
    const forwarded = new Headers({'content-type': 'application/json', authorization: `Bearer ${this.token}`})
    for (const name of ['cookie', 'origin', 'referer', 'sec-fetch-site']) {
      const value = headers.get(name)
      if (value !== null) forwarded.set(name, value)
    }
    let response: Response
    try {
      response = await this.transport(new URL(`/internal/agent/${method}`, this.endpoint), {method: 'POST', headers: forwarded, body: JSON.stringify(payload), signal})
    } catch (error) {
      if (signal?.aborted) throw error
      throw new RuntimeError('AGENT_SERVICE_UNAVAILABLE', 502)
    }
    let body: JsonObject
    try {body = await response.json() as JsonObject} catch {throw new RuntimeError('AGENT_SERVICE_INVALID_RESPONSE', 502)}
    if (!response.ok) {
      const code = typeof body.errorCode === 'string' && /^[A-Z][A-Z0-9_]{1,80}$/.test(body.errorCode) ? body.errorCode : 'AGENT_SERVICE_ERROR'
      throw new RuntimeError(code, response.status)
    }
    return body as T
  }
  async cancel(runId: string, headers: Headers, status: 'failed' | 'stopped' = 'stopped', errorCode = 'RUN_STOPPED'): Promise<FinishReply> {
    // The original request may already be aborted; finalization gets its own bound.
    return this.call('cancel', {runId, status, errorCode}, headers, AbortSignal.timeout(3000))
  }
}
