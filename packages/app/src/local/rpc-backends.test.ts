import type { RelayRequest, RelayResponse } from '@pulls.review/core/local-rpc'
import type { RelayRpc } from './rpc-backends'
import { LOCAL_RPC, LOCAL_STREAMS } from '@pulls.review/core/local-rpc'
import { createStreamReader } from 'devframe/utils/streaming-channel'
import { describe, expect, it, vi } from 'vitest'
import { createRpcFetch } from './rpc-backends'

/** An RPC whose `llmFetch` answers with `head` and streams `chunks`. */
function fakeRpc(head: Omit<RelayResponse, 'streamId'>, chunks: string[]) {
  const reader = createStreamReader<string>({ id: 'stream-1' })
  const sent: RelayRequest[] = []
  const call = vi.fn(async (name: string, request: RelayRequest): Promise<RelayResponse> => {
    expect(name).toBe(LOCAL_RPC.llmFetch)
    sent.push(request)
    return { ...head, streamId: 'stream-1' }
  })
  const subscribe = vi.fn((channel: string, id: string) => {
    expect([channel, id]).toEqual([LOCAL_STREAMS.llmBody, 'stream-1'])
    chunks.forEach((chunk, index) => reader._push(index + 1, chunk))
    reader._end()
    return reader
  })
  const rpc: RelayRpc = { call, streaming: { subscribe } }
  return { rpc, sent, reader }
}

describe('createRpcFetch', () => {
  it('relays the request through the server and streams the response body', async () => {
    const { rpc, sent } = fakeRpc({ status: 200, statusText: 'OK', headers: [['content-type', 'text/event-stream']] }, ['data: one\n\n', 'data: two\n\n'])

    const response = await createRpcFetch(rpc)('https://opencode.ai/zen/go/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer key', 'x-opencode-session': 's1' },
      body: '{"model":"glm-5.1"}',
    })

    expect(sent).toMatchObject([{ url: 'https://opencode.ai/zen/go/v1/chat/completions', method: 'POST', body: '{"model":"glm-5.1"}' }])
    const headers = new Headers(sent[0]!.headers)
    expect([headers.get('authorization'), headers.get('x-opencode-session')]).toEqual(['Bearer key', 's1'])
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/event-stream')
    expect(await response.text()).toBe('data: one\n\ndata: two\n\n')
  })

  it('passes error statuses through', async () => {
    const { rpc } = fakeRpc({ status: 400, statusText: 'Bad Request', headers: [] }, ['{"error":"x"}'])
    const response = await createRpcFetch(rpc)(new URL('https://example.test/v1/models'))
    expect([response.status, response.statusText, await response.text()]).toEqual([400, 'Bad Request', '{"error":"x"}'])
  })

  it('cancels the server stream when the caller aborts', async () => {
    const { rpc, reader } = fakeRpc({ status: 200, statusText: 'OK', headers: [] }, [])
    const controller = new AbortController()
    await createRpcFetch(rpc)('https://example.test/v1/chat/completions', { method: 'POST', body: '{}', signal: controller.signal })
    const cancel = vi.spyOn(reader, 'cancel')
    controller.abort()
    expect(cancel).toHaveBeenCalled()
  })
})
