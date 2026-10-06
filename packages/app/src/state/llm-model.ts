import type { ResolvedModel } from '@pulls.review/core/analyze'
import { resolveModel } from '@pulls.review/core/analyze'
import { settings } from './settings'

/** How LLM requests leave this app: the browser's `fetch` on the site, the server's in a `PR_LOCAL` build. */
let llmFetch: typeof fetch | undefined

export function setLlmFetch(value: typeof fetch | undefined): void {
  llmFetch = value
}

/** Settings' model, sent through this app's LLM transport. */
export function resolveLlmModel(): ResolvedModel | undefined {
  const resolved = resolveModel(settings.value.llm)
  return resolved && llmFetch ? { ...resolved, fetch: llmFetch } : resolved
}
