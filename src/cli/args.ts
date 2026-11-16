import { parseArgs, type ParseArgsOptionsConfig } from "node:util";

export class UsageError extends Error {}

export const messageOf = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : fallback;

export const parseOptions = <Options extends ParseArgsOptionsConfig>(
  args: string[],
  options: Options,
  allowPositionals: boolean,
) => {
  try {
    return parseArgs({ args, options, allowPositionals });
  } catch (error) {
    throw new UsageError(messageOf(error, "Unreadable arguments"));
  }
};
