import type { RelayResponse } from '@pulls.review/core/local-rpc'
import type { RpcStreamingChannel } from 'devframe'
import type { StreamSink } from 'devframe/utils/streaming-channel'
import { createStreamSink } from 'devframe/utils/streaming-channel'
import { describe, expect, it, vi } from 'vitest'
import { llmFetchFunction } from './llm-relay'

/** A channel whose streams the test can read back. */
function fakeChannel() {
  const sinks = new Map<string, StreamSink<string>>()
  const chunks = new Map<string, string[]>()
  const channel: Pick<RpcStreamingChannel<string>, 'start'> = {
    start: () => {
      const sink = createStreamSink<string>()
      const written: string[] = []
      sink.events.on('chunk', (_seq, chunk) => written.push(chunk))
      sinks.set(sink.id, sink)
      chunks.set(sink.id, written)
      return sink
    },
  }
  const ended = (id: string) => new Promise<string>(resolve => sinks.get(id)!.events.on('end', () => resolve(chunks.get(id)!.join(''))))
  return { channel, sinks, ended }
}

function relay(channel: Pick<RpcStreamingChannel<string>, 'start'>, fetchImpl: typeof fetch) {
  const fn = llmFetchFunction(channel, fetchImpl)
  return fn.handler as (request: unknown) => Promise<RelayResponse>
}

describe('llmFetchFunction', () => {
  it('sends the request from the server and streams the body back', async () => {
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('data: one\n\ndata: two\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'content-encoding': 'gzip', 'content-length': '24' },
    }))
    const { channel, ended } = fakeChannel()

    const head = await relay(channel, upstream)({
      url: 'https://opencode.ai/zen/go/v1/chat/completions',
      method: 'POST',
      headers: [['authorization', 'Bearer key'], ['x-opencode-session', 's1']],
      body: '{"model":"glm-5.1"}',
    })

    const [url, init] = upstream.mock.calls[0]
    expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions')
    expect(init?.method).toBe('POST')
    expect(new Headers(init?.headers).get('x-opencode-session')).toBe('s1')
    expect(init?.body).toBe('{"model":"glm-5.1"}')
    // Node's fetch already decoded the body, so its encoding and length no longer apply.
    expect(head).toMatchObject({ status: 200, headers: [['content-type', 'text/event-stream']] })
    expect(await ended(head.streamId)).toBe('data: one\n\ndata: two\n\n')
  })

  it('passes error statuses through for the SDK to report', async () => {
    const { channel, ended } = fakeChannel()
    const head = await relay(channel, async () => new Response('{"error":"MissingSessionID"}', { status: 400, statusText: 'Bad Request' }))({ url: 'https://example.test/v1/chat/completions', method: 'POST', headers: [] })
    expect(head).toMatchObject({ status: 400, statusText: 'Bad Request' })
    expect(await ended(head.streamId)).toBe('{"error":"MissingSessionID"}')
  })

  it('aborts the upstream request when the browser cancels the stream', async () => {
    let signal: AbortSignal | undefined
    const { channel, sinks } = fakeChannel()
    const head = await relay(channel, async (_input, init) => {
      signal = init?.signal ?? undefined
      return new Response(new ReadableStream({ start: () => {} }))
    })({ url: 'https://example.test/v1/chat/completions', method: 'POST', headers: [] })

    sinks.get(head.streamId)!.abort()
    expect(signal?.aborted).toBe(true)
  })

  it('refuses anything but http(s)', async () => {
    const { channel } = fakeChannel()
    await expect(relay(channel, fetch)({ url: 'file:///etc/passwd', method: 'GET', headers: [] })).rejects.toThrow(/http/)
  })
})
