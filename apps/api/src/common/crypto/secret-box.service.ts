import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
} from "node:crypto";
import type { AppConfig } from "../../config/configuration";

/**
 * Authenticated symmetric encryption for secrets at rest (P1.2 / ADR-0020).
 *
 * AES-256-GCM with a 32-byte key from `MFA_ENC_KEY` (base64 in env today;
 * migrates to Vault at P2.14). Used to protect the TOTP secret so a database
 * dump does not hand an attacker every user's seed.
 *
 * Wire format (base64 of):  [12-byte IV][16-byte auth tag][ciphertext]
 * GCM's auth tag makes tampering detectable — decrypt throws if the
 * ciphertext or tag was modified.
 */
@Injectable()
export class SecretBoxService {
  private readonly key: Buffer;
  private static readonly IV_LEN = 12;
  private static readonly TAG_LEN = 16;

  constructor(config: ConfigService<AppConfig, true>) {
    // Validated at config load to be a 32-byte base64 value.
    const encoded: string = config.get("MFA_ENC_KEY", { infer: true });
    this.key = Buffer.from(encoded, "base64");
  }

  /** Encrypt a UTF-8 string → base64 envelope. */
  encrypt(plaintext: string): string {
    const iv = randomBytes(SecretBoxService.IV_LEN);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, "utf8"),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ciphertext]).toString("base64");
  }

  /** Decrypt a base64 envelope → UTF-8 string. Throws on tamper / wrong key. */
  decrypt(envelope: string): string {
    const buf = Buffer.from(envelope, "base64");
    const iv = buf.subarray(0, SecretBoxService.IV_LEN);
    const tag = buf.subarray(
      SecretBoxService.IV_LEN,
      SecretBoxService.IV_LEN + SecretBoxService.TAG_LEN,
    );
    const ciphertext = buf.subarray(
      SecretBoxService.IV_LEN + SecretBoxService.TAG_LEN,
    );
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  }
}
