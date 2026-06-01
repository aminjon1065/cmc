import { Injectable } from "@nestjs/common";
import type { OpenAPIObject } from "@nestjs/swagger";

/**
 * Holds the OpenAPI document built once at boot in `main.ts` (P1.10 / ADR-0028).
 *
 * The document is generated *after* the Nest app is initialised (routes must be
 * registered first) and *outside* the module graph, so we stash it here for the
 * gated controller to serve. When `OPENAPI_ENABLED` is false the document is
 * never set, so `getDocument()` returns null and the controller 404s.
 */
@Injectable()
export class OpenApiService {
  private document: OpenAPIObject | null = null;

  setDocument(document: OpenAPIObject): void {
    this.document = document;
  }

  getDocument(): OpenAPIObject | null {
    return this.document;
  }
}
