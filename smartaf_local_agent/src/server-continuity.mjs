const UUID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const PROCESS = new RegExp(`^server_${UUID}$`);
const INSTANCE = new RegExp(`^server_${UUID}:(?:${UUID}|legacy)$`);
const invalid = () => { throw Object.assign(new Error('Invalid heartbeat server identity'), { code:'invalid_server_identity' }); };

// A snapshot token is a resynchronization request, not proof of process loss.
// Old servers retain conservative behavior; removing the new field also closes
// support, even if the old compound identity happens to remain unchanged.
export class ServerContinuity {
  #instance = null; #process = null;
  observe(response) {
    const instance = response?.server_instance_id;
    if (typeof instance !== 'string' || !INSTANCE.test(instance)) invalid();
    const hasProcess = Object.hasOwn(response, 'server_process_id');
    const processId = hasProcess ? response.server_process_id : null;
    if (hasProcess && (typeof processId !== 'string' || !PROCESS.test(processId) || !instance.startsWith(`${processId}:`))) invalid();
    const instanceChanged = this.#instance !== null && this.#instance !== instance;
    const processChanged = this.#process !== null && processId !== null && this.#process !== processId;
    const downgraded = this.#process !== null && processId === null;
    const legacyChanged = instanceChanged && (this.#process === null || processId === null);
    this.#instance = instance; this.#process = processId;
    return {
      reset_support: processChanged || downgraded || legacyChanged,
      request_snapshot: instanceChanged || processChanged || downgraded,
      reason_code: processChanged ? 'control_plane_restart' : downgraded ? 'server_identity_unverified' :
        legacyChanged ? 'control_plane_restart_unverified' : instanceChanged ? 'household_resynchronization' : 'server_identity_unchanged'
    };
  }
}
