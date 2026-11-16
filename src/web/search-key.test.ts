import { expect, it } from "vitest";
import { searchKey } from "./search-key.ts";

it("folds marks, ligatures and case", () => {
  expect(searchKey("ﬁlm Čovjek")).toBe("film covjek");
});
