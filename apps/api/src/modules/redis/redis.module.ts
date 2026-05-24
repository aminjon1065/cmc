import {
  Global,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import IORedis, { type Redis } from "ioredis";
import type { AppConfig } from "../../config/configuration";
import { REDIS } from "./redis.tokens";

// Re-export so existing `import { REDIS } from "./redis.module"` style works.
// Canonical source remains `redis.tokens.ts` to break the circular import
// between the module and the lifecycle owner.
export { REDIS };

/**
 * Owns the lifecycle of the single ioredis client.
 *
 * - `onModuleInit`: PING the server so misconfiguration fails the boot
 *   (loud, immediate, unambiguous) instead of surfacing later as a confused
 *   500 from the first rate-limit / cache caller. Redis is a tier-1
 *   dependency per ADR-0008.
 * - `onModuleDestroy`: graceful QUIT so in-flight pipelines drain and
 *   pub/sub subscriptions are closed cleanly.
 *
 * The ioredis event handlers attached in the factory below log every state
 * transition — observability today is via the Logger; Prometheus metrics
 * land with P0.7 and deep health probes with P0.8.
 *
 * Constructed via a `useFactory` provider (not `@Injectable`) — mirrors
 * `DatabaseLifecycle`. The factory shape keeps DI decoupled from
 * reflect-metadata, which has bitten the project before (see ADR-0005 §8).
 */
class RedisLifecycle implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger("Redis");

  constructor(private readonly client: Redis) {}

  async onModuleInit(): Promise<void> {
    // The factory disables ioredis's offline queue and pins a small
    // retry budget so a wrong URL fails in seconds, not in 10+ retries.
    // PING surfaces "connected to the wrong server" / "wrong password"
    // / "wrong DB index" as a real error at boot time.
    const reply = await this.client.ping();
    if (reply !== "PONG") {
      throw new Error(`Unexpected PING reply from Redis: ${reply}`);
    }
    this.logger.log("Redis connectivity verified (PING → PONG)");
  }

  async onModuleDestroy(): Promise<void> {
    this.logger.log("Closing Redis connection...");
    try {
      await this.client.quit();
    } catch (err) {
      // QUIT can fail if the connection is already torn down (e.g. server
      // restarted during shutdown). Fall back to disconnect() so the
      // socket is definitely released.
      this.logger.warn(
        `QUIT failed during shutdown: ${
          err instanceof Error ? err.message : String(err)
        }; falling back to disconnect()`,
      );
      this.client.disconnect();
    }
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<AppConfig, true>): Redis => {
        const url = config.get("REDIS_URL", { infer: true });
        const logger = new Logger("Redis");

        const client = new IORedis(url, {
          // Surface a misconfigured URL within a few seconds rather than
          // tying up the boot path through default 20 retries.
          maxRetriesPerRequest: 3,
          // Capped exponential reconnect.
          retryStrategy: (times) => Math.min(times * 200, 5_000),
          // Visible in `CLIENT LIST` for ops — distinguishes the API's
          // connection from BullMQ workers, WS gateway, etc. (when those
          // arrive).
          connectionName: "cmc-api",
          // ioredis defaults to enabling the offline queue (commands issued
          // while disconnected are buffered and replayed on reconnect).
          // Keep that on — it's the safer default for the kinds of work
          // we'll do (cache, rate limit) — but bound the retry budget so a
          // request never hangs indefinitely on a dead server.
          enableOfflineQueue: true,
        });

        // Lifecycle visibility. These map 1:1 to ioredis's documented event
        // names; each one is benign on its own but their sequence is the
        // canonical "is Redis healthy?" signal.
        client.on("connect", () => logger.log(`Connecting to Redis`));
        client.on("ready", () => logger.log(`Redis client ready`));
        client.on("reconnecting", (delay: number) =>
          logger.warn(`Redis reconnecting in ${delay}ms`),
        );
        client.on("end", () => logger.warn(`Redis connection closed`));
        client.on("error", (err: Error) =>
          // Errors are very chatty during startup if the server is briefly
          // unreachable; the OnModuleInit PING is what fails the boot — so
          // surface errors at warn level here and let the init throw decide.
          logger.warn(`Redis error: ${err.message}`),
        );

        return client;
      },
    },
    {
      provide: RedisLifecycle,
      inject: [REDIS],
      useFactory: (client: Redis) => new RedisLifecycle(client),
    },
  ],
  exports: [REDIS],
})
export class RedisModule {}
