import { authorizeRuntimeCommand, LocalAccessError } from './access-policy.mjs';

export async function enforceLocalPolicy(command, {policy,homeId,client,isCurrentClient=()=>true,clock=Date.now,timeoutMs=2000}) {
  if (!policy || policy.enabled === false) return authorizeRuntimeCommand(command,{policy,homeId,now:clock()});
  if (!client?.connected || !isCurrentClient(client)) throw new LocalAccessError('policy_ha_disconnected');
  let timer;
  try {
    const [states,registry]=await Promise.race([
      Promise.all([client.getStates(),client.getEntityRegistry()]),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new LocalAccessError('policy_metadata_timeout')),timeoutMs);})
    ]);
    if (!Array.isArray(states)||!Array.isArray(registry)||!client.connected||!isCurrentClient(client)) throw new LocalAccessError('policy_metadata_unavailable');
    const entry=registry.find(item=>item.entity_id===command.entity_id);
    const current=states.find(item=>item.entity_id===command.entity_id);
    if (!current || ['unknown','unavailable'].includes(current.state) || current.attributes?.restored===true) throw new LocalAccessError('policy_target_unavailable');
    const members=current.attributes?.entity_id;
    const entityMetadata=new Map([[command.entity_id,{
      entity_id:command.entity_id, registry_present:!!entry, platform:entry?.platform,
      disabled:!!entry?.disabled_by, is_group:entry?.platform==='group'||members!==undefined,
      members:members===undefined?[]:(Array.isArray(members)?members:[members])
    }]]);
    return authorizeRuntimeCommand(command,{policy,homeId,entityMetadata,now:clock()});
  } catch(error) {
    if(error instanceof LocalAccessError)throw error;
    throw new LocalAccessError('policy_metadata_unavailable');
  } finally { clearTimeout(timer); }
}
