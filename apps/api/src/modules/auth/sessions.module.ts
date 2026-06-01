import { Module } from "@nestjs/common";
import { SessionsService } from "./sessions.service";

/**
 * Session management, extracted from AuthModule (P1.4b) so consumers other
 * than auth — e.g. the admin UsersModule, which revokes a user's sessions on
 * deactivate/delete — can depend on it WITHOUT importing AuthModule (AuthModule
 * imports UsersModule, so that would be a cycle).
 *
 * SessionsService's deps (TenantDatabaseService, SessionCacheService) come from
 * their @Global modules, so this module needs no imports.
 */
@Module({
  providers: [SessionsService],
  exports: [SessionsService],
})
export class SessionsModule {}
