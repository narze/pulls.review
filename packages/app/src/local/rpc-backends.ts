import type { Credentials, DiffSource } from '@pulls.review/core/types'
import type { StreamReader } from 'devframe/utils/streaming-channel'
import type { Driver } from 'unstorage'
import type { LocalRpc } from './connection'
import { LOCAL_RPC, LOCAL_STREAMS } from '@pulls.review/core/local-rpc'
import { DiffsPayloadSchema } from '@pulls.review/core/types'
import * as v from 'valibot'

/** The server's cache directory as an unstorage driver: the browser's `CacheRepositories` run on it unchanged. */
export function createRpcDriver(rpc: LocalRpc): Driver {
  return {
    name: 'pulls-review-rpc',
    hasItem: async key => v.parse(v.nullable(v.string()), await rpc.call(LOCAL_RPC.storageGetItem, { key })) !== null,
    getItem: async key => v.parse(v.nullable(v.string()), await rpc.call(LOCAL_RPC.storageGetItem, { key })),
    setItem: async (key, value) => {
      await rpc.call(LOCAL_RPC.storageSetItem, { key, value })
    },
    removeItem: async (key) => {
      await rpc.call(LOCAL_RPC.storageRemoveItem, { key })
    },
    getKeys: async base => v.parse(v.array(v.string()), await rpc.call(LOCAL_RPC.storageGetKeys, { base })),
  }
}

/** The GitHub token the server found (environment or `gh`), read once per page load. */
export function createRpcCredentials(rpc: LocalRpc, fallback: Credentials): Credentials {
  let token: Promise<string | undefined> | undefined
  return {
    async githubToken() {
      token ??= rpc.call(LOCAL_RPC.githubToken).then(value => v.parse(v.optional(v.string()), value ?? undefined))
      return await token ?? fallback.githubToken()
    },
  }
}

/** A local diff, run by the server's `git`. Its target may still be resolving (a branch's base). */
export function createRpcSource(rpc: LocalRpc, pending: Promise<string>): DiffSource {
  return {
    key: async () => v.parse(v.string(), await rpc.call(LOCAL_RPC.sourceKey, { target: await pending })),
    fetch: async () => v.parse(DiffsPayloadSchema, await rpc.call(LOCAL_RPC.sourceFetch, { target: await pending })),
    fingerprint: async () => v.parse(v.string(), await rpc.call(LOCAL_RPC.sourceFingerprint, { target: await pending })),
    loadFile: async (path, sha) => v.parse(v.optional(v.string()), await rpc.call(LOCAL_RPC.sourceLoadFile, { target: await pending, path, sha }) ?? undefined),
  }
}

const RelayResponseSchema = v.object({
  status: v.number(),
  statusText: v.string(),
  headers: v.array(v.tuple([v.string(), v.string()])),
  streamId: v.string(),
})

/** The part of `LocalRpc` the relaying `fetch` uses. */
export interface RelayRpc {
  call: (method: string, ...args: any[]) => Promise<unknown>
  streaming: { subscribe: (channel: string, id: string, options?: { highWaterMark?: number }) => StreamReader<string> }
}

/** The response statuses `Response` refuses a body for. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304])

/**
 * A `fetch` the server runs: LLM endpoints that refuse browser requests (no CORS, like
 * OpenCode Go) still answer it. The body streams back as it arrives, so SSE stays live.
 */
export function createRpcFetch(rpc: RelayRpc): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined
    const url = request?.url ?? String(input)
    const body = init?.body ?? (request?.body ? await request.text() : undefined)
    if (body !== undefined && body !== null && typeof body !== 'string')
      throw new TypeError('Only text request bodies can be relayed')
    const signal = init?.signal ?? request?.signal
    signal?.throwIfAborted()

    const head = v.parse(RelayResponseSchema, await rpc.call(LOCAL_RPC.llmFetch, {
      url,
      method: init?.method ?? request?.method ?? 'GET',
      headers: [...new Headers(init?.headers ?? request?.headers)],
      body: body ?? undefined,
    }))
    const reader = rpc.streaming.subscribe(LOCAL_STREAMS.llmBody, head.streamId, { highWaterMark: 100_000 })
    signal?.addEventListener('abort', () => reader.cancel(), { once: true })

    const encoder = new TextEncoder()
    const stream = reader.readable.pipeThrough(new TransformStream<string, Uint8Array>({
      transform: (chunk, controller) => controller.enqueue(encoder.encode(chunk)),
    }))
    return new Response(NULL_BODY_STATUSES.has(head.status) ? null : stream, { status: head.status, statusText: head.statusText, headers: head.headers })
  }
}
