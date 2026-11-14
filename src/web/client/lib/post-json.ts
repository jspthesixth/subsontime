type Outcome = { result: unknown } | { error: string };

const unreachableMessage = "Could not reach Subs On Time. Try again.";

export const errorOf = (result: unknown) =>
  typeof result === "object" &&
  result !== null &&
  "error" in result &&
  typeof result.error === "string"
    ? result.error
    : unreachableMessage;

export const postJSON = async (path: string, body: unknown): Promise<Outcome> => {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
  const result: unknown = await response?.json().catch(() => undefined);

  return response?.ok === true ? { result } : { error: errorOf(result) };
};
