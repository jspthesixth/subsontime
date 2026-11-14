import { describe, expect, it } from "vitest";
import { clientEntryPoints } from "../../scripts/build-client.ts";

describe("clientEntryPoints", () => {
  it("bundles every client script and leaves the tests out", () => {
    const entries = clientEntryPoints();

    expect(entries).toContain("src/web/client/check.ts");
    expect(entries).toContain("src/web/client/setup.ts");
    expect(entries).toContain("src/web/client/menu.ts");
    expect(entries).not.toContain("src/web/client/video-hash.test.ts");
    expect(entries.filter((entry) => entry.endsWith(".test.ts"))).toEqual([]);
  });
});
