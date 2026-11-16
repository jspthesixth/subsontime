import { createCipheriv, createHash, randomBytes } from "node:crypto";
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

  it("opens a link sealed before the Open Timings switches with both on", () => {
    const { useShared, share, ...old } = defaultConfig(["eng"]);

    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update(secret).digest(), iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(old), "utf8"), cipher.final()]);
    const token = Buffer.concat([Buffer.from([1]), iv, body, cipher.getAuthTag()]).toString(
      "base64url",
    );

    expect([useShared, share]).toEqual([true, true]);
    expect(unseal(token, secret)).toEqual({ ...old, useShared: true, share: true });
  });

  it("opens a link sealed before the extras with the extras off", () => {
    const token =
      "AQrayQZPwhMYhSSTE58xMGB5hEuVQGaI4Hp1uTmhVH2LKFWGrItvNzps_aM5E2DrS52IGLaGSVaGZl6KUieNrhcrdfgr7vqkj0_v52VFmgEh0gdhs7q-EaTTAwxr1z9NE05n0HoO97SsGVVfm_lrl0xu0wyiG2uWLhefwDpiYrxg2rP01k5eDGLaqGWeKIA-3slv771UxxbW9EqsAOMbDLG-ur8EJs3goz0fbWkU31HXW0SItY29wRw5OtyRAmqDpDBVjaB5JT9WlOV6j3nXD2fHk0NcOIXPkxneqp48KgKsEMUugGM2Ppp3cD12n1fI9FVHVkyIGTF6eY92W0pYJOUH4v9BkNPQsZa45OaAlnetejwkfvghDGixyQ";

    expect(unseal(token, secret)).toEqual({
      version: 1,
      installId: "old-install",
      languages: ["eng", "hrv"],
      bestOnly: true,
      timing: "auto",
      sources: [{ kind: "stremio-addon", url: "https://opensubtitles-v3.strem.io/manifest.json" }],
      extras: { hideMismatches: false, dialogueOnly: false, foreignParts: false },
      useShared: true,
      share: true,
    });
  });

  it("refuses to seal an invalid config", () => {
    const config = { ...defaultConfig(["eng"]), languages: [] };

    expect(() => seal(config, secret)).toThrow(v.ValiError);
  });
});
