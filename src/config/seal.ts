import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import * as v from "valibot";
import { ConfigError, configSchema, type Config } from "./config.ts";

const plainVersion = 1;
const currentVersion = 2;
const ivLength = 12;
const tagLength = 16;
const invalidMessage = "This install link is not valid";

export const invalidLinkMessage = "This install link is not valid. Set up again.";
export const newerLinkMessage = "This install link is from a newer version";

function deriveKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

export function seal(config: Config, secret: string): string {
  const valid = v.parse(configSchema, config);
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const body = Buffer.concat([
    cipher.update(deflateRawSync(JSON.stringify(valid))),
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
    throw new ConfigError(newerLinkMessage);
  }

  const version = bytes[0];

  if (version !== currentVersion && version !== plainVersion) {
    throw new ConfigError(invalidMessage);
  }

  const iv = bytes.subarray(1, 1 + ivLength);
  const body = bytes.subarray(1 + ivLength, bytes.length - tagLength);
  const tag = bytes.subarray(bytes.length - tagLength);
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret), iv);

  decipher.setAuthTag(tag);

  try {
    const opened = Buffer.concat([decipher.update(body), decipher.final()]);
    const json = (version === plainVersion ? opened : inflateRawSync(opened)).toString("utf8");

    return v.parse(configSchema, JSON.parse(json));
  } catch {
    throw new ConfigError(invalidMessage);
  }
}
