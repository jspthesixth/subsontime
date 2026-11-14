import { expect, test } from "vitest";
import { TimingsInputError } from "./api.ts";
import { readInstallSalt, submitterOf } from "./submitter.ts";

const salt = "s".repeat(32);
const installId = "6f1c2b9e-4d3a-4f5e-9a8b-7c6d5e4f3a2b";

test("readInstallSalt throws when INSTALL_SALT is missing", () => {
  expect(() => readInstallSalt({})).toThrow("INSTALL_SALT must be set to at least 32 characters");
});

test("readInstallSalt throws when INSTALL_SALT is 31 characters", () => {
  expect(() => readInstallSalt({ INSTALL_SALT: "a".repeat(31) })).toThrow(
    "INSTALL_SALT must be set to at least 32 characters",
  );
});

test("readInstallSalt returns INSTALL_SALT when it is 32 characters", () => {
  expect(readInstallSalt({ INSTALL_SALT: salt })).toBe(salt);
});

test("submitterOf is 32 hex characters and stable", () => {
  const submitter = submitterOf(installId, salt);

  expect(submitter).toMatch(/^[0-9a-f]{32}$/);
  expect(submitterOf(installId, salt)).toBe(submitter);
});

test("submitterOf is sha256 of the install id and the salt", () => {
  expect(submitterOf(installId, salt)).toBe("0ce5fd74b39ffa83c360ec154a18edb5");
});

test("submitterOf differs per salt", () => {
  expect(submitterOf(installId, "t".repeat(32))).not.toBe(submitterOf(installId, salt));
});

test("submitterOf ignores the letter case of the install id", () => {
  expect(submitterOf(installId.toUpperCase(), salt)).toBe(submitterOf(installId, salt));
});

test("submitterOf rejects an install id that is not a UUID", () => {
  expect(() => submitterOf("my-laptop", salt)).toThrow(TimingsInputError);
  expect(() => submitterOf("my-laptop", salt)).toThrow("Send installId as a UUID");
});

test("submitterOf rejects a salt under 32 characters", () => {
  expect(() => submitterOf(installId, "short")).toThrow(
    "INSTALL_SALT must be set to at least 32 characters",
  );
});
