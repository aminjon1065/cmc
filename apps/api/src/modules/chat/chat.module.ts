import { Module } from "@nestjs/common";
import { ChatService } from "./chat.service";
import { ChatController } from "./chat.controller";

/**
 * Chat module (P3.12 / ADR-0057). ChatService uses TenantDatabaseService +
 * AuditService + OutboxService + RbacService (all @Global). Posting emits `chat`
 * events to the outbox; the P2.3 realtime fan-out delivers them live to
 * `chat:read` subscribers (subject `tenant.<id>.chat.*`).
 */
@Module({
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
