import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigResilience } from "@opencode-ai/core/config/resilience"
import { testEffect } from "./lib/effect"

const it = testEffect(Layer.empty)

const decodeInfo = (input: unknown) => Schema.decodeUnknownSync(Config.Info)(input, { errors: "all" })

describe("Config resilience", () => {
  it.effect("decodes absent resilience config to safe defaults", () =>
    Effect.sync(() => {
      expect(decodeInfo({}).resilience).toEqual(ConfigResilience.DEFAULTS)
    }),
  )

  it.effect("rejects negative retry and delay controls", () =>
    Effect.sync(() => {
      expect(() => decodeInfo({ resilience: { retries: -1 } })).toThrow()
      expect(() => decodeInfo({ resilience: { retryDelayMs: -1 } })).toThrow()
    }),
  )

  it.effect("rejects negative timeout controls while zero stays the disabled value", () =>
    Effect.sync(() => {
      expect(() => decodeInfo({ resilience: { responseTimeoutMs: -1 } })).toThrow()
      expect(() => decodeInfo({ resilience: { toolTimeoutMs: -1 } })).toThrow()
      expect(decodeInfo({ resilience: { responseTimeoutMs: 0, toolTimeoutMs: 0 } }).resilience).toMatchObject({
        responseTimeoutMs: 0,
        toolTimeoutMs: 0,
      })
    }),
  )

  it.effect("preserves fallback model IDs exactly", () =>
    Effect.sync(() => {
      expect(
        decodeInfo({
          resilience: {
            fallbackModels: ["openrouter/deepseek/deepseek-chat", "minimax/MiniMax-M3:512k", "oc/big-pickle"],
          },
        }).resilience?.fallbackModels,
      ).toEqual(["openrouter/deepseek/deepseek-chat", "minimax/MiniMax-M3:512k", "oc/big-pickle"])
    }),
  )
})
