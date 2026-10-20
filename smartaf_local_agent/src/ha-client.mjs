import { createSolarHistoryRequest } from './solar-history.mjs';
export class HomeAssistantWebSocketClient {
  constructor({ url, token, WebSocketImpl = globalThis.WebSocket } = {}) {
    if (!WebSocketImpl) throw new Error("WebSocket-ondersteuning ontbreekt");
    this.url = url;
    this.token = token;
    this.WebSocketImpl = WebSocketImpl;
    this.nextId = 1;
    this.pending = new Map();
    this.subscriptions = new Map();
    this.connected = false;
  }

  connect() {
    if (this.socket) throw new Error("Home Assistant-verbinding bestaat al");
    return new Promise((resolve, reject) => {
      const socket = new this.WebSocketImpl(this.url);
      this.socket = socket;
      let settled = false;
      const fail = (error) => {
        if (!settled) {
          settled = true;
          reject(error instanceof Error ? error : new Error("Home Assistant-verbinding mislukt"));
        }
      };
      socket.addEventListener("message", (message) => {
        let input;
        try {
          input = JSON.parse(String(message.data));
        } catch {
          return;
        }
        if (input.type === "auth_required") {
          socket.send(JSON.stringify({ type: "auth", access_token: this.token }));
          return;
        }
        if (input.type === "auth_ok") {
          this.connected = true;
          if (!settled) {
            settled = true;
            resolve(this);
          }
          return;
        }
        if (input.type === "auth_invalid") {
          fail(Object.assign(new Error("Home Assistant-authenticatie geweigerd"), { code: "ha_auth_invalid" }));
          socket.close();
          return;
        }
        if (input.type === "result" && this.pending.has(input.id)) {
          const { resolve: resolvePending, reject: rejectPending, timer, maxBytes } = this.pending.get(input.id);
          this.pending.delete(input.id);
          clearTimeout(timer);
          if (maxBytes && Buffer.byteLength(String(message.data)) > maxBytes) rejectPending(Object.assign(new Error('HA response too large'), { code: 'ha_response_too_large' }));
          else if (input.success) resolvePending(input.result);
          else rejectPending(Object.assign(new Error(input.error?.message || "Home Assistant-opdracht mislukt"), { code: input.error?.code || "ha_call_failed" }));
          return;
        }
        if (input.type === "event" && this.subscriptions.has(input.id)) {
          Promise.resolve(this.subscriptions.get(input.id)(input.event)).catch((error) => this.onError?.(error));
        }
      });
      socket.addEventListener("error", () => fail(Object.assign(new Error("Home Assistant-WebSocketfout"), { code: "ha_websocket_error" })));
      socket.addEventListener("close", () => {
        this.connected = false;
        this.socket = null;
        const error = Object.assign(new Error("Home Assistant-verbinding gesloten"), { code: "ha_disconnected" });
        for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
        this.pending.clear();
        this.subscriptions.clear();
        fail(error);
        this.onClose?.();
      });
    });
  }

  #request(payload, { timeoutMs, maxBytes } = {}) {
    if (!this.connected || !this.socket) return Promise.reject(Object.assign(new Error("Home Assistant is niet verbonden"), { code: "ha_disconnected" }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        if (this.pending.delete(id)) reject(Object.assign(new Error('HA request timed out'), { code: 'ha_request_timeout' }));
      }, timeoutMs) : undefined;
      this.pending.set(id, { resolve, reject, timer, maxBytes });
      try { this.socket.send(JSON.stringify({ id, ...payload })); }
      catch (error) { this.pending.delete(id); clearTimeout(timer); reject(error); }
    });
  }

  async subscribeEvent(eventType, handler) {
    const id = this.nextId++;
    const confirmation = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.socket.send(JSON.stringify({ id, type: "subscribe_events", event_type: eventType }));
    await confirmation;
    this.subscriptions.set(id, handler);
    return id;
  }

  subscribeStateChanges(handler) {
    return this.subscribeEvent("state_changed", handler);
  }

  callService({ domain, service, service_data }) {
    return this.#request({ type: "call_service", domain, service, service_data, return_response: false });
  }

  getStates(options = {}) {
    return this.#request({ type: "get_states" }, options);
  }

  async getSolarHistory(configuration) {
    if (this.solarHistoryPending) throw Object.assign(new Error('Solar request pending'), { code: 'ha_solar_history_pending' });
    const { query } = createSolarHistoryRequest(configuration);
    this.solarHistoryPending = true;
    try { return await this.#request(query, { timeoutMs: 5000, maxBytes: 65536 }); }
    finally { this.solarHistoryPending = false; }
  }

  getEntityRegistry() {
    return this.#request({ type: "config/entity_registry/list" });
  }

  close() {
    this.socket?.close();
  }
}

export async function subscribeHomeAssistantObservations(client,handler) {
  await client.subscribeStateChanges(handler);
  try {
    await client.subscribeEvent('call_service',handler);
    return {service_observations:true};
  } catch(error) {
    // This diagnostic stream is admin-only in HA. A denied optional stream
    // must not require additional rights or discard allowed state telemetry.
    if(['unauthorized','not_allowed'].includes(error?.code))return {service_observations:false};
    throw error;
  }
}
