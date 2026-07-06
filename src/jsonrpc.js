// Minimal JSON-RPC 2.0 HTTP client (no deps; Node >= 20 global fetch).

export class RpcError extends Error {
  constructor(message, { code = null, method = null, transport = false } = {}) {
    super(message);
    this.name = 'RpcError';
    this.code = code;
    this.method = method;
    // transport=true means "endpoint unreachable / bad response", i.e. the
    // fail-safe path: callers must queue work and wait, never pay.
    this.transport = transport;
  }
}

export function makeClient({ url, user = null, pass = null, timeoutMs = 30_000, extraHeaders = {} }) {
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (user !== null) {
    headers.Authorization = 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }

  return async function call(method, params = [], { walletPath = null } = {}) {
    const target = walletPath ? new URL(`wallet/${encodeURIComponent(walletPath)}`, url).href : url;
    let res;
    try {
      res = await fetch(target, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RpcError(`${method}: endpoint unreachable (${err.message})`, { method, transport: true });
    }
    let body;
    try {
      body = await res.json();
    } catch {
      throw new RpcError(`${method}: non-JSON response (HTTP ${res.status})`, { method, transport: true });
    }
    if (body.error) {
      throw new RpcError(`${method}: ${body.error.message}`, { method, code: body.error.code });
    }
    if (!res.ok) {
      throw new RpcError(`${method}: HTTP ${res.status}`, { method, transport: true });
    }
    return body.result;
  };
}
