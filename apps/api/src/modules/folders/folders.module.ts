import { Module } from "@nestjs/common";
import { FoldersService } from "./folders.service";
import { FolderAccessService } from "./folder-access.service";
import { FoldersController } from "./folders.controller";

/**
 * Folders module (P3.3 / ADR-0047, 0048). The document folder tree + per-folder
 * permission inheritance. Exports FoldersService + FolderAccessService so
 * DocumentsService can validate/file documents and enforce folder access.
 */
@Module({
  controllers: [FoldersController],
  providers: [FoldersService, FolderAccessService],
  exports: [FoldersService, FolderAccessService],
})
export class FoldersModule {}
