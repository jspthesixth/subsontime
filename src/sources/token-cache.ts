import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";

export interface TokenCache {
  get(key: string): Promise<string | undefined>;
  set(key: string, token: string, ttlSeconds: number): Promise<void>;
}

const ivLength = 12;
const tagLength = 16;

const encrypt = (token: string, key: Buffer, label: string) => {
  const iv = randomBytes(ivLength);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(label));

  return Buffer.concat([
    iv,
    cipher.update(token, "utf8"),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64url");
};

const decrypt = (stored: string, key: Buffer, label: string) => {
  const bytes = Buffer.from(stored, "base64url");

  try {
    const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, ivLength))
      .setAAD(Buffer.from(label))
      .setAuthTag(bytes.subarray(bytes.length - tagLength));

    return Buffer.concat([
      decipher.update(bytes.subarray(ivLength, bytes.length - tagLength)),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    return undefined;
  }
};

export const installKeyOf = (sealed: string): Uint8Array =>
  createHash("sha256").update(Buffer.from(sealed, "base64url")).digest();

export const tokenCacheFor = (
  state: SharedState,
  secret: string,
  installKey: Uint8Array,
): TokenCache => {
  const salt = createHash("sha256").update(`tokens:${secret}`).digest();
  const key = Buffer.from(hkdfSync("sha256", installKey, salt, "tokens", 32));
  const install = Buffer.from(installKey).toString("hex");

  const storageKey = (name: string) =>
    `tok:${createHash("sha256").update(`${install}:${name}`).digest("hex")}`;

  return {
    async get(name) {
      const stored = await orMiss(() => state.get(storageKey(name)), undefined);

      return stored === undefined ? undefined : decrypt(stored, key, name);
    },
    async set(name, token, ttlSeconds) {
      await orMiss(
        () => state.set(storageKey(name), encrypt(token, key, name), ttlSeconds),
        undefined,
      );
    },
  };
};
