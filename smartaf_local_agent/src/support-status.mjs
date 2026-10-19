const CODES = new Set([
  'support_online','support_transport_closed','support_listener_failed','support_start_failed',
  'ha_disconnected','ha_connect_failed','event_delivery_failed','command_poll_failed','heartbeat_failed','agent_stopping',
  'control_plane_restart','control_plane_restart_unverified','server_identity_unverified',
  'support_generation_changed','support_session_revoked','support_server_changed',
  'invalid_support_connection','invalid_support_response','invalid_support_read','support_read_too_large',
  'support_read_changed','support_local_capacity','support_source_timeout','support_read_cancelled',
  'support_transport_failed','support_response_too_large','invalid_server_response','clock_untrusted',
  'proposal_transport_mismatch','invalid_proposal','scope_denied','proposal_expired','proposal_changed',
  'proposal_budget_exhausted','support_disabled','support_transport_unavailable'
]);
export const supportReasonCode = code => CODES.has(code) ? code : 'support_transport_failed';

// At most one structured row per 30 seconds. Never include response bodies,
// identity tokens, grant/operator IDs, origin, HA values or exception text.
export class SupportStatusReporter {
  #emit; #clock; #lastAt = null; #lastStatus = null; #pending = null;
  constructor({ emit, clock = Date.now }) {
    if (typeof emit !== 'function' || typeof clock !== 'function') throw new TypeError('Invalid support status reporter');
    this.#emit=emit; this.#clock=clock;
  }
  record(result) {
    const status = { online:result?.online === true, reason_code:result?.online === true ? 'support_online' : supportReasonCode(result?.reason_code) };
    const key=JSON.stringify(status), now=this.#clock();
    if (!Number.isSafeInteger(now) || now < 0 || (this.#lastAt !== null && now < this.#lastAt)) return;
    if (key !== this.#lastStatus) this.#pending=status;
    if (!this.#pending || (this.#lastAt !== null && now-this.#lastAt < 30_000)) return;
    const pending=this.#pending; this.#pending=null;
    this.#lastAt=now; this.#lastStatus=JSON.stringify(pending);
    this.#emit('support_transport_status',pending);
  }
}
