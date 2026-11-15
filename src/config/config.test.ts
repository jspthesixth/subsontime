import * as v from "valibot";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configSchema } from "./config.ts";
import { defaultConfig } from "./default-config.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

const configSchemaAllowingLocalAddons = async () => {
  vi.stubEnv("ALLOW_LOCAL_ADDONS", "1");
  vi.resetModules();

  const { configSchema: schema } = await import("./config.ts");

  return schema;
};

const withAddon = (url: string) => ({
  ...defaultConfig(["eng"]),
  sources: [{ kind: "stremio-addon", url }],
});

describe("configSchema", () => {
  it("rejects an empty language list", () => {
    const result = v.safeParse(configSchema, { ...defaultConfig(["eng"]), languages: [] });

    expect(result.success).toBe(false);
  });

  it("rejects a language that is not a three-letter code", () => {
    const result = v.safeParse(configSchema, { ...defaultConfig(["eng"]), languages: ["en"] });

    expect(result.success).toBe(false);
  });

  it.each([
    ["hrv", true],
    ["eng", false],
    ["en", false],
  ])("takes %j as the second language of an English install: %j", (dualLanguage, valid) => {
    const config = defaultConfig(["eng", "hrv"]);
    const result = v.safeParse(configSchema, {
      ...config,
      extras: { ...config.extras, dualLanguage },
    });

    expect(result.success).toBe(valid);
  });

  it("rejects a stremio-addon url that is not an https manifest", () => {
    const config = {
      ...defaultConfig(["eng"]),
      sources: [{ kind: "stremio-addon", url: "http://example.com/manifest.json" }],
    };

    expect(v.safeParse(configSchema, config).success).toBe(false);
  });

  it("accepts a local http manifest", async () => {
    const localSchema = await configSchemaAllowingLocalAddons();
    const config = {
      ...defaultConfig(["eng"]),
      sources: [{ kind: "stremio-addon", url: "http://127.0.0.1:7000/manifest.json" }],
    };

    expect(v.safeParse(localSchema, config).success).toBe(true);
  });

  it.each([
    ["https://localhost/manifest.json"],
    ["https://addon.localhost/manifest.json"],
    ["https://localhost./manifest.json"],
  ])("rejects the local name %s", (url) => {
    expect(v.safeParse(configSchema, withAddon(url)).success).toBe(false);
  });

  it("rejects a local http manifest unless local addons are allowed", () => {
    expect(
      v.safeParse(configSchema, withAddon("http://127.0.0.1:7000/manifest.json")).success,
    ).toBe(false);
  });

  it.each([
    ["http://127.0.0.1:6379/x?manifest.json"],
    ["https://addon.example.com/x?/manifest.json"],
    ["https://addon.example.com/manifest.json#x"],
    ["https://[64:ff9b::a00:5]/manifest.json"],
    ["https://10.0.0.5/manifest.json"],
    ["https://[::1]/manifest.json"],
  ])("rejects %s", async (url) => {
    const localSchema = await configSchemaAllowingLocalAddons();

    expect(v.safeParse(localSchema, withAddon(url)).success).toBe(false);
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
