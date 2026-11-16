import type { Context } from "hono";

export const baseURL = (context: Context, publicURL: string | undefined, trustProxy?: boolean) => {
  const [proto] = context.req.header("x-forwarded-proto")?.split(",") ?? [];

  const [host] = context.req.header("x-forwarded-host")?.split(",") ?? [];

  if (publicURL !== undefined) {
    return publicURL.replace(/\/+$/, "");
  }

  return trustProxy === true && proto !== undefined && host !== undefined
    ? `${proto.trim()}://${host.trim()}`
    : new URL(context.req.url).origin;
};
