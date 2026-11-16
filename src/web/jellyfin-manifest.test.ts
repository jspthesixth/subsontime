import { readFile } from "node:fs/promises";
import * as v from "valibot";
import { expect, test } from "vitest";
import { createApp } from "../app.ts";
import { jellyfinRepository, releasesSchema } from "./jellyfin-manifest.ts";

const plugin = {
  guid: "25644ac2-fc95-4f1f-9beb-21e679183dff",
  name: "Subs On Time",
  description: "Subtitles that fit the file you are playing.",
  overview: "Finds subtitles for the exact video file and retimes them to it.",
  owner: "subsontime",
  category: "Subtitles",
};

const release = (version: string, timestamp: string) => ({
  version,
  changelog: `https://github.com/jspthesixth/subsontime/releases/tag/v${version.slice(0, -2)}`,
  targetAbi: "12.0.0.0",
  sourceUrl: `https://github.com/jspthesixth/subsontime/releases/download/v${version.slice(0, -2)}/subsontime-jellyfin_${version}.zip`,
  checksum: "4fe7744c4e24f22fcb395c90d66fbfb6",
  timestamp,
});

test("GET /jellyfin/manifest.json lists the plugin from the committed releases", async () => {
  const response = await createApp({ secret: "test-secret" }).request("/jellyfin/manifest.json");

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject([plugin]);
});

test("the repository lists the plugin with no versions before the first release", () => {
  expect(jellyfinRepository([])).toEqual([{ ...plugin, versions: [] }]);
});

test("the repository lists the newest version first with its checksum and download URL", () => {
  const releases = [
    release("0.1.0.0", "2026-11-20T10:00:00Z"),
    release("0.2.0.0", "2026-12-01T09:30:00Z"),
  ];

  expect(jellyfinRepository(releases)).toEqual([
    {
      ...plugin,
      versions: [
        {
          version: "0.2.0.0",
          changelog: "https://github.com/jspthesixth/subsontime/releases/tag/v0.2.0",
          targetAbi: "12.0.0.0",
          sourceUrl:
            "https://github.com/jspthesixth/subsontime/releases/download/v0.2.0/subsontime-jellyfin_0.2.0.0.zip",
          checksum: "4fe7744c4e24f22fcb395c90d66fbfb6",
          timestamp: "2026-12-01T09:30:00Z",
        },
        {
          version: "0.1.0.0",
          changelog: "https://github.com/jspthesixth/subsontime/releases/tag/v0.1.0",
          targetAbi: "12.0.0.0",
          sourceUrl:
            "https://github.com/jspthesixth/subsontime/releases/download/v0.1.0/subsontime-jellyfin_0.1.0.0.zip",
          checksum: "4fe7744c4e24f22fcb395c90d66fbfb6",
          timestamp: "2026-11-20T10:00:00Z",
        },
      ],
    },
  ]);
});

test("a release needs a four-part version, an MD5 checksum and a UTC timestamp", () => {
  const valid = release("0.1.0.0", "2026-11-20T10:00:00Z");

  expect(v.is(releasesSchema, [valid])).toBe(true);
  expect(v.is(releasesSchema, [{ ...valid, version: "0.1.0" }])).toBe(false);
  expect(v.is(releasesSchema, [{ ...valid, checksum: "not-an-md5" }])).toBe(false);
  expect(v.is(releasesSchema, [{ ...valid, timestamp: "2026-11-20" }])).toBe(false);
  expect(v.is(releasesSchema, [{ ...valid, sourceUrl: "subsontime-jellyfin_0.1.0.0.zip" }])).toBe(
    false,
  );
});

test("the plugin, its build.yaml and the repository share one guid", async () => {
  const pluginSource = await readFile("plugins/jellyfin/Plugin.cs", "utf8");
  const buildYAML = await readFile("plugins/jellyfin/build.yaml", "utf8");

  expect(pluginSource).toContain('Guid.Parse("25644ac2-fc95-4f1f-9beb-21e679183dff")');
  expect(buildYAML).toContain('guid: "25644ac2-fc95-4f1f-9beb-21e679183dff"');
});
