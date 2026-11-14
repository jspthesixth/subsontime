import { lookup } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, type Dispatcher } from "undici";

export type Guard = { allowLocal: boolean; dispatcher: Dispatcher };

class BlockedAddressError extends Error {
  constructor() {
    super("Blocked address");
  }
}

const maximumRedirects = 3;
const redirectStatuses = new Set([301, 302, 303, 307, 308]);
const localHosts = new Set(["localhost", "127.0.0.1"]);

const blocked = new BlockList();
const loopback = new BlockList();

[
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
].forEach(([network, prefix]) => blocked.addSubnet(String(network), Number(prefix), "ipv4"));

[
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
].forEach(([network, prefix]) => blocked.addSubnet(String(network), Number(prefix), "ipv6"));

loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");

const isBlockedAddress = (address: string, allowLocal: boolean) => {
  const type = isIP(address) === 6 ? "ipv6" : "ipv4";

  return blocked.check(address, type) && !(allowLocal && loopback.check(address, type));
};

const isAllowedURL = (url: URL, allowLocal: boolean) => {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const local = allowLocal && url.protocol === "http:" && localHosts.has(host);

  if (local) {
    return true;
  }

  return url.protocol === "https:" && (isIP(host) === 0 || !isBlockedAddress(host, false));
};

export const isPublicURL = (text: string, allowLocal: boolean) =>
  URL.canParse(text) && isAllowedURL(new URL(text), allowLocal);

const guardedLookup =
  (allowLocal: boolean): LookupFunction =>
  (hostname, options, callback) => {
    lookup(hostname, { ...options, all: true }, (error, addresses) => {
      const first = addresses[0];

      if (error !== null || first === undefined) {
        callback(error ?? new Error(`Could not resolve ${hostname}`), "", 0);

        return;
      }

      if (addresses.some(({ address }) => isBlockedAddress(address, allowLocal))) {
        callback(new BlockedAddressError(), "", 0);

        return;
      }

      if (options.all === true) {
        callback(null, addresses);

        return;
      }

      callback(null, first.address, first.family);
    });
  };

export const createGuard = ({ allowLocal }: { allowLocal: boolean }): Guard => ({
  allowLocal,
  dispatcher: new Agent({ connect: { lookup: guardedLookup(allowLocal) } }),
});

const defaultGuard = createGuard({ allowLocal: process.env["ALLOW_LOCAL_ADDONS"] === "1" });

const blockedCause = (error: unknown) =>
  error instanceof Error && error.cause instanceof BlockedAddressError ? error.cause : error;

const nextInit = (init: RequestInit, status: number, from: URL, to: URL): RequestInit => {
  const headers = new Headers(init.headers);
  const keepsBody = status === 307 || status === 308;

  if (from.origin !== to.origin) {
    headers.delete("authorization");
  }

  return keepsBody ? { ...init, headers } : { ...init, headers, method: "GET", body: undefined };
};

const fetchHop = async (
  url: URL,
  init: RequestInit,
  guard: Guard,
  redirects: number,
): Promise<Response> => {
  if (!isAllowedURL(url, guard.allowLocal)) {
    throw new BlockedAddressError();
  }

  const guarded = { ...init, redirect: "manual" as const, dispatcher: guard.dispatcher };
  const response = await fetch(url.href, guarded).catch((error: unknown) => {
    throw blockedCause(error);
  });
  const location = response.headers.get("location");

  if (!redirectStatuses.has(response.status) || location === null) {
    return response;
  }

  await response.body?.cancel();

  if (redirects >= maximumRedirects) {
    throw new Error("Too many redirects");
  }

  const next = new URL(location, url);

  return fetchHop(next, nextInit(init, response.status, url, next), guard, redirects + 1);
};

export const fetchWithTimeout = (
  url: string,
  init: RequestInit,
  timeoutMs: number,
  guard: Guard = defaultGuard,
) =>
  fetchHop(
    new URL(url),
    {
      ...init,
      signal: AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        ...(init.signal ? [init.signal] : []),
      ]),
    },
    guard,
    0,
  );
