/**
 * DI tokens for the Redis module.
 *
 * `REDIS` resolves to a connected `ioredis` client. Consumers inject it with
 * `@Inject(REDIS) private readonly redis: Redis`.
 *
 * Lives in its own file (mirrors `database.tokens.ts`) so unrelated modules
 * can import the symbol without pulling the whole `RedisModule` graph.
 */
export const REDIS = Symbol("REDIS");
