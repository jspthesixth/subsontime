import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";
import * as v from "valibot";
import { cliSchema, readGroup } from "../config/env.ts";
import { uuidSchema } from "../timings/submitter.ts";

const fileName = "install-id";

export const configDirOf = (
  platform: string,
  env: Record<string, string | undefined>,
  home: string,
) => {
  const { configDir, appData, xdgConfigHome } = readGroup(cliSchema, env);

  if (configDir !== undefined) {
    return configDir;
  }

  if (platform === "win32") {
    return win32.join(appData ?? win32.join(home, "AppData", "Roaming"), "subsontime");
  }

  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "subsontime");
  }

  return posix.join(xdgConfigHome ?? posix.join(home, ".config"), "subsontime");
};

const alreadyExists = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

const createOnce = (path: string) =>
  writeFile(path, randomUUID(), { mode: 0o600, flag: "wx" }).catch((error: unknown) => {
    if (!alreadyExists(error)) {
      throw error;
    }
  });

export const fallbackConfigDir = (temp: string, uid: number | undefined) =>
  join(temp, `subsontime-${uid ?? "user"}`);

const ownDirectory = async (directory: string) => {
  const info = await lstat(directory);
  const uid = process.getuid?.();

  if (!info.isDirectory() || (uid !== undefined && info.uid !== uid)) {
    throw new Error("the fallback folder is not this user's");
  }

  if ((info.mode & 0o077) !== 0) {
    throw new Error("the fallback folder is open to other users");
  }
};

export const installIdIn = async (directory: string): Promise<string> => {
  const path = join(directory, fileName);

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await createOnce(path);

  const installId = (await readFile(path, "utf8")).trim();

  if (v.is(uuidSchema, installId)) {
    return installId;
  }

  await rm(path, { force: true });

  return installIdIn(directory);
};

export const installIdFrom = (directory: string, fallback: string | undefined) =>
  installIdIn(directory).catch(async (error: unknown) => {
    if (fallback === undefined) {
      throw error;
    }

    await mkdir(fallback, { recursive: true, mode: 0o700 });
    await ownDirectory(fallback);

    return installIdIn(fallback);
  });
