import { Cause, Effect, Layer } from "effect"
import { LocationServiceMap } from "../../location-service-map"
import { makeGlobalNode } from "../../effect/app-node"
import { SessionRunCoordinator } from "../run-coordinator"
import { SessionRunner } from "../runner"
import { SessionSchema } from "../schema"
import { SessionStore } from "../store"
import { SessionExecution } from "../execution"
import { Config } from "../../config"
import { ConfigResilience } from "../../config/resilience"

/** Current-process routing for implicit-local Locations. Future remote placement belongs here. */
const layer = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const coordinator = yield* SessionRunCoordinator.make<SessionSchema.ID, SessionRunner.RunError>({
      drain: Effect.fnUntraced(function* (sessionID: SessionSchema.ID, force) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* Effect.die(`Session not found: ${sessionID}`)
        const location = locations.get(session.location)
        return yield* Effect.gen(function* () {
          const first = yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force })).pipe(Effect.exit)
          if (first._tag === "Success") return first.value

          const config = yield* Config.Service
          const resilience = ConfigResilience.fromEntries(yield* config.entries())
          if (!resilience.autoResume) return yield* Effect.failCause(first.cause)

          yield* Effect.logWarning("Auto-resuming failed Session execution", { sessionID })
          return yield* SessionRunner.Service.use((runner) => runner.run({ sessionID, force: true }))
        }).pipe(
          Effect.provide(location),
          Effect.tapCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logError("Failed to drain Session", cause).pipe(Effect.annotateLogs({ sessionID })),
          ),
        )
      }),
    })

    return SessionExecution.Service.of({
      active: coordinator.active,
      interrupt: coordinator.interrupt,
      resume: coordinator.run,
      wake: coordinator.wake,
    })
  }),
)

export const node = makeGlobalNode({
  service: SessionExecution.Service,
  layer,
  deps: [SessionStore.node, LocationServiceMap.node],
})

export * as SessionExecutionLocal from "./local"
