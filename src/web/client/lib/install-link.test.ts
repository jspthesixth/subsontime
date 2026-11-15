import { describe, expect, it } from "vitest";
import { installLinkOf } from "./install-link.ts";

describe("installLinkOf", () => {
  it("builds the install link from the config in the fragment", () => {
    expect(installLinkOf("#config=AbC_-12", "https://subsontime.com")).toBe(
      "https://subsontime.com/AbC_-12/manifest.json",
    );
  });

  it.each(["", "#", "#config=", "#other=AbC"])("finds no install link in %j", (hash) => {
    expect(installLinkOf(hash, "https://subsontime.com")).toBeUndefined();
  });
});
