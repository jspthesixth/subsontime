import { describe, expect, it } from "vitest";
import { memoryStore, type TimingsStore } from "../timings/db.ts";
import { appWith, budgetMs, firstURL, hanging, installed, retimedSources } from "./test-app.ts";

describe("reading Open Timings", () => {
  it("answers within the read budget when the store hangs", async () => {
    const hangingStore: TimingsStore = {
      ...memoryStore(),
      fixesFor: hanging,
      mismatchesFor: hanging,
      reportsFor: hanging,
    };
    const { token } = installed({ share: false });

    const timed = async (store: TimingsStore) => {
      const app = appWith(retimedSources(), store);
      const listingStarted = performance.now();
      const url = await firstURL(app, token);
      const fileStarted = performance.now();
      const text = await (await app.request(url)).text();

      return {
        listingMs: fileStarted - listingStarted,
        fileMs: performance.now() - fileStarted,
        text,
      };
    };

    const normal = await timed(memoryStore());
    const hung = await timed(hangingStore);

    expect(hung.text).toBe(normal.text);
    expect(hung.listingMs).toBeLessThan(normal.listingMs + budgetMs + 150);
    expect(hung.fileMs).toBeLessThan(normal.fileMs + budgetMs + 150);
  });
});
