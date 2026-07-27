# Task 1 Report: OpenCode resilience configuration and runtime contract

## Source requirements

- Source brief: `/home/roomhacker/agents-projects/apps/forks/openchamber/.superpowers/sdd/task-1-brief.md`
- Work root: `/home/roomhacker/agents-projects/apps/forks/opencode`
- Scope constraint honored: no OpenChamber or OmniRoute files were edited.
- Server bridge status: no server endpoint or bridge route was added. The implementation is limited to proven OpenCode v2 config/runtime paths.

## Implementation summary

Added an OpenCode v2 resilience contract:

- `packages/core/src/config/resilience.ts`
  - Defines `ConfigResilience.Info`.
  - Defines conservative safe defaults:
    - `responseTimeoutMs: 0`
    - `toolTimeoutMs: 0`
    - `retries: 0`
    - `retryDelayMs: 0`
    - `autoResume: false`
    - `fallbackModels: []`
  - Uses `0` as the disabled timeout value; positive values enable response/tool ceilings.
  - Preserves fallback model strings exactly at config decode time.
  - Defines `RuntimeMetadata` with `attempt`, `selectedModel`, `actualModel`, and `fallbackUsed`.

- `packages/core/src/config.ts`
  - Wires `resilience` into `Config.Info`.
  - Uses the repository-local `optional(...)` schema helper with a decode default to preserve existing constructor compatibility while still decoding absent config to defaults.
  - Preserves existing `mcp.timeout.startup` and `mcp.timeout.request` config fields.

- `packages/core/src/aisdk.ts`
  - Reads `Config.Service` opportunistically when available.
  - Applies configured positive `responseTimeoutMs` to AI SDK provider option preparation.
  - Does not require Config for existing AISDK consumers.

- `packages/core/src/session/runner/llm.ts`
  - Applies `responseTimeoutMs` at the provider stream/run boundary.
  - Retries only uncommitted retryable provider failures.
  - Sleeps exactly `retryDelayMs` between retry/fallback attempts.
  - Tries configured fallback models in order after the configured retry bound for a model is exhausted.
  - Does not retry after assistant output/tool call state has been committed.
  - Applies `toolTimeoutMs` to local session tool settlement only; MCP startup/request timeout fields are not reused or replaced.

- `packages/core/src/session/runner/publish-llm-event.ts`
  - Carries resilience runtime metadata into step started/failed publications.

- `packages/schema/src/session-event.ts`
  - Adds optional resilience runtime metadata to Step Started, Step Ended, and Step Failed event schemas.

## Tests added

- `packages/core/test/resilience-config.test.ts`
  - Absent config decodes to safe defaults.
  - Negative retry/delay controls fail.
  - Negative timeout controls fail while `0` remains the disabled value.
  - Fallback model IDs preserve exact strings, including `minimax/MiniMax-M3:512k`.

- `packages/core/test/session-resilience.test.ts`
  - Bounded retries with exact configured delay.
  - Fallback order after retryable failures.
  - Response timeout classification and MCP timeout preservation.
  - No retry after committed/uncertain assistant output.
  - Local tool settlement timeout.
  - No retry for non-retryable provider failures.

## RED evidence

- `bun test packages/core/test/resilience-config.test.ts` from repo root failed before implementation because this checkout has the root test guard:
  - `Failed to scan non-existent root directory for tests: ".../opencode/do-not-run-tests-from-root"`
- Equivalent package-local RED command:
  - Command: `bun test test/resilience-config.test.ts`
  - Workdir: `/home/roomhacker/agents-projects/apps/forks/opencode/packages/core`
  - Result before implementation: failed because `@opencode-ai/core/config/resilience` did not exist.
- Runtime RED command:
  - Command: `bun test test/session-resilience.test.ts`
  - Workdir: `/home/roomhacker/agents-projects/apps/forks/opencode/packages/core`
  - Result before implementation: failed because `@opencode-ai/core/config/resilience` did not exist.

## GREEN evidence

- Focused tests:
  - Command: `bun test test/resilience-config.test.ts test/session-resilience.test.ts`
  - Workdir: `/home/roomhacker/agents-projects/apps/forks/opencode/packages/core`
  - Result: `10 pass, 0 fail, 26 expect() calls`

- Brief type-check command:
  - Command: `bun run --cwd packages/core type-check`
  - Workdir: `/home/roomhacker/agents-projects/apps/forks/opencode`
  - Result: failed because this checkout has no `type-check` script.

- Actual package type-check script:
  - Command: `bun run --cwd packages/core typecheck`
  - Workdir: `/home/roomhacker/agents-projects/apps/forks/opencode`
  - Result: passed (`tsgo --noEmit`)

## Scope and propagation notes

- Config propagation is proven only for:
  - `Config.Info` decoding.
  - Optional `Config.Service` lookup in `AISDK`.
  - V2 `SessionRunnerLLM` runtime behavior.
- No claim is made that server endpoints, OpenChamber, OmniRoute, legacy session runtime paths, or external deployments consume this config.
- `autoResume` is decoded and typed as part of the contract, but no automatic recovery/resume workflow was added in this task.

## Concerns

- The Task 1 brief names two commands that drift from this checkout:
  - Root `bun test packages/core/...` is blocked by `do-not-run-tests-from-root`.
  - `bun run --cwd packages/core type-check` is stale; the actual script is `typecheck`.
- The event schema change lives in `packages/schema/src/session-event.ts`; this is inside the OpenCode fork and is necessary for typed session event/UI metadata, but it is broader than the core-only file list in the brief.
