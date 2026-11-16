import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuard, fetchWithTimeout, isPublicURL } from "./http.ts";

const strict = createGuard({ allowLocal: false });
const local = createGuard({ allowLocal: true });
const servers: Server[] = [];

const listen = async (handle: (request: IncomingMessage, response: ServerResponse) => void) => {
  const requests: { method?: string; headers: IncomingHttpHeaders; body: string }[] = [];
  const server = createServer(async (request, response) => {
    const body = await text(request);

    requests.push({ method: request.method, headers: request.headers, body });
    handle(request, response);
  });

  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;

  return { requests, port, origin: `http://127.0.0.1:${port}` };
};

const redirectTo =
  (location: string, status = 302) =>
  (_: IncomingMessage, response: ServerResponse) => {
    response.writeHead(status, { location });
    response.end();
  };

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

describe("fetchWithTimeout guard", () => {
  it.each([
    ["http://example.com/manifest.json"],
    ["https://127.0.0.1/"],
    ["https://10.0.0.5/"],
    ["https://172.16.0.1/"],
    ["https://192.168.1.1/"],
    ["https://100.64.0.1/"],
    ["https://0.0.0.0/"],
    ["https://169.254.169.254/latest/meta-data"],
    ["https://[::1]/"],
    ["https://[::ffff:127.0.0.1]/"],
    ["https://[fe80::1]/"],
    ["https://[fc00::1]/"],
    ["https://2130706433/"],
    ["file:///etc/passwd"],
    ["https://[64:ff9b::7f00:1]/"],
    ["https://[::7f00:1]/"],
    ["https://[::a00:5]/"],
  ])("blocks %s", async (url) => {
    await expect(fetchWithTimeout(url, {}, 1000, strict)).rejects.toThrow("Blocked address");
  });

  it.each([
    ["https://104.17.89.107/manifest.json"],
    ["https://[2606:4700::6811:586b]/manifest.json"],
    ["https://opensubtitles-v3.strem.io/manifest.json"],
  ])("allows the public address %s", (url) => {
    expect(isPublicURL(url, false)).toBe(true);
  });

  it.each([
    ["https://224.0.0.1/"],
    ["https://240.0.0.1/"],
    ["https://255.255.255.255/"],
    ["https://192.0.0.8/"],
    ["https://198.18.0.1/"],
    ["https://[ff02::1]/"],
    ["https://[2002:a00:1::]/"],
    ["https://[2001:0:4136:e378::1]/"],
    ["https://[2001:db8::1]/"],
  ])("does not count %s as public", (url) => {
    expect(isPublicURL(url, false)).toBe(false);
  });

  it("blocks a host that resolves to a 6to4 address", async () => {
    const tunnel = createGuard({
      allowLocal: false,
      resolve: (_hostname, _options, callback) =>
        callback(null, [{ address: "2002:a00:1::", family: 6 }]),
    });

    await expect(fetchWithTimeout("https://example.test/", {}, 1000, tunnel)).rejects.toThrow(
      "Blocked address",
    );
  });

  it("blocks a hostname that resolves to a loopback address", async () => {
    const { port, requests } = await listen((_, response) => response.end("secret"));

    await expect(fetchWithTimeout(`https://localhost:${port}/`, {}, 1000, strict)).rejects.toThrow(
      "Blocked address",
    );
    expect(requests).toEqual([]);
  });

  it("blocks a local http address unless local addons are allowed", async () => {
    const { origin } = await listen((_, response) => response.end("local"));

    await expect(fetchWithTimeout(`${origin}/`, {}, 1000, strict)).rejects.toThrow(
      "Blocked address",
    );

    const response = await fetchWithTimeout(`${origin}/`, {}, 1000, local);

    expect(await response.text()).toBe("local");
  });

  it("blocks a redirect to a private address", async () => {
    const { origin, requests } = await listen(redirectTo("https://10.0.0.5/subtitle.srt"));

    await expect(fetchWithTimeout(`${origin}/`, {}, 1000, local)).rejects.toThrow(
      "Blocked address",
    );
    expect(requests).toHaveLength(1);
  });

  it("follows up to three redirects and drops the authorization across origins", async () => {
    const target = await listen((_, response) => response.end("final"));
    const hop = await listen(redirectTo(`${target.origin}/final`));

    const response = await fetchWithTimeout(
      `${hop.origin}/`,
      { headers: { Authorization: "Bearer token" } },
      1000,
      local,
    );

    expect(await response.text()).toBe("final");
    expect(hop.requests[0]?.headers.authorization).toBe("Bearer token");
    expect(target.requests[0]?.headers.authorization).toBeUndefined();
  });

  it("stops after three redirects", async () => {
    const loop = await listen(redirectTo("/again"));

    await expect(fetchWithTimeout(`${loop.origin}/`, {}, 1000, local)).rejects.toThrow(
      "Too many redirects",
    );
    expect(loop.requests).toHaveLength(4);
  });
});

