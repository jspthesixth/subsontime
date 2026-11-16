import { createHash } from "node:crypto";
import * as v from "valibot";
import { installSaltMessage, minimumKeyLength } from "../config/env.ts";
import { TimingsInputError } from "./api.ts";

export const uuidSchema = v.pipe(v.string(), v.uuid());

const installIdMessage = "Send installId as a UUID";

export const submitterOf = (installId: string, salt: string): string => {
  if (salt.length < minimumKeyLength) {
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
