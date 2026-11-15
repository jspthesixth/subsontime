import * as v from "valibot";

export const minimumSecretLength = 32;
export const installSaltMessage = `INSTALL_SALT must be set to at least ${minimumSecretLength} characters`;

const text = v.pipe(
  v.optional(v.string()),
  v.transform((value) => value || undefined),
);

const secretText = (message: string) =>
  v.pipe(v.optional(v.string(), ""), v.minLength(minimumSecretLength, message));

export const serverSchema = v.pipe(
  v.object({
    PORT: v.optional(v.string()),
    PUBLIC_URL: text,
    TRUST_PROXY: v.optional(v.string()),
    ALLOW_LOCAL_ADDONS: v.optional(v.string()),
  }),
  v.transform(({ PORT, PUBLIC_URL, TRUST_PROXY, ALLOW_LOCAL_ADDONS }) => ({
    port: Number(PORT ?? 7000),
    publicURL: PUBLIC_URL,
    trustProxy: TRUST_PROXY === "1",
    allowLocalAddons: ALLOW_LOCAL_ADDONS === "1",
  })),
);

export const secretsSchema = v.pipe(
  v.object({
    SECRET: secretText(`SECRET must be set to at least ${minimumSecretLength} characters`),
    INSTALL_SALT: secretText(installSaltMessage),
  }),
  v.check(
    ({ SECRET, INSTALL_SALT }) => INSTALL_SALT !== SECRET,
    "INSTALL_SALT must differ from SECRET",
  ),
  v.transform(({ SECRET, INSTALL_SALT }) => ({ secret: SECRET, installSalt: INSTALL_SALT })),
);

export const sourcesSchema = v.pipe(
  v.object({ OPENSUBTITLES_APP_KEY: text }),
  v.transform(({ OPENSUBTITLES_APP_KEY }) => ({ openSubtitlesAppKey: OPENSUBTITLES_APP_KEY })),
);

export const databaseSchema = v.pipe(
  v.object({ DATABASE_URL: text, DATABASE_URL_UNPOOLED: text }),
  v.transform(({ DATABASE_URL, DATABASE_URL_UNPOOLED }) => ({
    url: DATABASE_URL,
    unpooledURL: DATABASE_URL_UNPOOLED,
  })),
);

export const sharedStateSchema = v.pipe(
  v.object({
    UPSTASH_REDIS_REST_URL: text,
    UPSTASH_REDIS_REST_TOKEN: text,
    KV_REST_API_URL: text,
    KV_REST_API_TOKEN: text,
  }),
  v.transform(
    ({ UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN, KV_REST_API_URL, KV_REST_API_TOKEN }) => {
      const url = UPSTASH_REDIS_REST_URL ?? KV_REST_API_URL;
      const token = UPSTASH_REDIS_REST_TOKEN ?? KV_REST_API_TOKEN;

      return url !== undefined && token !== undefined ? { url, token } : undefined;
    },
  ),
);

export const testsSchema = v.pipe(
  v.object({ DATABASE_URL_TEST: v.optional(v.string()) }),
  v.transform(({ DATABASE_URL_TEST }) => ({ databaseURL: DATABASE_URL_TEST })),
);

export const readGroup = <Schema extends v.GenericSchema>(
  schema: Schema,
  env: NodeJS.ProcessEnv,
): v.InferOutput<Schema> => {
  const result = v.safeParse(schema, env);

  if (!result.success) {
    throw new Error(result.issues[0].message);
  }

  return result.output;
};

export const readEnvironment = (env: NodeJS.ProcessEnv) => ({
  server: readGroup(serverSchema, env),
  secrets: readGroup(secretsSchema, env),
  sources: readGroup(sourcesSchema, env),
  database: readGroup(databaseSchema, env),
  sharedState: readGroup(sharedStateSchema, env),
});

export type Environment = ReturnType<typeof readEnvironment>;
