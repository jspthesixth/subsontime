import { describe, expect, it } from "vitest";
import {
  audioSchema,
  cliSchema,
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
      server: {
        port: 7000,
        publicURL: undefined,
        trustProxy: false,
        allowLocalAddons: false,
        onVercel: false,
      },
      secrets: { secret, installSalt },
      sources: {
        openSubtitlesAppKey: undefined,
        openSubtitlesDailyDownloads: 4,
        titloviUsername: undefined,
        titloviPassword: undefined,
        subdlAPIKey: undefined,
        subsourceAPIKey: undefined,
      },
      database: { url: undefined, unpooledURL: undefined },
      sharedState: undefined,
      dumps: { blobToken: undefined, cronSecret: undefined },
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
        VERCEL: "1",
        OPENSUBTITLES_APP_KEY: "app-key",
        OPENSUBTITLES_DAILY_DOWNLOADS: "95",
        TITLOVI_USERNAME: "titlovi-user",
        TITLOVI_PASSWORD: "titlovi-password",
        SUBDL_API_KEY: "subdl-key",
        SUBSOURCE_API_KEY: "subsource-key",
        DATABASE_URL: "postgres://pooled",
        DATABASE_URL_UNPOOLED: "postgres://direct",
        UPSTASH_REDIS_REST_URL: "http://localhost:8079",
        UPSTASH_REDIS_REST_TOKEN: "token",
        BLOB_READ_WRITE_TOKEN: "blob-token",
        CRON_SECRET: "cron-secret",
      }),
    ).toEqual({
      server: {
        port: 8080,
        publicURL: "https://subsontime.example",
        trustProxy: true,
        allowLocalAddons: true,
        onVercel: true,
      },
      secrets: { secret, installSalt },
      sources: {
        openSubtitlesAppKey: "app-key",
        openSubtitlesDailyDownloads: 95,
        titloviUsername: "titlovi-user",
        titloviPassword: "titlovi-password",
        subdlAPIKey: "subdl-key",
        subsourceAPIKey: "subsource-key",
      },
      database: { url: "postgres://pooled", unpooledURL: "postgres://direct" },
      sharedState: { url: "http://localhost:8079", token: "token" },
      dumps: { blobToken: "blob-token", cronSecret: "cron-secret" },
    });
  });

  it("treats empty variables as unset", () => {
    const { sources, database, server, dumps } = readEnvironment({
      ...secrets,
      PORT: "",
      PUBLIC_URL: "",
      TRUST_PROXY: "",
      OPENSUBTITLES_APP_KEY: "",
      DATABASE_URL: "",
      BLOB_READ_WRITE_TOKEN: "",
      CRON_SECRET: "",
    });

    expect(server.port).toBe(7000);
    expect(server.publicURL).toBeUndefined();
    expect(server.trustProxy).toBe(false);
    expect(sources.openSubtitlesAppKey).toBeUndefined();
    expect(database.url).toBeUndefined();
    expect(dumps).toEqual({ blobToken: undefined, cronSecret: undefined });
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

  it("rejects a daily download limit that is not a whole number", () => {
    expect(() => readEnvironment({ ...secrets, OPENSUBTITLES_DAILY_DOWNLOADS: "four" })).toThrow(
      "OPENSUBTITLES_DAILY_DOWNLOADS must be a whole number",
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

describe("cliSchema", () => {
  it("reads the CLI and platform variables", () => {
    expect(
      readGroup(cliSchema, {
        NO_COLOR: "1",
        SUBSONTIME_CONFIG_DIR: "/config/subsontime",
        APPDATA: "C:\\AppData",
        XDG_CONFIG_HOME: "/xdg",
      }),
    ).toEqual({
      noColor: true,
      configDir: "/config/subsontime",
      appData: "C:\\AppData",
      xdgConfigHome: "/xdg",
    });
  });

  it("keeps color without NO_COLOR", () => {
    expect(readGroup(cliSchema, { NO_COLOR: "" }).noColor).toBe(false);
  });
});

describe("audioSchema", () => {
  it("reads the ffmpeg and ffprobe paths", () => {
    expect(
      readGroup(audioSchema, {
        SUBSONTIME_FFMPEG: "/opt/ffmpeg",
        SUBSONTIME_FFPROBE: "/opt/ffprobe",
      }),
    ).toEqual({ ffmpeg: "/opt/ffmpeg", ffprobe: "/opt/ffprobe" });
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
