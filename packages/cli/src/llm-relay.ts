import type { RelayResponse } from '@pulls.review/core/local-rpc'
import type { RpcStreamingChannel } from 'devframe'
import type { StreamSink } from 'devframe/utils/streaming-channel'
import { LOCAL_RPC } from '@pulls.review/core/local-rpc'
import { defineRpcFunction } from 'devframe'
import * as v from 'valibot'

const header = v.tuple([v.string(), v.string()])

const RelayRequestSchema = v.object({
  url: v.pipe(v.string(), v.regex(/^https?:\/\//, 'Only http(s) URLs can be relayed')),
  method: v.string(),
  headers: v.array(header),
  body: v.optional(v.string()),
})

const RelayResponseSchema = v.object({
  status: v.number(),
  statusText: v.string(),
  headers: v.array(header),
  streamId: v.string(),
})

/** Node's `fetch` decodes the body, so the upstream encoding and length no longer describe what the browser gets. */
const DROPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection'])

async function pump(body: ReadableStream<Uint8Array> | null, sink: StreamSink<string>): Promise<void> {
  try {
    const decoder = new TextDecoder()
    for await (const bytes of body ?? []) {
      if (sink.closed)
        return
      sink.write(decoder.decode(bytes, { stream: true }))
    }
    if (sink.closed)
      return
    const rest = decoder.decode()
    if (rest)
      sink.write(rest)
    sink.close()
  }
  catch (error) {
    if (!sink.closed)
      sink.error(error)
  }
}

/**
 * Sends an LLM request from the server, for providers whose endpoints refuse browser
 * requests (no CORS) - OpenCode Go is one. The response head is returned and the body
 * streams over `channel`; a cancelled stream aborts the upstream request.
 */
export function llmFetchFunction(channel: Pick<RpcStreamingChannel<string>, 'start'>, fetchImpl: typeof fetch = fetch) {
  return defineRpcFunction({
    name: LOCAL_RPC.llmFetch,
    type: 'action',
    args: [RelayRequestSchema],
    returns: RelayResponseSchema,
    handler: async (request): Promise<RelayResponse> => {
      const { url, method, headers, body } = v.parse(RelayRequestSchema, request)
      const upstream = new AbortController()
      const response = await fetchImpl(url, { method, headers, body, signal: upstream.signal })
      const sink = channel.start()
      sink.signal.addEventListener('abort', () => upstream.abort(), { once: true })
      void pump(response.body, sink)
      return {
        status: response.status,
        statusText: response.statusText,
        headers: [...response.headers].filter(([name]) => !DROPPED_RESPONSE_HEADERS.has(name)),
        streamId: sink.id,
      }
    },
  })
}
