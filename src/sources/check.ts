import * as v from "valibot";

export type Verdict = "accepted" | "rejected" | "unreachable";

export const verdictOf = async (response: Response, schema: v.GenericSchema): Promise<Verdict> => {
  if (response.status === 401 || response.status === 403) {
    return "rejected";
  }

  if (!response.ok) {
    return "unreachable";
  }

  return v.safeParse(schema, await response.json().catch(() => undefined)).success
    ? "accepted"
    : "rejected";
};
