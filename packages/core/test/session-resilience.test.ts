import { describe, expect } from "bun:test"
import {
  LLMClient,
  LLMError,
  LLMEvent,
  Model,
  ProviderInternalReason,
  RateLimitReason,
  TransportReason,
  type LLMClientShape,
  type LLMRequest,
} from "@opencode-ai/llm"
import * as OpenAIChat from "@opencode-ai/llm/protocols/openai-chat"
import { Database } from "@opencode-ai/core/database/database"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNodePlatform } from "@opencode-ai/core/effect/app-node-platform"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { QuestionV2 } from "@opencode-ai/core/question"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionRunner } from "@opencode-ai/core/session/runner"
import * as SessionRunnerLLM from "@opencode-ai/core/session/runner/llm"
import { SessionRunnerModel } from "@opencode-ai/core/session/runner/model"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Config } from "@opencode-ai/core/config"
import { ConfigResilience } from "@opencode-ai/core/config/resilience"
import { Location } from "@opencode-ai/core/location"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ApplicationTools } from "@opencode-ai/core/tool/application-tools"
import { Tool } from "@opencode-ai/core/tool/tool"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Cause, Deferred, Duration, Effect, Exit, Fiber, Layer, Schema, Stream } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { asc, eq } from "drizzle-orm"
import { testEffect } from "./lib/effect"

const requests: LLMRequest[] = []
let responses: Stream.Stream<LLMEvent, LLMError>[] = []
let resilience = ConfigResilience.DEFAULTS

const client = Layer.succeed(
  LLMClient.Service,
  LLMClient.Service.of({
    prepare: () => Effect.die("unused"),
    stream: ((request: LLMRequest) => {
      requests.push(request)
      return responses.shift() ?? Stream.empty
    }) as unknown as LLMClientShape["stream"],
    generate: () => Effect.die("unused"),
  }),
)

const primaryModel = Model.make({ id: "primary", provider: "test", route: OpenAIChat.route })
const fallbackOneModel = Model.make({ id: "fallback-one", provider: "test", route: OpenAIChat.route })
const fallbackTwoModel = Model.make({ id: "fallback-two", provider: "test", route: OpenAIChat.route })
const modelsByRef = new Map([
  ["test/primary", primaryModel],
  ["test/fallback-one", fallbackOneModel],
  ["test/fallback-two", fallbackTwoModel],
])

const models = SessionRunnerModel.layerWith((session) => {
  const ref = session.model ? `${session.model.providerID}/${session.model.id}` : "test/primary"
  return Effect.succeed(modelsByRef.get(ref) ?? primaryModel)
})

const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.die("unused"),
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)

const systemContextKey = SystemContext.Key.make("test/resilience-context")
const systemContext = Layer.effectDiscard(
  SystemContextRegistry.Service.pipe(
    Effect.flatMap((registry) =>
      registry.register({
        key: systemContextKey,
        load: Effect.succeed(
          SystemContext.make({
            key: systemContextKey,
            codec: Schema.toCodecJson(Schema.String),
            load: Effect.succeed("Resilience context"),
            baseline: String,
            update: (_previous, current) => current,
            removed: () => "Resilience context removed",
          }),
        ),
      }),
    ),
  ),
).pipe(Layer.provideMerge(AppNodeBuilder.build(SystemContextRegistry.node)))

const skillGuidance = Layer.mock(SkillGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const referenceGuidance = Layer.mock(ReferenceGuidance.Service, { load: () => Effect.succeed(SystemContext.empty) })
const config = Layer.succeed(
  Config.Service,
  Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          info: new Config.Info({ resilience }),
        }),
      ]),
  }),
)

const slowTool = Layer.effectDiscard(
  ToolRegistry.Service.use((registry) =>
    registry.register({
      slow: Tool.make({
        description: "Wait before returning",
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        toModelOutput: ({ output }) => [{ type: "text", text: output.text }],
        execute: ({ text }) => Effect.sleep(Duration.millis(1_000)).pipe(Effect.as({ text })),
      }),
    }),
  ),
)

const slowToolNode = makeLocationNode({
  name: "test/session-resilience-tools",
  layer: slowTool,
  deps: [ToolRegistry.node],
})

