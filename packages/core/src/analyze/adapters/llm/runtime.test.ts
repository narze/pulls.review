import type { ResolvedModel } from './model'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveModel } from './model'
import { createCorsSafeFetch, createStreamFn } from './runtime'
import { defaultLlmSettings } from './settings'

function sentHeaders(provider: string, headers: Record<string, string>): Headers {
  const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}'))
  vi.stubGlobal('fetch', spy)
  void createCorsSafeFetch(provider)('https://example.test/v1/messages', { method: 'POST', headers })
  return new Headers(spy.mock.calls[0][1]?.headers)
}

const HEADERS = {
  'x-api-key': 'key',
  'anthropic-version': '2023-06-01',
  'x-stainless-os': 'MacOS',
  'x-stainless-retry-count': '0',
  'anthropic-dangerous-direct-browser-access': 'true',
}

describe('createCorsSafeFetch', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('strips telemetry and the browser-access opt-in for the Vercel AI Gateway', () => {
    const headers = sentHeaders('vercel-ai-gateway', HEADERS)
    expect([...headers.keys()].sort()).toEqual(['anthropic-version', 'x-api-key'])
  })

  it('keeps the browser-access opt-in for direct Anthropic calls', () => {
    const headers = sentHeaders('anthropic', HEADERS)
    expect(headers.get('anthropic-dangerous-direct-browser-access')).toBe('true')
    expect(headers.has('x-stainless-os')).toBe(false)
    expect(headers.get('x-api-key')).toBe('key')
  })
})

/** Runs one request through `createStreamFn` and returns what reached `fetch`. */
async function sentRequest(resolved: ResolvedModel): Promise<{ url: string, headers: Headers }> {
  const spy = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { status: 500 }))
  const stream = createStreamFn({ ...resolved, fetch: spy })(resolved.model, { messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }, { apiKey: resolved.apiKey, sessionId: 'github:o/r#1', maxRetries: 0 })
  for await (const _event of stream) {
    // Drain until the (failed) response ends the stream.
  }
  return { url: String(spy.mock.calls[0][0]), headers: new Headers(spy.mock.calls[0][1]?.headers) }
}

function openaiCompatible(openaiBaseUrl: string): ResolvedModel {
  return resolveModel({ ...defaultLlmSettings, provider: 'openai-compatible', openaiApiKey: 'key', openaiBaseUrl, openaiModel: 'glm-5.1' })!
}

describe('createStreamFn', () => {
  it('sends requests through the resolved model\'s fetch', async () => {
    const { url } = await sentRequest(openaiCompatible('https://api.example.test/v1'))
    expect(url).toBe('https://api.example.test/v1/chat/completions')
  })

  it('sends the session id OpenCode requires to route a request', async () => {
    const { headers } = await sentRequest(openaiCompatible('https://opencode.ai/zen/go/v1'))
    expect(headers.get('x-opencode-session')).toBe('github:o/r#1')
  })

  it('keeps other OpenAI-compatible endpoints free of OpenCode\'s header', async () => {
    const { headers } = await sentRequest(openaiCompatible('https://api.example.test/v1'))
    expect(headers.has('x-opencode-session')).toBe(false)
  })
})
