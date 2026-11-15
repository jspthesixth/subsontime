import { createHash } from "node:crypto";
import * as v from "valibot";
import { installSaltMessage, minimumSecretLength } from "../config/env.ts";
import { TimingsInputError } from "./api.ts";

const installIdMessage = "Send installId as a UUID";
const uuidSchema = v.pipe(v.string(), v.uuid());

export const submitterOf = (installId: string, salt: string): string => {
  if (salt.length < minimumSecretLength) {
    throw new Error(installSaltMessage);
  }

  if (!v.is(uuidSchema, installId)) {
    throw new TimingsInputError(installIdMessage);
  }

  return createHash("sha256")
    .update(`${installId.toLowerCase()}:${salt}`)
    .digest("hex")
    .slice(0, 32);
};

export const groupingKeyOf = (salt: string): Buffer =>
  createHash("sha256").update(`grouping:${salt}`).digest();
