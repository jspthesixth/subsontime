import { sealedConfigPattern } from "../../../config/sealed-config.ts";

const pagePaths = new Set(["/", "/stremio", "/check", "/timings"]);

export const redactedPath = (pathname: string) =>
  pathname
    .split("/")
    .map((segment) => (sealedConfigPattern.test(segment) ? "<config>" : segment))
    .join("/");

export const analyticsEvent = <Event extends { url: string; route?: string }>(
  event: Event,
): Event | null => {
  const { origin, pathname } = new URL(event.url);

  const path = redactedPath(pathname);

  if (!pagePaths.has(path)) {
    return null;
  }

  return {
    ...event,
    url: `${origin}${path}`,
    ...(event.route === undefined ? {} : { route: path }),
  };
};