const runnerLayer = AppNodeBuilder.build(SessionRunnerLLM.node, [
  [Snapshot.node, Snapshot.noopLayer],
  [LayerNodePlatform.llmClient, client],
  [SessionRunnerModel.node, models],
  [SystemContextRegistry.node, systemContext],
  [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
  [SkillGuidance.node, skillGuidance],
  [ReferenceGuidance.node, referenceGuidance],
  [PermissionV2.node, permission],
  [Config.node, config],
])

const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const sessionRunner = yield* SessionRunner.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, SessionRunner.RunError>({
      drain: (sessionID, force) => sessionRunner.run({ sessionID, force }),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      interrupt: coordinator.interrupt,
    })
  }),
).pipe(Layer.provide(runnerLayer))

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      QuestionV2.node,
      SessionProjector.node,
      SessionStore.node,
      ApplicationTools.node,
      AgentV2.node,
      ToolOutputStore.node,
      ToolRegistry.node,
      ToolRegistry.toolsNode,
      slowToolNode,
      SessionRunnerModel.node,
      SystemContextRegistry.node,
      SkillGuidance.node,
      ReferenceGuidance.node,
      Config.node,
      Snapshot.node,
      SessionRunnerLLM.node,
      SessionExecution.node,
      SessionV2.node,
    ]),
    [
      [LayerNodePlatform.llmClient, client],
      [PermissionV2.node, permission],
      [SessionRunnerModel.node, models],
      [SystemContextRegistry.node, systemContext],
      [Location.node, Location.boundNode({ directory: AbsolutePath.make("/project") })],
      [SkillGuidance.node, skillGuidance],
      [ReferenceGuidance.node, referenceGuidance],
      [Snapshot.node, Snapshot.noopLayer],
      [SessionExecution.node, execution],
      [Config.node, config],
    ],
  ),
)

const sessionID = SessionV2.ID.make("ses_resilience_test")

const setup = Effect.gen(function* () {
  requests.length = 0
  responses = []
  resilience = ConfigResilience.DEFAULTS
  const { db } = yield* Database.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "resilience",
      directory: "/project",
      title: "resilience",
      version: "test",
      model: {
        id: ModelV2.ID.make("primary"),
        providerID: ProviderV2.ID.make("test"),
      },
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

const retryable = (message: string) =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new RateLimitReason({ message }),
  })

const internal = (message: string) =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new ProviderInternalReason({ message, status: 503 }),
  })

const nonRetryable = (message: string) =>
  new LLMError({
    module: "test",
    method: "stream",
    reason: new TransportReason({ message }),
  })

const textResponse = (text: string) =>
  Stream.fromIterable([
    LLMEvent.stepStart({ index: 0 }),
    LLMEvent.textStart({ id: "text" }),
    LLMEvent.textDelta({ id: "text", text }),
    LLMEvent.textEnd({ id: "text" }),
    LLMEvent.stepFinish({ index: 0, reason: "stop" }),
    LLMEvent.finish({ reason: "stop" }),
  ])

const toolResponse = Stream.fromIterable([
  LLMEvent.stepStart({ index: 0 }),
  LLMEvent.toolCall({ id: "call-slow", name: "slow", input: { text: "late" } }),
  LLMEvent.stepFinish({ index: 0, reason: "tool-calls" }),
  LLMEvent.finish({ reason: "tool-calls" }),
])

const stepEvents = Database.Service.use(({ db }) =>
  db
    .select({ type: EventTable.type, data: EventTable.data })
    .from(EventTable)
    .where(eq(EventTable.aggregate_id, sessionID))
    .orderBy(asc(EventTable.seq))
    .all()
    .pipe(Effect.orDie),
)

