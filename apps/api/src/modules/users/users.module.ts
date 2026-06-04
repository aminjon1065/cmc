import { Module } from "@nestjs/common";
import { UsersService } from "./users.service";
import { UsersController } from "./users.controller";
import { PreferencesController } from "./preferences.controller";
import { SessionsModule } from "../auth/sessions.module";

/**
 * UsersModule provides UsersService (consumed by AuthModule for the login
 * lookup) and the admin UsersController (P1.4b). It imports SessionsModule so
 * UsersService can revoke a user's sessions on deactivate/delete — RbacService
 * and AuditService come from their @Global modules.
 */
@Module({
  imports: [SessionsModule],
  providers: [UsersService],
  controllers: [UsersController, PreferencesController],
  exports: [UsersService],
})
export class UsersModule {}
