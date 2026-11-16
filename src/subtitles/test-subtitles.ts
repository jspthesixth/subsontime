import { readFileSync } from "node:fs";
import { decodeSubtitle } from "./decode.ts";
import { parseSubtitle } from "./parse.ts";

export const subtitleFixture = (name: string) =>
  parseSubtitle(
    decodeSubtitle(readFileSync(new URL(`../../test/fixtures/subtitles/${name}`, import.meta.url))),
  );
