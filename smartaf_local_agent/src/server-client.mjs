export class SmartAFServerClient {
  constructor({ baseUrl, homeId, agentId, token, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.homeId = homeId;
    this.agentId = agentId;
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async #request(path, { method = "GET", body, timeoutMs = 15_000 } = {}) {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await response.text();
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
}
