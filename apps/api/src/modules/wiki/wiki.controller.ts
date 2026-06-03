import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ZodError, type ZodSchema } from "zod";
import {
  CreateWikiCommentSchema,
  CreateWikiPageSchema,
  CreateWikiSpaceSchema,
  MoveWikiPageSchema,
  UpdateWikiPageSchema,
  UpdateWikiSpaceSchema,
  type WikiCommentResponse,
  type WikiCommentsListResponse,
  type WikiPageResponse,
  type WikiPageVersionsListResponse,
  type WikiPagesListResponse,
  type WikiSpaceResponse,
  type WikiSpacesListResponse,
} from "@cmc/contracts";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard";
import { AuthorizeGuard } from "../../common/authz/authorize.guard";
import { Authorize } from "../../common/authz/authorize.decorator";
import { WikiService } from "./wiki.service";

function parse<T>(s: ZodSchema<T>, raw: unknown): T {
  try {
    return s.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new BadRequestException(
        `Invalid wiki payload — ${err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
    throw err;
  }
}

/**
 * Wiki endpoints (P3.10 / ADR-0055). `@Authorize`-gated on `wiki:*`; RLS
 * confines all rows to the tenant. Bodies are Zod-parsed in-controller (the
 * ProseMirror content is a deep passthrough object — class-validator is unfit).
 */
@Controller("wiki")
@UseGuards(JwtAuthGuard, AuthorizeGuard)
export class WikiController {
  constructor(private readonly wiki: WikiService) {}

  // ---------- spaces ----------

  @Get("spaces")
  @Authorize("wiki:read")
  async listSpaces(): Promise<WikiSpacesListResponse> {
    return { spaces: await this.wiki.listSpaces() };
  }

  @Post("spaces")
  @Authorize("wiki:manage")
  @HttpCode(HttpStatus.CREATED)
  async createSpace(@Body() body: unknown): Promise<WikiSpaceResponse> {
    return { space: await this.wiki.createSpace(parse(CreateWikiSpaceSchema, body)) };
  }

  @Get("spaces/:id")
  @Authorize("wiki:read")
  async getSpace(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<WikiSpaceResponse> {
    return { space: await this.wiki.getSpace(id) };
  }

  @Patch("spaces/:id")
  @Authorize("wiki:manage")
  async updateSpace(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<WikiSpaceResponse> {
    return {
      space: await this.wiki.updateSpace(id, parse(UpdateWikiSpaceSchema, body)),
    };
  }

  @Delete("spaces/:id")
  @Authorize("wiki:manage")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSpace(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.wiki.deleteSpace(id);
  }

  @Get("spaces/:id/pages")
  @Authorize("wiki:read")
  async listPages(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<WikiPagesListResponse> {
    return { pages: await this.wiki.listPages(id) };
  }

  // ---------- pages ----------

  @Post("pages")
  @Authorize("wiki:write")
  @HttpCode(HttpStatus.CREATED)
  async createPage(@Body() body: unknown): Promise<WikiPageResponse> {
    return { page: await this.wiki.createPage(parse(CreateWikiPageSchema, body)) };
  }

  @Get("pages/:id")
  @Authorize("wiki:read")
  async getPage(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<WikiPageResponse> {
    return { page: await this.wiki.getPage(id) };
  }

  @Patch("pages/:id")
  @Authorize("wiki:write")
  async updatePage(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<WikiPageResponse> {
    return {
      page: await this.wiki.updatePage(id, parse(UpdateWikiPageSchema, body)),
    };
  }

  @Post("pages/:id/move")
  @Authorize("wiki:write")
  @HttpCode(HttpStatus.OK)
  async movePage(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<WikiPageResponse> {
    return { page: await this.wiki.movePage(id, parse(MoveWikiPageSchema, body)) };
  }

  @Delete("pages/:id")
  @Authorize("wiki:write")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deletePage(@Param("id", ParseUUIDPipe) id: string): Promise<void> {
    await this.wiki.deletePage(id);
  }

  @Get("pages/:id/versions")
  @Authorize("wiki:read")
  async listVersions(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<WikiPageVersionsListResponse> {
    return { versions: await this.wiki.listVersions(id) };
  }

  @Post("pages/:id/versions/:versionNo/restore")
  @Authorize("wiki:write")
  @HttpCode(HttpStatus.OK)
  async restoreVersion(
    @Param("id", ParseUUIDPipe) id: string,
    @Param("versionNo", ParseIntPipe) versionNo: number,
  ): Promise<WikiPageResponse> {
    return { page: await this.wiki.restoreVersion(id, versionNo) };
  }

  // ---------- comments (P3.10b) ----------

  @Get("pages/:id/comments")
  @Authorize("wiki:read")
  async listComments(
    @Param("id", ParseUUIDPipe) id: string,
  ): Promise<WikiCommentsListResponse> {
    return { comments: await this.wiki.listComments(id) };
  }

  @Post("pages/:id/comments")
  @Authorize("wiki:write")
  @HttpCode(HttpStatus.CREATED)
  async createComment(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
  ): Promise<WikiCommentResponse> {
    return {
      comment: await this.wiki.createComment(id, parse(CreateWikiCommentSchema, body)),
    };
  }

  @Delete("comments/:commentId")
  @Authorize("wiki:write")
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteComment(
    @Param("commentId", ParseUUIDPipe) commentId: string,
  ): Promise<void> {
    await this.wiki.deleteComment(commentId);
  }
}
