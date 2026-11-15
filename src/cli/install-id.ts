import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, posix, win32 } from "node:path";

const fileName = "install-id";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const configDirOf = (
  platform: string,
  env: Record<string, string | undefined>,
  home: string,
) => {
  if (platform === "win32") {
    return win32.join(env["APPDATA"] || win32.join(home, "AppData", "Roaming"), "subsontime");
  }

  if (platform === "darwin") {
    return posix.join(home, "Library", "Application Support", "subsontime");
  }

  return posix.join(env["XDG_CONFIG_HOME"] || posix.join(home, ".config"), "subsontime");
};

const alreadyExists = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "EEXIST";

const createOnce = (path: string) =>
  writeFile(path, randomUUID(), { mode: 0o600, flag: "wx" }).catch((error: unknown) => {
    if (!alreadyExists(error)) {
      throw error;
    }
  });

export const installIdIn = async (directory: string): Promise<string> => {
  const path = join(directory, fileName);

  await mkdir(directory, { recursive: true, mode: 0o700 });
  await createOnce(path);

  const installId = (await readFile(path, "utf8")).trim();

  if (uuidPattern.test(installId)) {
    return installId;
  }

  await rm(path, { force: true });

  return installIdIn(directory);
};
