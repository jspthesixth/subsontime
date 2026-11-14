import { describe, expect, it } from "vitest";
import { clientEntryPoints } from "../../scripts/build-client.ts";

describe("clientEntryPoints", () => {
  it("bundles every page script and leaves out tests and shared helpers", () => {
    const entries = clientEntryPoints();

    expect(entries).toContain("src/web/client/check.ts");
    expect(entries).toContain("src/web/client/setup.ts");
    expect(entries).toContain("src/web/client/menu.ts");
    expect(entries.filter((entry) => entry.endsWith(".test.ts"))).toEqual([]);
    expect(entries.filter((entry) => entry.includes("/lib/"))).toEqual([]);
  });
});
