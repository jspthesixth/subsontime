export const fetchWithTimeout = (url: string, init: RequestInit, timeoutMs: number) =>
  fetch(url, {
    ...init,
    signal: AbortSignal.any([
      AbortSignal.timeout(timeoutMs),
      ...(init.signal ? [init.signal] : []),
    ]),
  });
