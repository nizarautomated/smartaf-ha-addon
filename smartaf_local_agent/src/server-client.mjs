export class SmartAFServerClient {
  constructor({ baseUrl, homeId, agentId, token, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.homeId = homeId;
    this.agentId = agentId;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async #request(path, { method = "GET", body, timeoutMs = 15_000, maximumBytes, rejectRedirects = false } = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(rejectRedirects ? { redirect: 'error' } : {}),
      signal: AbortSignal.timeout(timeoutMs)
    });
    let text;
    if (maximumBytes && response.body?.getReader) {
      const reader = response.body.getReader(), chunks = []; let bytes = 0;
      try {
        while (true) { const { done, value } = await reader.read(); if (done) break; bytes += value.length; if (bytes > maximumBytes) { await reader.cancel(); throw Object.assign(new Error('Supportantwoord te groot'), {code:'support_response_too_large'}); } chunks.push(Buffer.from(value)); }
      } finally { reader.releaseLock(); }
      text = Buffer.concat(chunks).toString('utf8');
    } else text = await response.text();
    if (maximumBytes && Buffer.byteLength(text) > maximumBytes) throw Object.assign(new Error('Supportantwoord te groot'), {code:'support_response_too_large'});
    let value = {};
    try {
      value = text ? JSON.parse(text) : {};
    } catch {
      throw Object.assign(new Error("SmartAF-server gaf ongeldige JSON"), { code: "invalid_server_response", status: response.status });
    }
    if (!response.ok) throw Object.assign(new Error(value.message || `SmartAF-serverfout ${response.status}`), { code: value.error || "server_error", status: response.status });
    return value;
  }

  sendEvent(event) {
    return this.#request("/v1/events", { method: "POST", body: event });
  }

  heartbeat(input) {
    return this.#request(`/v1/agents/${this.homeId}/heartbeat`, { method: "POST", body: input });
  }

  async claimCommands(limit = 20) {
    const result = await this.#request(`/v1/agents/${this.homeId}/commands?limit=${Math.max(1, Math.min(50, limit))}`);
    return Array.isArray(result.commands) ? result.commands : [];
  }

  acknowledge(input) {
    return this.#request(`/v1/agents/${this.homeId}/acknowledgements`, { method: "POST", body: input });
  }

  supportExchange(input) {
    if (Buffer.byteLength(JSON.stringify(input)) > 300_000) throw Object.assign(new Error('Supportaanvraag te groot'), {code:'support_request_too_large'});
    return this.#request(`/v1/agents/${this.homeId}/support/exchange`, { method: 'POST', body: input, timeoutMs: 5_000, maximumBytes: 300_000, rejectRedirects: true });
  }
}
