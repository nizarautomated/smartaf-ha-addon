// The volatile fence must run before closing/clearing HA and must not depend on
// a successful disk write. This helper is shared by ingress, close and startup
// failure paths; stale callbacks can only close their own HA connection.
export function createHaObservationLifecycle({getCurrent,setCurrent,connectionEpochs,getObserver,
  closeSupport=()=>{},onFenceError=()=>{},selectEvent,enqueueEvent}) {
  let candidate=null;
  const closed=new WeakSet();
  const accepted=client=>candidate===client&&!closed.has(client)&&client.connected===true;
  function fail(client,reason='ha_disconnected') {
    if(!client||closed.has(client))return;
    closed.add(client);
    const wasCurrent=getCurrent()===client;
    let pending;
    try { pending=getObserver()?.fence(reason,connectionEpochs.get(client)); }
    catch(error) { onFenceError(error); }
    // No await precedes either close or clearing the public current client.
    try { client.close(); }
    catch(error) { onFenceError(error); }
    finally {
      if(candidate===client)candidate=null;
      if(getCurrent()===client)setCurrent(null);
      if(wasCurrent)closeSupport(reason);
    }
    if(pending)void Promise.resolve(pending).catch(onFenceError);
  }
  return {
    track(client) { candidate=client; },
    activate(client) {
      if(!accepted(client))throw Object.assign(Error('HA disconnected'),{code:'ha_disconnected'});
      setCurrent(client);
    },
    isCurrentConnection(connectionId) {
      const client=getCurrent();
      return !!client&&accepted(client)&&connectionEpochs.get(client)===connectionId;
    },
    fail,
    failConnection(connectionId,reason) {
      const client=candidate;
      if(client&&connectionEpochs.get(client)===connectionId)fail(client,reason);
    },
    async ingest(client,event) {
      if(!accepted(client))return;
      try {
        const selected=selectEvent(event);
        if(!selected)return;
        // Recheck under the durable queue lock as well. A callback awaiting a
        // snapshot must not append an old connection's event to its successor.
        await enqueueEvent(selected,{isCurrent:()=>accepted(client)});
      } catch(error) {
        fail(client,'ha_observation_failed');
        throw error;
      }
    }
  };
}
