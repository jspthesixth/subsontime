import { describe, expect, it } from "vitest";
import { analyticsEvent, redactedPath } from "./analytics-event.ts";

const sealed = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-AbCdEf";

describe("redactedPath", () => {
  it.each([
    [`/${sealed}/manifest.json`, "/<config>/manifest.json"],
    [`/${sealed}/configure`, "/<config>/configure"],
    [`/${sealed}/sub/ref.srt`, "/<config>/sub/ref.srt"],
    [`/${sealed}/subtitles/movie/tt0111161`, "/<config>/subtitles/movie/tt0111161"],
    ["/stremio", "/stremio"],
  ])("turns %s into %s", (pathname, expected) => {
    expect(redactedPath(pathname)).toBe(expected);
  });
});

describe("analyticsEvent", () => {
  it.each(["/", "/stremio", "/check", "/timings"])("sends a visit to %s", (path) => {
    expect(analyticsEvent({ type: "pageview", url: `https://subsontime.com${path}` })).toEqual({
      type: "pageview",
      url: `https://subsontime.com${path}`,
    });
  });

  it("drops the query string and the fragment", () => {
    expect(
      analyticsEvent({
        type: "pageview",
        url: `https://subsontime.com/stremio?config=${sealed}#config=${sealed}`,
      }),
    ).toEqual({ type: "pageview", url: "https://subsontime.com/stremio" });
  });

  it("drops the query string from the route of a vital", () => {
    expect(
      analyticsEvent({
        type: "vital",
        url: "https://subsontime.com/check?id=1",
        route: "/check?id=1",
      }),
    ).toEqual({ type: "vital", url: "https://subsontime.com/check", route: "/check" });
  });

  it.each([
    `/${sealed}/manifest.json`,
    `/${sealed}/configure`,
    `/${sealed}/sub/ref.srt`,
    `/${sealed}/subtitles/movie/tt0111161`,
    `/${sealed}`,
    "/api/config",
    "/health",
    "/stremio/",
  ])("drops %s", (path) => {
    expect(analyticsEvent({ type: "pageview", url: `https://subsontime.com${path}` })).toBeNull();
  });
});
