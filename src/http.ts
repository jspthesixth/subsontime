import { lookup, type LookupAddress, type LookupAllOptions } from "node:dns";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { Agent, type Dispatcher } from "undici";
import { readGroup, serverSchema } from "./config/env.ts";

type Resolve = (
  hostname: string,
  options: LookupAllOptions,
  callback: (error: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

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
  ["::", 96],
  ["64:ff9b::", 96],
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
  const host = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  const localName = host === "localhost" || host.endsWith(".localhost");

  if (allowLocal && url.protocol === "http:" && localHosts.has(host)) {
    return true;
  }

  if (url.protocol !== "https:" || localName) {
    return false;
  }

  return isIP(host) === 0 || !isBlockedAddress(host, false);
};

export const isPublicURL = (text: string, allowLocal: boolean) =>
  URL.canParse(text) && isAllowedURL(new URL(text), allowLocal);

const guardedLookup =
  (allowLocal: boolean, resolve: Resolve): LookupFunction =>
  (hostname, options, callback) => {
    resolve(hostname, { ...options, all: true }, (error, addresses) => {
      if (error !== null) {
        callback(error, "", 0);

        return;
      }

      const first = addresses[0];

      if (
        first === undefined ||
        addresses.some(({ address }) => isBlockedAddress(address, allowLocal))
      ) {
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

export const createGuard = ({
  allowLocal,
  resolve = lookup,
}: {
  allowLocal: boolean;
  resolve?: Resolve;
}): Guard => ({
  allowLocal,
  dispatcher: new Agent({ connect: { lookup: guardedLookup(allowLocal, resolve) } }),
});

export const allowLocalAddons = readGroup(serverSchema, process.env).allowLocalAddons;

const defaultGuard = createGuard({ allowLocal: allowLocalAddons });

const blockedCause = (error: unknown) =>
  error instanceof Error && error.cause instanceof BlockedAddressError ? error.cause : error;

const credentialHeaders = ["authorization", "proxy-authorization", "cookie"];

const switchesToGet = (status: number, method: string) =>
  status === 303 || ((status === 301 || status === 302) && method === "POST");

const nextInit = (init: RequestInit, status: number, from: URL, to: URL): RequestInit => {
  const headers = new Headers(init.headers);
  const toGet = switchesToGet(status, (init.method ?? "GET").toUpperCase());
  const dropped = [
    ...(from.origin === to.origin ? [] : credentialHeaders),
    ...(toGet ? [...headers.keys()].filter((name) => name.startsWith("content-")) : []),
  ];

  dropped.forEach((name) => headers.delete(name));

  return toGet ? { ...init, headers, method: "GET", body: undefined } : { ...init, headers };
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

const readLimited = async (response: Response, maxBytes: number) => {
  const chunks: Uint8Array[] = [];
  let total = 0;

  for await (const chunk of response.body ?? []) {
    total += chunk.byteLength;

    if (total > maxBytes) {
      throw new Error("Response too large");
    }

    chunks.push(chunk);
  }

  return new Response(total === 0 ? null : Buffer.concat(chunks), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

export const fetchWithTimeout = async (
  url: string,
  { maxBytes, ...init }: RequestInit & { maxBytes?: number },
  timeoutMs: number,
  guard: Guard = defaultGuard,
) => {
  const response = await fetchHop(
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

  if (maxBytes === undefined) {
    return response;
  }

  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) {
    await response.body?.cancel();

    throw new Error("Response too large");
  }

  return readLimited(response, maxBytes);
};
