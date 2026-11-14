import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import * as v from "valibot";
import { ConfigError, configSchema, type Config } from "./config.ts";

const currentVersion = 1;
const ivLength = 12;
const tagLength = 16;
const invalidMessage = "This install link is not valid";

export const invalidLinkMessage = "This install link is not valid. Set up again.";
export const sealedConfigPattern = /^[A-Za-z0-9_-]{40,}$/;

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function seal(config: Config, secret: string): string {
  const valid = v.parse(configSchema, config);
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(valid), "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  return Buffer.concat([Buffer.from([currentVersion]), iv, body]).toString("base64url");
}

export function unseal(token: string, secret: string): Config {
  const bytes = Buffer.from(token, "base64url");

  if (bytes.length < 1 + ivLength + tagLength) {
    throw new ConfigError(invalidMessage);
  }

  if ((bytes[0] ?? 0) > currentVersion) {
    throw new ConfigError("This install link is from a newer version");
  }

  if (bytes[0] !== currentVersion) {
    throw new ConfigError(invalidMessage);
  }

  const iv = bytes.subarray(1, 1 + ivLength);
  const body = bytes.subarray(1 + ivLength, bytes.length - tagLength);
  const tag = bytes.subarray(bytes.length - tagLength);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);

  decipher.setAuthTag(tag);

  try {
    const json = Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");

    return v.parse(configSchema, JSON.parse(json));
  } catch {
    throw new ConfigError(invalidMessage);
  }
}
