import * as v from "valibot";
import { describe, expect, it } from "vitest";
import { ConfigError } from "./config.ts";
import { defaultConfig } from "./default-config.ts";
import { seal, unseal } from "./seal.ts";

const secret = "a".repeat(32);

describe("seal", () => {
  it("round trips a config", () => {
    const config = defaultConfig(["eng", "hrv"]);

    expect(unseal(seal(config, secret), secret)).toEqual(config);
  });

  it("rejects a token with a flipped byte", () => {
    const bytes = Buffer.from(seal(defaultConfig(["eng"]), secret), "base64url");

    bytes[20] = (bytes[20] ?? 0) ^ 1;

    expect(() => unseal(bytes.toString("base64url"), secret)).toThrow(ConfigError);
  });

  it("rejects a newer version", () => {
    const bytes = Buffer.from(seal(defaultConfig(["eng"]), secret), "base64url");

    bytes[0] = 2;

    expect(() => unseal(bytes.toString("base64url"), secret)).toThrow(
      "This install link is from a newer version",
    );
  });

  it("rejects a token sealed with another secret", () => {
    const token = seal(defaultConfig(["eng"]), secret);

    expect(() => unseal(token, "b".repeat(32))).toThrow(ConfigError);
  });

  it("rejects garbage and truncated tokens", () => {
    expect(() => unseal("abc", secret)).toThrow("This install link is not valid");
    expect(() => unseal("", secret)).toThrow(ConfigError);
  });

  it("refuses to seal an invalid config", () => {
    const config = { ...defaultConfig(["eng"]), languages: [] };

    expect(() => seal(config, secret)).toThrow(v.ValiError);
  });
});