describe("Session resilience", () => {
  it.effect("retries retryable provider failures within the configured bound", () =>
    Effect.gen(function* () {
      yield* setup
      resilience = new ConfigResilience.Info({ ...ConfigResilience.DEFAULTS, retries: 2, retryDelayMs: 250 })
      responses = [Stream.fail(retryable("busy")), Stream.fail(retryable("busy again")), textResponse("ok")]
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Retry" }), resume: false })

      const fiber = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(requests.map((request) => String(request.model.id))).toEqual(["primary"])
      yield* TestClock.adjust(Duration.millis(249))
      yield* Effect.yieldNow
      expect(requests.map((request) => String(request.model.id))).toEqual(["primary"])
      yield* TestClock.adjust(Duration.millis(1))
      yield* Effect.yieldNow
      expect(requests.map((request) => String(request.model.id))).toEqual(["primary", "primary"])
      yield* TestClock.adjust(Duration.millis(250))
      yield* Fiber.join(fiber)

      expect(requests.map((request) => String(request.model.id))).toEqual(["primary", "primary", "primary"])
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({
        type: "assistant",
        content: [{ type: "text", text: "ok" }],
      })
      expect(
        (yield* stepEvents)
          .flatMap((event) => ((event.data as { resilience?: unknown }).resilience ? [event.data] : []))
          .at(0),
      ).toMatchObject({
        resilience: { attempt: 3, selectedModel: "test/primary", actualModel: "test/primary", fallbackUsed: false },
      })
    }),
  )

  it.effect("selects fallback models in configured order after retryable failures", () =>
    Effect.gen(function* () {
      yield* setup
      resilience = new ConfigResilience.Info({
        ...ConfigResilience.DEFAULTS,
        retries: 0,
        fallbackModels: ["test/fallback-one", "test/fallback-two"],
      })
      responses = [Stream.fail(internal("primary down")), Stream.fail(internal("fallback down")), textResponse("ok")]
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Fallback" }), resume: false })

      yield* session.resume(sessionID)

      expect(requests.map((request) => `${request.model.provider}/${String(request.model.id)}`)).toEqual([
        "test/primary",
        "test/fallback-one",
        "test/fallback-two",
      ])
      expect(
        (yield* stepEvents)
          .flatMap((event) => ((event.data as { resilience?: unknown }).resilience ? [event.data] : []))
          .at(-1),
      ).toMatchObject({
        resilience: {
          attempt: 3,
          selectedModel: "test/primary",
          actualModel: "test/fallback-two",
          fallbackUsed: true,
        },
      })
    }),
  )

  it.effect("classifies response timeouts without replacing MCP timeout fields", () =>
    Effect.gen(function* () {
      yield* setup
      resilience = new ConfigResilience.Info({
        ...ConfigResilience.DEFAULTS,
        responseTimeoutMs: 10,
      })
      responses = [Stream.never]
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Timeout" }), resume: false })

      const fiber = yield* session.resume(sessionID).pipe(Effect.flip, Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.millis(10))
      const failure = yield* Fiber.join(fiber)

      expect(failure).toBeInstanceOf(LLMError)
      expect(failure.message).toContain("Response timed out after 10 ms")
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({
        type: "assistant",
        finish: "error",
        error: { type: "unknown", message: "Response timed out after 10 ms" },
      })
      expect(
        Schema.decodeUnknownSync(Config.Info)({ mcp: { timeout: { startup: 5_000, request: 60_000 } } }).mcp,
      ).toMatchObject({ timeout: { startup: 5_000, request: 60_000 } })
    }),
  )

  it.effect("does not retry a provider failure after any assistant output is committed", () =>
    Effect.gen(function* () {
      yield* setup
      resilience = new ConfigResilience.Info({
        ...ConfigResilience.DEFAULTS,
        retries: 2,
        fallbackModels: ["test/fallback-one"],
      })
      responses = [
        Stream.concat(
          Stream.fromIterable([
            LLMEvent.stepStart({ index: 0 }),
            LLMEvent.textStart({ id: "text" }),
            LLMEvent.textDelta({ id: "text", text: "partial" }),
          ]),
          Stream.fail(retryable("after partial")),
        ),
      ]
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Partial" }), resume: false })

      const failure = yield* session.resume(sessionID).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(LLMError)
      expect(requests.map((request) => String(request.model.id))).toEqual(["primary"])
      expect((yield* session.context(sessionID)).at(-1)).toMatchObject({
        type: "assistant",
        finish: "error",
        content: [{ type: "text", text: "partial" }],
      })
    }),
  )

  it.effect("settles local tools with the configured tool execution ceiling", () =>
    Effect.gen(function* () {
      yield* setup
      resilience = new ConfigResilience.Info({
        ...ConfigResilience.DEFAULTS,
        toolTimeoutMs: 10,
      })
      responses = [toolResponse, Stream.empty]
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "Use slow tool" }), resume: false })

      const fiber = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* TestClock.adjust(Duration.millis(10))
      yield* Fiber.join(fiber)

      expect((yield* session.context(sessionID)).at(1)).toMatchObject({
        type: "assistant",
        content: [{ type: "tool", id: "call-slow", state: { status: "error" } }],
      })
    }),
  )

  it.effect("does not retry non-retryable provider failures", () =>
    Effect.gen(function* () {
      yield* setup
      resilience = new ConfigResilience.Info({ ...ConfigResilience.DEFAULTS, retries: 2 })
      responses = [Stream.fail(nonRetryable("not retryable"))]
      const session = yield* SessionV2.Service
      yield* session.prompt({ sessionID, prompt: Prompt.make({ text: "No retry" }), resume: false })

      const exit = yield* session.resume(sessionID).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBeInstanceOf(LLMError)
      expect(requests).toHaveLength(1)
    }),
  )
})
