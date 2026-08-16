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
          const pending = this.pending.get(input.id);
          this.pending.delete(input.id);
          if (input.success) pending.resolve(input.result);
          else pending.reject(Object.assign(new Error(input.error?.message || "Home Assistant-opdracht mislukt"), { code: input.error?.code || "ha_call_failed" }));
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
        for (const pending of this.pending.values()) pending.reject(error);
        this.pending.clear();
        this.subscriptions.clear();
        fail(error);
        this.onClose?.();
      });
    });
  }

  #request(payload) {
    if (!this.connected || !this.socket) return Promise.reject(Object.assign(new Error("Home Assistant is niet verbonden"), { code: "ha_disconnected" }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, ...payload }));
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

  getStates() {
    return this.#request({ type: "get_states" });
  }

  close() {
    this.socket?.close();
  }
}
