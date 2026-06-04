import type { ConfigService } from "@nestjs/config";
import type { AppConfig } from "../../config/configuration";

/** DI token for the document text-extraction seam (P5.6 / ADR-0072). */
export const TEXT_EXTRACTOR = Symbol("TEXT_EXTRACTOR");

export interface TextExtractor {
  /** Whether a real extractor is wired (gated `DOC_EXTRACT_ENABLED`) vs the noop. */
  readonly active: boolean;
  /**
   * Extract plain text from document bytes by MIME type. Returns "" when the
   * type isn't extractable or no text is found.
   */
  extract(
    bytes: Buffer,
    mimeType: string,
    opts: { ocrLang: string },
  ): Promise<string>;
}

/** Disabled extractor — returns no text (dev/test/CI default). */
export class NoopTextExtractor implements TextExtractor {
  readonly active = false;
  async extract(): Promise<string> {
    return "";
  }
}

/**
 * Factory: a real extractor when `DOC_EXTRACT_ENABLED`, else a noop. The real
 * impl (PDF text-layer + Tesseract OCR) is dynamic-imported so its CPU/sovereign
 * OCR toolchain never enters the jest runtime (the gated-lazy-seam pattern, like
 * the OpenSearch / preview seams).
 */
export async function createTextExtractor(
  config: ConfigService<AppConfig, true>,
): Promise<TextExtractor> {
  if (!config.get("DOC_EXTRACT_ENABLED", { infer: true })) {
    return new NoopTextExtractor();
  }
  const { RealTextExtractor } = await import("./text-extractor.impl");
  return new RealTextExtractor();
}
