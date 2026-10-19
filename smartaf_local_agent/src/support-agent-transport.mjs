import { supportReasonCode } from './support-status.mjs';
const plain = value => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const list = (value, maximum) => Array.isArray(value) && value.length <= maximum;
const fail = code => { throw Object.assign(new Error('Supportverbinding gesloten'), { code }); };

export class SupportAgentTransport {
  #homeId; #revision; #controller; #client; #collect; #connection; #clock; #instance = null;
  #generation = 0; #pending = new Map(); #seen = new Map(); #running = null;
  constructor({ homeId, policyRevision, controller, client, collect, connectionState, clock = Date.now }) {
    if (!homeId || !Number.isSafeInteger(policyRevision) || policyRevision < 1 || ['transportSnapshot','resetTransportSession','assertReadAuthorized','readDiagnosis','receiveProposal','receiveRevocation','setTransportState'].some(name => typeof controller?.[name] !== 'function') || typeof client?.supportExchange !== 'function' || typeof collect !== 'function' || typeof connectionState !== 'function') throw new TypeError('Invalid support transport integration');
    this.#homeId = homeId; this.#revision = policyRevision; this.#controller = controller; this.#client = client; this.#collect = collect; this.#connection = connectionState; this.#clock = clock;
  }
  close() {
    this.#generation++; this.#pending.clear(); this.#seen.clear();
    try { this.#controller.resetTransportSession(); } catch { /* Untrusted controller clock already closes its access. */ }
  }
  async #connectionState() {
    const state = await this.#connection();
    if (typeof state?.haConnected !== 'boolean' || !Number.isSafeInteger(state.bufferedEvents) || state.bufferedEvents < 0) fail('invalid_support_connection');
    return state;
  }
  step() {
    if (!this.#running) this.#running = this.#step().finally(() => { this.#running = null; });
    return this.#running;
  }
  async #step() {
    try {
      const healthy = (await this.#connectionState()).haConnected;
      const previousSnapshot = this.#controller.transportSnapshot();
      if (!healthy) this.close();
      const generation = this.#generation, snapshot = healthy ? this.#controller.transportSnapshot() : previousSnapshot;
      const reports = [];
      for (const [id, record] of this.#pending) {
        if (record.expires <= this.#clock()) { this.#pending.delete(id); continue; }
        let update = record.update;
        if (update.status === 'ok') {
          // Final local authority check immediately before transmitting a result.
          try { this.#controller.assertReadAuthorized(record.request, { operatorId: record.operatorId }); }
          catch { update = { request_id: id, status: 'denied' }; }
        }
        reports.push(update); break;
      }
      const response = await this.#client.supportExchange({ protocol_version: 1, local_session_id: snapshot.local_session_id, policy_revision: this.#revision, online: healthy, approvals: healthy ? snapshot.approval_proofs : [], revoked_grant_ids: healthy ? snapshot.revoked_grant_ids : [], reports: healthy ? reports : [] });
      if (generation !== this.#generation) return { online: false, reason_code: 'support_generation_changed' };
      if (!exact(response, ['protocol_version', 'home_id', 'local_session_id', 'server_instance_id', 'session_revoked', 'proposals', 'revoked_grant_ids', 'requests', 'accepted_reports']) || response.protocol_version !== 1 || response.home_id !== this.#homeId || response.local_session_id !== snapshot.local_session_id || typeof response.server_instance_id !== 'string' || !/^support_[a-f0-9-]{36}$/.test(response.server_instance_id) || typeof response.session_revoked !== 'boolean' || !list(response.proposals, 10) || !list(response.revoked_grant_ids, 100) || !list(response.requests, 1) || !list(response.accepted_reports, 1)) fail('invalid_support_response');
      const changedServer = this.#instance !== null && this.#instance !== response.server_instance_id;
      this.#instance = response.server_instance_id;
      const currentConnection = await this.#connectionState();
      if (generation !== this.#generation) return { online:false, reason_code:'support_generation_changed' };
      if (!healthy || response.session_revoked || changedServer || !currentConnection.haConnected) {
        this.close(); return { online:false, reason_code: !healthy || !currentConnection.haConnected ? 'ha_disconnected' : changedServer ? 'support_server_changed' : 'support_session_revoked' };
      }
      this.#controller.setTransportState({ ...currentConnection, serverConnected: true });
      const transport = { homeId: this.#homeId, localSessionId: snapshot.local_session_id };
      for (const id of response.accepted_reports) this.#pending.delete(id);
      for (const grant of response.proposals) this.#controller.receiveProposal(grant, transport);
      for (const id of response.revoked_grant_ids) this.#controller.receiveRevocation(id, transport);
      for (const task of response.requests) {
        if (!exact(task, ['request_id', 'request', 'operator_id', 'expires_at']) || typeof task.request_id !== 'string' || !/^read_[a-f0-9-]{36}$/.test(task.request_id) || !plain(task.request) || task.operator_id !== task.request.operator_id || task.request.home_id !== this.#homeId || task.request.local_session_id !== snapshot.local_session_id) fail('invalid_support_read');
        const expires = Date.parse(task.expires_at), now = this.#clock();
        if (!Number.isFinite(expires) || expires <= now || expires > now + 10_000) continue;
        const serialized = JSON.stringify(task);
        if (Buffer.byteLength(serialized) > 8_192) fail('support_read_too_large');
        const seen = this.#seen.get(task.request_id);
        if (seen !== undefined && seen !== serialized) fail('support_read_changed');
        if (this.#pending.has(task.request_id)) continue;
        if (seen !== undefined) continue;
        if (this.#pending.size >= 10 || this.#seen.size >= 1000) fail('support_local_capacity');
        this.#seen.set(task.request_id, serialized);
        let update;
        try {
          this.#controller.assertReadAuthorized(task.request, { operatorId: task.operator_id });
          let timer;
          const supplied = await Promise.race([this.#collect(task.request), new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Support source timeout'), {code:'support_source_timeout'})), 5_000); })]).finally(() => clearTimeout(timer));
          const sourceConnection = await this.#connectionState();
          if (generation !== this.#generation || !sourceConnection.haConnected || this.#clock() >= expires) fail('support_read_cancelled');
          const report = this.#controller.readDiagnosis(task.request, supplied, { operatorId: task.operator_id });
          update = { request_id: task.request_id, status: 'ok', report };
        } catch (error) {
          if (['support_source_timeout', 'support_read_cancelled', 'invalid_support_connection', 'ha_disconnected'].includes(error?.code)) this.close();
          update = { request_id: task.request_id, status: 'denied' };
        }
        if (generation !== this.#generation) return { online: false, reason_code: 'support_generation_changed' };
        this.#pending.set(task.request_id, { request: structuredClone(task.request), operatorId: task.operator_id, expires, update });
      }
      return { online: true };
    } catch (error) {
      this.close();
      return { online: false, reason_code: supportReasonCode(error?.code) };
    }
  }
}

// Only entity-bound structured result rows are kept. No free log strings,
// service parameters, user ids, credentials or historical HA states are stored.
export class SupportDiagnosticJournal {
  #rows = [];
  record(entityId, result) {
    if (typeof entityId !== 'string' || !/^[a-z][a-z0-9_]*\.[a-z0-9_]+$/.test(entityId) || !result || typeof result.occurred_at !== 'string' || !Number.isFinite(Date.parse(result.occurred_at))) return;
    this.#rows.push({ entity_id: entityId, occurred_at: new Date(result.occurred_at).toISOString(), status: ['succeeded', 'failed', 'rejected', 'expired'].includes(result.status) ? result.status : 'unknown', error_code: ['MAC_NO_ACK', 'network_timeout', 'device_unavailable', 'command_expired', 'execution_outcome_unknown'].includes(result.error_code) ? result.error_code : 'redacted' });
    if (this.#rows.length > 2000) this.#rows.splice(0, this.#rows.length - 2000);
  }
  collect(request, observedAt) {
    const rows = this.#rows.filter(row => request.entities.includes(row.entity_id));
    if (request.action === 'read_command_results') return { observed_at: observedAt, results: structuredClone(rows) };
    return { observed_at: observedAt, logs: rows.map(row => ({ entity_id: row.entity_id, occurred_at: row.occurred_at, level: row.status === 'succeeded' ? 'info' : 'warning', event_code: row.error_code ?? (row.status === 'succeeded' ? 'command_succeeded' : 'command_failed') })) };
  }
}
