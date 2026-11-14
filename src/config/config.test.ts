import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { configSchema, defaultConfig } from "./config.ts";

describe("configSchema", () => {
  it("rejects an empty language list", () => {
    const result = v.safeParse(configSchema, { ...defaultConfig(["eng"]), languages: [] });

    expect(result.success).toBe(false);
  });

  it("rejects a language that is not a three-letter code", () => {
    const result = v.safeParse(configSchema, { ...defaultConfig(["eng"]), languages: ["en"] });

    expect(result.success).toBe(false);
  });

  it("rejects a stremio-addon url that is not an https manifest", () => {
    const config = {
      ...defaultConfig(["eng"]),
      sources: [{ kind: "stremio-addon", url: "http://example.com/manifest.json" }],
    };

    expect(v.safeParse(configSchema, config).success).toBe(false);
  });

  it("accepts a local http manifest", () => {
    const config = {
      ...defaultConfig(["eng"]),
      sources: [{ kind: "stremio-addon", url: "http://127.0.0.1:7000/manifest.json" }],
    };

    expect(v.safeParse(configSchema, config).success).toBe(true);
  });

  it("rejects an empty credential", () => {
    const config = { ...defaultConfig(["eng"]), sources: [{ kind: "subdl", apiKey: "" }] };

    expect(v.safeParse(configSchema, config).success).toBe(false);
  });
});

describe("defaultConfig", () => {
  it("uses the OpenSubtitles addon and a fresh install id", () => {
    const first = defaultConfig(["eng"]);
    const second = defaultConfig(["eng"]);

    expect(first.sources).toHaveLength(1);
    expect(first.sources[0]?.kind).toBe("stremio-addon");
    expect(first.installId).not.toBe(second.installId);
    expect(v.safeParse(configSchema, first).success).toBe(true);
  });
});
