import { describe, expect, it } from "vitest";
import { addressKey } from "./client-key.ts";

describe("addressKey", () => {
  it("keeps an IPv4 address as it is", () => {
    expect(addressKey("203.0.113.7")).toBe("203.0.113.7");
  });

  it.each([
    ["2001:db8:1:2:aaaa:bbbb:cccc:dddd", "2001:db8:1:2::/64"],
    ["2001:db8:1:2::1", "2001:db8:1:2::/64"],
    ["2001:0DB8:0001:0002:0:0:0:9", "2001:db8:1:2::/64"],
    ["2001:db8::1", "2001:db8:0:0::/64"],
    ["::1", "0:0:0:0::/64"],
    ["fe80::1%eth0", "fe80:0:0:0::/64"],
    ["64:ff9b::192.0.2.1", "64:ff9b:0:0::/64"],
  ])("keys the IPv6 address %s by its /64 prefix", (address, key) => {
    expect(addressKey(address)).toBe(key);
  });

  it("keys an IPv4-mapped IPv6 address by its IPv4 address", () => {
    expect(addressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("gives two addresses in one /64 the same key", () => {
    expect(addressKey("2001:db8:1:2::a")).toBe(addressKey("2001:db8:1:2:ffff::b"));
  });
});
