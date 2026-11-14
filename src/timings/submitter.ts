import { createHash } from "node:crypto";
import * as v from "valibot";
import { TimingsInputError } from "./api.ts";

const minimumSaltLength = 32;
const saltMessage = `INSTALL_SALT must be set to at least ${minimumSaltLength} characters`;
const installIdMessage = "Send installId as a UUID";
const uuidSchema = v.pipe(v.string(), v.uuid());

export const readInstallSalt = (env: NodeJS.ProcessEnv): string => {
  const salt = env["INSTALL_SALT"];

  if (salt === undefined || salt.length < minimumSaltLength) {
    throw new Error(saltMessage);
  }

  return salt;
};

export const submitterOf = (installId: string, salt: string): string => {
  if (salt.length < minimumSaltLength) {
    throw new Error(saltMessage);
  }

  if (!v.is(uuidSchema, installId)) {
    throw new TimingsInputError(installIdMessage);
  }

  return createHash("sha256")
    .update(`${installId.toLowerCase()}:${salt}`)
    .digest("hex")
    .slice(0, 32);
};
