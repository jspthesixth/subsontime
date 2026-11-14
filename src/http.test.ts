import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createGuard, fetchWithTimeout, isPublicURL } from "./http.ts";

const strict = createGuard({ allowLocal: false });
const local = createGuard({ allowLocal: true });
const servers: Server[] = [];

const listen = async (handle: (request: IncomingMessage, response: ServerResponse) => void) => {
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    handle(request, response);
  });

  servers.push(server);

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address() as AddressInfo;

  return { requests, port, origin: `http://127.0.0.1:${port}` };
};

const redirectTo = (location: string) => (_: IncomingMessage, response: ServerResponse) => {
  response.writeHead(302, { location });
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