describe("fetchWithTimeout lookups", () => {
  it("rejects a host that does not resolve without crashing the process", async () => {
    const uncaught = vi.fn<(error: Error) => void>();

    process.on("uncaughtException", uncaught);

    try {
      await expect(
        fetchWithTimeout("https://does-not-exist.invalid/manifest.json", {}, 3000, strict),
      ).rejects.toThrow("fetch failed");
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      process.off("uncaughtException", uncaught);
    }

    expect(uncaught).not.toHaveBeenCalled();
  });

  it("blocks a host whose lookup returns no address", async () => {
    const empty = createGuard({
      allowLocal: false,
      resolve: (_hostname, _options, callback) => callback(null, []),
    });

    await expect(fetchWithTimeout("https://example.test/", {}, 1000, empty)).rejects.toThrow(
      "Blocked address",
    );
  });

  it.each([[["127.0.0.1"]], [["93.184.215.14", "10.0.0.5"]]])(
    "blocks a host that resolves to %j before connecting",
    async (addresses) => {
      const { port, requests } = await listen((_, response) => response.end("secret"));

      const resolving = createGuard({
        allowLocal: false,
        resolve: (_hostname, _options, callback) =>
          callback(
            null,
            addresses.map((address) => ({ address, family: 4 })),
          ),
      });

      await expect(
        fetchWithTimeout(`https://example.test:${port}/`, {}, 1000, resolving),
      ).rejects.toThrow("Blocked address");
      expect(requests).toEqual([]);
    },
  );

  it("connects to the address the lookup gives for a hostname", async () => {
    const { port } = await listen((_, response) => response.end("local"));

    const resolve = vi.fn<NonNullable<Parameters<typeof createGuard>[0]["resolve"]>>(
      (_hostname, _options, callback) => callback(null, [{ address: "127.0.0.1", family: 4 }]),
    );
    const resolving = createGuard({ allowLocal: true, resolve });
    const response = await fetchWithTimeout(`http://localhost:${port}/`, {}, 1000, resolving);

    expect(await response.text()).toBe("local");
    expect(resolve).toHaveBeenCalledWith("localhost", expect.anything(), expect.any(Function));
  });
});

describe("fetchWithTimeout redirects", () => {
  it.each([
    [301, "POST", "GET", ""],
    [302, "POST", "GET", ""],
    [303, "PUT", "GET", ""],
    [302, "PUT", "PUT", "payload"],
    [307, "POST", "POST", "payload"],
  ])("a %i after %s continues as %s", async (status, method, nextMethod, nextBody) => {
    const target = await listen((_, response) => response.end("final"));
    const hop = await listen(redirectTo(`${target.origin}/final`, status));

    await fetchWithTimeout(
      `${hop.origin}/`,
      { method, body: "payload", headers: { "Content-Type": "text/plain" } },
      1000,
      local,
    );

    expect(target.requests[0]).toMatchObject({ method: nextMethod, body: nextBody });
    expect(target.requests[0]?.headers["content-type"]).toBe(
      nextBody === "" ? undefined : "text/plain",
    );
  });

  it("drops credentials and cookies across origins", async () => {
    const target = await listen((_, response) => response.end("final"));
    const hop = await listen(redirectTo(`${target.origin}/final`));

    await fetchWithTimeout(
      `${hop.origin}/`,
      {
        headers: {
          Authorization: "Bearer token",
          "Proxy-Authorization": "Basic secret",
          Cookie: "session=1",
          Accept: "application/json",
        },
      },
      1000,
      local,
    );

    expect(target.requests[0]?.headers).toMatchObject({ accept: "application/json" });
    expect(target.requests[0]?.headers).not.toHaveProperty("authorization");
    expect(target.requests[0]?.headers).not.toHaveProperty("proxy-authorization");
    expect(target.requests[0]?.headers).not.toHaveProperty("cookie");
  });
});

describe("fetchWithTimeout maxBytes", () => {
  const body = "x".repeat(3000);

  it("returns a body within the limit unchanged", async () => {
    const { origin } = await listen((_, response) => response.end(body));

    const response = await fetchWithTimeout(`${origin}/`, { maxBytes: 3000 }, 1000, local);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
  });

  it.each([
    ["with a length header", (response: ServerResponse) => response.end(body)],
    [
      "streamed without a length",
      (response: ServerResponse) => {
        response.write(body.slice(0, 1000));
        setTimeout(() => response.end(body.slice(1000)), 20);
      },
    ],
  ])("throws past the limit %s", async (_, send) => {
    const { origin } = await listen((__, response) => send(response));

    await expect(fetchWithTimeout(`${origin}/`, { maxBytes: 2999 }, 1000, local)).rejects.toThrow(
      "Response too large",
    );
  });
});
