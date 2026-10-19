import http from 'node:http';
import { CONSENT_LIMITS, SupportConsentController } from './support-consent.mjs';

const UNIQUE_HEADERS = new Set(['host', 'origin', 'referer', 'cookie', 'content-type', 'content-length', 'x-hass-source', 'x-ingress-path', 'x-remote-user-id', 'x-support-csrf', 'sec-fetch-site']);
function failure(response, status, error) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'connection': 'close', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify({ error }));
}

// Separate adapter permits exercising the actual HTTP boundary without a
// test-only trust bypass. Production peer identity comes only from the socket.
export function createSupportConsentHandler(controller) {
  if (!(controller instanceof SupportConsentController)) throw new TypeError('Consent controller required');
  return async (request, response) => {
    try {
      const seen = new Set();
      for (let index = 0; index < request.rawHeaders.length; index += 2) {
        const name = request.rawHeaders[index].toLowerCase();
        if (UNIQUE_HEADERS.has(name) && seen.has(name)) return failure(response, 400, 'ambiguous_header');
        seen.add(name);
      }
      // Reject direct callers before reading their bodies or inspecting identity.
      if (!['172.30.32.2', '::ffff:172.30.32.2'].includes(request.socket.remoteAddress)) return failure(response, 403, 'ingress_peer_required');
      const declared = request.headers['content-length'];
      if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > CONSENT_LIMITS.bodyBytes)) return failure(response, 413, 'body_too_large');
      if (request.headers['content-encoding'] !== undefined || (request.method !== 'POST' && (request.headers['transfer-encoding'] !== undefined || Number(declared ?? 0) > 0))) return failure(response, 400, 'unexpected_body');
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > CONSENT_LIMITS.bodyBytes) return failure(response, 413, 'body_too_large');
        chunks.push(chunk);
      }
      const result = controller.handle({ method: request.method, path: request.url, headers: request.headers, remoteAddress: request.socket.remoteAddress, rawBody: Buffer.concat(chunks).toString('utf8') });
      response.writeHead(result.status, result.headers); response.end(result.body);
    } catch {
      if (!response.headersSent) failure(response, 400, 'invalid_request');
      else response.destroy();
    }
  };
}

// Creating does not listen. Integration must explicitly listen only on the
// unexposed Ingress port; never add a host-port mapping or public reverse proxy.
export function createSupportConsentServer({ controller } = {}) {
  const server = http.createServer({ maxHeaderSize: 8_192, requestTimeout: 10_000, headersTimeout: 5_000, keepAliveTimeout: 1_000 }, createSupportConsentHandler(controller));
  server.maxHeadersCount = 32; server.maxConnections = 32;
  server.on('clientError', (_error, socket) => { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  return server;
}
