import { Logger } from "@nestjs/common";
import type { TextExtractor } from "./text-extractor";

type PdfParse = (b: Buffer) => Promise<{ text?: string }>;
type Tesseract = {
  recognize: (
    img: Buffer,
    lang: string,
  ) => Promise<{ data?: { text?: string } }>;
};

/**
 * Real document text extractor (P5.6 / ADR-0072) — a CPU/sovereign **live
 * boundary**: digital PDFs use the text layer (`pdf-parse`), scans/images use
 * Tesseract OCR (`tesseract.js`, WASM, no GPU). Those libs are installed on the
 * serving host only (not the test/CI dependency set), so they're imported via a
 * non-literal specifier — TypeScript leaves the import unresolved (no build
 * dependency) and jest never loads them (the extractor is faked in e2e). Only
 * reached when `DOC_EXTRACT_ENABLED`.
 */
export class RealTextExtractor implements TextExtractor {
  readonly active = true;
  private readonly logger = new Logger(RealTextExtractor.name);

  async extract(
    bytes: Buffer,
    mimeType: string,
    opts: { ocrLang: string },
  ): Promise<string> {
    if (mimeType === "application/pdf") return this.fromPdf(bytes);
    if (mimeType.startsWith("image/")) return this.fromImage(bytes, opts.ocrLang);
    if (mimeType.startsWith("text/")) return bytes.toString("utf8").trim();
    this.logger.debug(`no extractor for mime ${mimeType}`);
    return "";
  }

  private async fromPdf(bytes: Buffer): Promise<string> {
    const spec = "pdf-parse";
    const mod: unknown = await import(spec);
    const parse = (mod as { default: PdfParse }).default;
    const parsed = await parse(bytes);
    return (parsed.text ?? "").trim();
  }

  private async fromImage(bytes: Buffer, lang: string): Promise<string> {
    const spec = "tesseract.js";
    const mod: unknown = await import(spec);
    const { recognize } = mod as Tesseract;
    const res = await recognize(bytes, lang);
    return (res.data?.text ?? "").trim();
  }
}
