import { describe, expect, it } from "vitest";
import {
  databaseSchema,
  readEnvironment,
  readGroup,
  secretsSchema,
  sharedStateSchema,
  testsSchema,
} from "./env.ts";

const secret = "s".repeat(32);
const installSalt = "i".repeat(32);
const secrets = { SECRET: secret, INSTALL_SALT: installSalt };

describe("readEnvironment", () => {
  it("reads every group with its defaults", () => {
    expect(readEnvironment(secrets)).toEqual({
      server: { port: 7000, publicURL: undefined, trustProxy: false, allowLocalAddons: false },
      secrets: { secret, installSalt },
      sources: { openSubtitlesAppKey: undefined },
      database: { url: undefined, unpooledURL: undefined },
      sharedState: undefined,
    });
  });

  it("reads every variable it is given", () => {
    expect(
      readEnvironment({
        ...secrets,
        PORT: "8080",
        PUBLIC_URL: "https://subsontime.example",
        TRUST_PROXY: "1",
        ALLOW_LOCAL_ADDONS: "1",
        OPENSUBTITLES_APP_KEY: "app-key",
        DATABASE_URL: "postgres://pooled",
        DATABASE_URL_UNPOOLED: "postgres://direct",
        UPSTASH_REDIS_REST_URL: "http://localhost:8079",
        UPSTASH_REDIS_REST_TOKEN: "token",
      }),
    ).toEqual({
      server: {
        port: 8080,
        publicURL: "https://subsontime.example",
        trustProxy: true,
        allowLocalAddons: true,
      },
      secrets: { secret, installSalt },
      sources: { openSubtitlesAppKey: "app-key" },
      database: { url: "postgres://pooled", unpooledURL: "postgres://direct" },
      sharedState: { url: "http://localhost:8079", token: "token" },
    });
  });

  it("treats empty variables as unset", () => {
    const { sources, database, server } = readEnvironment({
      ...secrets,
      PUBLIC_URL: "",
      TRUST_PROXY: "",
      OPENSUBTITLES_APP_KEY: "",
      DATABASE_URL: "",
    });

    expect(server.publicURL).toBeUndefined();
    expect(server.trustProxy).toBe(false);
    expect(sources.openSubtitlesAppKey).toBeUndefined();
    expect(database.url).toBeUndefined();
  });

  it("enables a flag only for 1", () => {
    expect(readEnvironment({ ...secrets, TRUST_PROXY: "true" }).server.trustProxy).toBe(false);
  });

  it("throws when SECRET is missing", () => {
    expect(() => readEnvironment({ INSTALL_SALT: installSalt })).toThrow(
      "SECRET must be set to at least 32 characters",
    );
  });

  it("throws when SECRET is 31 characters", () => {
    expect(() => readEnvironment({ ...secrets, SECRET: "s".repeat(31) })).toThrow(
      "SECRET must be set to at least 32 characters",
    );
  });

  it("reports SECRET first when both secrets are missing", () => {
    expect(() => readEnvironment({})).toThrow("SECRET must be set to at least 32 characters");
  });

  it("throws when INSTALL_SALT is missing", () => {
    expect(() => readEnvironment({ SECRET: secret })).toThrow(
      "INSTALL_SALT must be set to at least 32 characters",
    );
  });

  it("throws when INSTALL_SALT is 31 characters", () => {
    expect(() => readEnvironment({ ...secrets, INSTALL_SALT: "i".repeat(31) })).toThrow(
      "INSTALL_SALT must be set to at least 32 characters",
    );
  });

  it("throws when INSTALL_SALT equals SECRET", () => {
    expect(() => readEnvironment({ SECRET: secret, INSTALL_SALT: secret })).toThrow(
      "INSTALL_SALT must differ from SECRET",
    );
  });
});

describe("sharedStateSchema", () => {
  it("is undefined without both a URL and a token", () => {
    expect(readGroup(sharedStateSchema, {})).toBeUndefined();
    expect(
      readGroup(sharedStateSchema, { UPSTASH_REDIS_REST_URL: "http://localhost:8079" }),
    ).toBeUndefined();
    expect(readGroup(sharedStateSchema, { UPSTASH_REDIS_REST_TOKEN: "token" })).toBeUndefined();
  });

  it("reads the Upstash variables", () => {
    expect(
      readGroup(sharedStateSchema, {
        UPSTASH_REDIS_REST_URL: "http://localhost:8079",
        UPSTASH_REDIS_REST_TOKEN: "token",
      }),
    ).toEqual({ url: "http://localhost:8079", token: "token" });
  });

  it("reads the Vercel KV variables", () => {
    expect(
      readGroup(sharedStateSchema, {
        KV_REST_API_URL: "http://localhost:8079",
        KV_REST_API_TOKEN: "token",
      }),
    ).toEqual({ url: "http://localhost:8079", token: "token" });
  });

  it("prefers each Upstash variable over its Vercel KV twin", () => {
    expect(
      readGroup(sharedStateSchema, {
        UPSTASH_REDIS_REST_URL: "http://upstash:8079",
        KV_REST_API_URL: "http://kv:8079",
        KV_REST_API_TOKEN: "kv-token",
      }),
    ).toEqual({ url: "http://upstash:8079", token: "kv-token" });
  });
});

describe("databaseSchema", () => {
  it("reads the pooled and the direct connection strings", () => {
    expect(
      readGroup(databaseSchema, {
        DATABASE_URL: "postgres://pooled",
        DATABASE_URL_UNPOOLED: "postgres://direct",
      }),
    ).toEqual({ url: "postgres://pooled", unpooledURL: "postgres://direct" });
  });
});

describe("testsSchema", () => {
  it("reads the test database", () => {
    expect(readGroup(testsSchema, { DATABASE_URL_TEST: "postgres://test" })).toEqual({
      databaseURL: "postgres://test",
    });
  });
});

describe("readGroup", () => {
  it("throws a plain error that leaves the rejected value out", () => {
    const failure = (() => {
      try {
        readGroup(secretsSchema, { SECRET: "rejected-secret", INSTALL_SALT: installSalt });
      } catch (error: unknown) {
        return error;
      }
    })();

    expect(failure).toEqual(new Error("SECRET must be set to at least 32 characters"));
    expect(Object.keys(failure as object)).toEqual([]);
  });
});
