import { request } from 'node:https';

/**
 * `fetch` for a hub whose `https://` certificate cannot be verified
 * (hubs typically present a self-signed one): the same request over
 * `node:https` with certificate verification off. Global `fetch` has
 * no per-call switch for that. Covers what `ReolinkClient` sends: a
 * string body, plain headers and an abort signal. `http://` URLs go
 * to the global `fetch` unchanged.
 */
export const fetchSkippingTlsVerify: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  if (!url.startsWith('https:')) return fetch(input, init);
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: init?.method ?? 'GET',
        headers: init?.headers as Record<string, string> | undefined,
        rejectUnauthorized: false,
        ...(init?.signal && { signal: init.signal }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('error', reject);
        res.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') headers.set(name, value);
          }
          resolve(
            new Response(chunks.length > 0 ? Buffer.concat(chunks) : null, {
              status: res.statusCode ?? 500,
              headers,
            }),
          );
        });
      },
    );
    req.on('error', reject);
    req.end(init?.body as string | undefined);
  });
};
