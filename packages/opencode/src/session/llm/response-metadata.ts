import type { ProviderMetadata } from "@opencode-ai/llm"

const TTL_MS = 10 * 60 * 1000
const MAX_ENTRIES = 256

export type OmniRouteResponseMetadata = {
  responseModel?: string
  responseProvider?: string
  responseModelId?: string
}

type Entry = {
  expires: number
  metadata: OmniRouteResponseMetadata
}

const entries = new Map<string, Entry>()

function cleanup(now = Date.now()) {
  for (const [key, value] of entries) {
    if (value.expires <= now) entries.delete(key)
  }
  while (entries.size > MAX_ENTRIES) {
    const oldest = entries.keys().next().value
    if (!oldest) break
    entries.delete(oldest)
  }
}

function headerValue(headers: Headers | HeadersInit | undefined, names: readonly string[]): string | undefined {
  if (!headers) return undefined
  const source = headers instanceof Headers ? headers : new Headers(headers)
  for (const name of names) {
    const value = source.get(name)
    if (value?.trim()) return value.trim()
  }
  return undefined
}

export function responseMetadataKey(headers: HeadersInit | undefined): string | undefined {
  return headerValue(headers, [
    "x-opencode-request",
    "x-opencode-session",
    "x-session-affinity",
    "x-session-id",
  ])
}

export function captureOmniRouteResponseMetadata(requestHeaders: HeadersInit | undefined, responseHeaders: Headers) {
  const key = responseMetadataKey(requestHeaders)
  if (!key) return

  const metadata: OmniRouteResponseMetadata = {
    responseModel: headerValue(responseHeaders, ["x-omniroute-response-model"]),
    responseProvider: headerValue(responseHeaders, ["x-omniroute-response-provider", "x-omniroute-provider"]),
    responseModelId: headerValue(responseHeaders, ["x-omniroute-response-model-id", "x-omniroute-model"]),
  }

  if (!metadata.responseModel && !metadata.responseProvider && !metadata.responseModelId) return

  cleanup()
  entries.set(key, { expires: Date.now() + TTL_MS, metadata })
}

export function getOmniRouteResponseMetadata(key: string | undefined): OmniRouteResponseMetadata | undefined {
  if (!key) return undefined
  cleanup()
  return entries.get(key)?.metadata
}

export function withOmniRouteResponseMetadata(
  metadata: ProviderMetadata | undefined,
  key: string | undefined,
): ProviderMetadata | undefined {
  const omniroute = getOmniRouteResponseMetadata(key)
  if (!omniroute) return metadata
  return {
    ...metadata,
    omniroute: {
      ...metadata?.omniroute,
      ...omniroute,
    },
  }
}
