const minimumSecretLength = 32;

export function readSecret(env: NodeJS.ProcessEnv): string {
  const secret = env["SECRET"];

  if (secret === undefined || secret.length < minimumSecretLength) {
    throw new Error(`SECRET must be set to at least ${minimumSecretLength} characters`);
  }

  return secret;
}
