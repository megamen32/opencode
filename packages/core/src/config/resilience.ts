export * as ConfigResilience from "./resilience"

import { Effect, Schema } from "effect"
import { ModelV2 } from "../model"
import { NonNegativeInt } from "../schema"

export class RuntimeMetadata extends Schema.Class<RuntimeMetadata>("ConfigV2.Resilience.RuntimeMetadata")({
  attempt: NonNegativeInt,
  selectedModel: Schema.String,
  actualModel: Schema.String,
  fallbackUsed: Schema.Boolean,
}) {}

export type RuntimeMetadataInput = ConstructorParameters<typeof RuntimeMetadata>[0]

export class Info extends Schema.Class<Info>("ConfigV2.Resilience")({
  responseTimeoutMs: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))).annotate({
    description: "Provider response timeout in milliseconds. Set to 0 to disable.",
  }),
  toolTimeoutMs: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))).annotate({
    description: "Local session tool execution timeout in milliseconds. Set to 0 to disable.",
  }),
  retries: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))).annotate({
    description: "Additional retry attempts for retryable provider failures before moving to a fallback model.",
  }),
  retryDelayMs: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))).annotate({
    description: "Delay in milliseconds between provider attempts.",
  }),
  autoResume: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))).annotate({
    description: "Allow future runtime recovery flows to resume eligible interrupted sessions automatically.",
  }),
  fallbackModels: Schema.Array(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed([]))).annotate({
    description: "Ordered fallback model IDs, preserving provider/model strings exactly as configured.",
  }),
}) {}

export const DEFAULTS = new Info({
  responseTimeoutMs: 0,
  toolTimeoutMs: 0,
  retries: 0,
  retryDelayMs: 0,
  autoResume: false,
  fallbackModels: [],
})

export const fromEntries = (entries: readonly { readonly type: string; readonly info?: { readonly resilience?: Info } }[]) =>
  entries
    .filter((entry): entry is { readonly type: "document"; readonly info: { readonly resilience?: Info } } =>
      entry.type === "document",
    )
    .findLast((entry) => entry.info.resilience !== undefined)?.info.resilience ?? DEFAULTS

export const isEnabledTimeout = (value: number) => value > 0

export const modelRef = (input: string) => {
  const parsed = ModelV2.parse(input)
  return {
    id: parsed.modelID,
    providerID: parsed.providerID,
  }
}

export const runtimeMetadata = (input: RuntimeMetadataInput) => new RuntimeMetadata(input)
