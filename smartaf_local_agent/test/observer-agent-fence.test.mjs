import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {DurableAgentState} from '../src/durable-state.mjs';
import {ObserverAgentTransport} from '../src/observer-agent-transport.mjs';
import {createHaObservationLifecycle} from '../src/ha-observation-lifecycle.mjs';
import {HomeAssistantWebSocketClient} from '../src/ha-client.mjs';

const HOME='home_fence_alpha',AGENT='agent_fence_alpha',T=Date.parse('2026-10-20T12:00:00.000Z');
const iso=at=>new Date(at).toISOString();
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const stateEvent=at=>({protocol_version:1,home_id:HOME,agent_id:AGENT,event_id:`evt_${randomUUID()}`,sequence:0,
  type:'state_changed',entity_id:'light.fence_test',new_state:'on',occurred_at:iso(at)});

async function fixture(t,{capture,onRequest,captureTimeoutMs=10000}={}) {
  const root=await mkdtemp(join(tmpdir(),'smartaf-agent-fence-'));
  const state=await new DurableAgentState({dataDir:root}).init();
  let now=T,current=null,transport;const epochs=new WeakMap(),requests=[],failures=[],closed=[];
  const lifecycle=createHaObservationLifecycle({
    getCurrent:()=>current,setCurrent:value=>{current=value;},connectionEpochs:epochs,getObserver:()=>transport,
    onFenceError:error=>failures.push(error.code||error.message),
    selectEvent:event=>event,enqueueEvent:(event,options)=>state.enqueueSequencedEvent(event,options)
  });
  const snapshot=()=>({protocol_version:1,home_id:HOME,agent_id:AGENT,event_id:`evt_snapshot_${randomUUID()}`,
    sequence:0,type:'state_snapshot',occurred_at:iso(now),payload:{states:[{entity_id:'light.fence_test',state:'off'}]}});
  const wire={observerExchange:async request=>{
    requests.push(structuredClone(request));await onRequest?.(request);
    if(request.kind==='begin')return {status:'reset_offered',home_id:HOME,agent_id:AGENT,
      reset_id:request.reset_id,connection_id:request.connection_id,loss_counter:request.loss_counter,
      client_sent_at:request.client_sent_at,session_id:randomUUID(),reset_token:randomUUID(),issued_at:iso(now),expires_at:iso(now+30000)};
    if(request.kind==='event')return {status:'committed',home_id:HOME,agent_id:AGENT,
      receipt:{epoch:request.session_id,event_id:request.event.event_id,sequence:request.event.observer_sequence,status:'committed'}};
    return {status:request.kind==='disconnect'?'offline':'current',home_id:HOME,agent_id:AGENT,session_id:request.session_id};
  }};
  transport=await new ObserverAgentTransport({state,client:wire,homeId:HOME,agentId:AGENT,clock:()=>now,captureTimeoutMs,
    isCurrentConnection:id=>lifecycle.isCurrentConnection(id),
    onLocalFailure:(error,id)=>{failures.push(error.code||error.message);lifecycle.failConnection(id,'observer_storage_failed');},
    captureSnapshot:async()=>{await capture?.();return snapshot();}
  }).init();
  const connect=async(id=`ha_connection_${randomUUID()}`)=>{
    const client={connected:true,close(){this.connected=false;closed.push(id);lifecycle.fail(this,'ha_disconnected');}};
    epochs.set(client,id);lifecycle.track(client);lifecycle.activate(client);
    await transport.connection(true,id);return client;
  };
  t.after(async()=>{await state.lock.catch(()=>{});await rm(root,{recursive:true,force:true});});
  await connect('ha_connection_alpha');
  return {root,state,transport,lifecycle,requests,failures,closed,epochs,wire,snapshot,
    current:()=>current,connect,now:at=>{now=at;},event:()=>stateEvent(now)};
}
async function start(f) {
  assert.equal((await f.transport.step()).status,'snapshot_pending');
  assert.equal((await f.transport.step()).status,'committed');
}

test('a failed durable disconnect cannot preserve a fresh connected heartbeat',async t=>{
  const f=await fixture(t);await start(f);
  const old=f.current(),path=f.state.path,before=await readFile(path,'utf8');
  const blocker=join(f.root,'blocker');await writeFile(blocker,'file');f.state.path=join(blocker,'state.json');
  await assert.rejects(f.transport.connection(false,f.epochs.get(old)));
  assert.equal(f.current(),null);assert.equal(old.connected,false);
  assert.equal((await f.state.observerState()).observer.connected,true,'disk failure really left old durable state');
  assert.equal(await readFile(path,'utf8'),before);
  await assert.rejects(f.transport.step());
  assert.equal(f.requests.at(-1).kind,'disconnect');
  f.now(T+6000);
  assert.equal((await f.transport.step()).status,'offline');
  assert.equal(f.requests.filter(item=>item.kind==='heartbeat').length,0);
  f.state.path=path;
});

test('local ACK storage failure closes HA and retains the head until a new connection reset',async t=>{
  const f=await fixture(t);await start(f);f.now(T+100);
  const event=await f.state.enqueueSequencedEvent(f.event()),path=f.state.path,before=await readFile(path,'utf8');
  const blocker=join(f.root,'blocker');await writeFile(blocker,'file');f.state.path=join(blocker,'state.json');
  await assert.rejects(f.transport.step());
  assert.equal(f.current(),null);
  assert.equal((await f.state.firstEvent()).event_id,event.event_id);
  assert.equal(await readFile(path,'utf8'),before);
  await f.state.lock.catch(()=>{});f.state.path=path;
  assert.equal((await f.transport.step()).status,'offline');
  assert.equal(f.requests.at(-1).kind,'disconnect');
  await f.connect('ha_connection_beta');await start(f);
  assert.equal(await f.state.bufferedEvents(),0);
  assert.equal((await f.state.observerState()).observer.superseded_events,1);
});

test('disconnect during a locked snapshot capture aborts capture and retains the previous queue',async t=>{
  const entered=deferred(),release=deferred();
  const f=await fixture(t,{capture:async()=>{entered.resolve();await release.promise;}});
  const retained=await f.state.enqueueSequencedEvent(f.event());
  const pending=f.transport.step();await entered.promise;
  const client=f.current();f.lifecycle.fail(client,'ha_disconnected');
  assert.equal(f.current(),null);assert.equal(client.connected,false);
  release.resolve();await assert.rejects(pending,/observer_connection_changed/);
  await f.state.lock.catch(()=>{});
  assert.equal((await f.state.firstEvent()).event_id,retained.event_id);
  assert.equal((await f.state.observerState()).observer.session_id,null);
  assert.equal((await f.transport.step()).status,'offline');
});

test('a capture with no HA reply times out, closes HA and frees the queue without installing a late snapshot',async t=>{
  const release=deferred();let captures=0;
  const f=await fixture(t,{captureTimeoutMs:20,capture:async()=>{captures++;await release.promise;}});
  const event=await f.state.enqueueSequencedEvent(f.event());
  await assert.rejects(f.transport.step(),/observer_capture_timeout/);
  assert.equal(f.current(),null);assert.equal(f.closed.length,1);
  assert.equal((await f.state.firstEvent()).event_id,event.event_id,'queue read completes after timeout');
  assert.equal((await f.state.observerState()).observer.session_id,null);
  assert.equal((await f.transport.step()).status,'offline');assert.equal(captures,1);
  release.resolve();await Promise.resolve();await Promise.resolve();
  assert.equal((await f.state.firstEvent()).event_id,event.event_id);
  assert.equal(f.requests.filter(request=>request.kind==='event').length,0);
});

test('disconnect while the server ACK is in flight cannot delete the local event',async t=>{
  const entered=deferred(),release=deferred();let block=false;
  const f=await fixture(t,{onRequest:async request=>{
    if(block&&request.kind==='event'){entered.resolve();await release.promise;}
  }});await start(f);
  const event=await f.state.enqueueSequencedEvent(f.event());block=true;
  const pending=f.transport.step();await entered.promise;f.lifecycle.fail(f.current(),'ha_disconnected');
  release.resolve();await assert.rejects(pending,/observer_connection_changed/);
  assert.equal((await f.state.firstEvent()).event_id,event.event_id);
  assert.equal((await f.transport.step()).status,'offline');
});

test('late callbacks and a disconnect from an old epoch cannot fence its connected successor',async t=>{
  const f=await fixture(t);await start(f);
  const old=f.current(),oldId=f.epochs.get(old);f.lifecycle.fail(old,'ha_disconnected');
  const next=await f.connect('ha_connection_beta');
  assert.equal(await f.transport.connection(false,oldId),false);
  assert.equal(await f.transport.fence('ha_observation_failed',oldId),false);
  await assert.rejects(f.transport.connection(true,oldId),/observer_connection_changed/);
  f.lifecycle.fail(old,'ha_observation_failed');await f.lifecycle.ingest(old,f.event());
  assert.equal(f.current(),next);assert.equal(next.connected,true);await start(f);
  assert.equal((await f.state.observerState()).observer.connection_id,'ha_connection_beta');
});

test('server restart while HA is offline gives one terminal disconnect and preserves the learned session for reconnect',async t=>{
  const f=await fixture(t);await start(f);f.lifecycle.fail(f.current(),'ha_disconnected');
  await f.state.lock.catch(()=>{});
  let writes=0;const mutate=f.state.observerTransaction.bind(f.state);
  f.state.observerTransaction=operation=>{writes++;return mutate(operation);};
  const currentSession=randomUUID(),exchange=f.wire.observerExchange;
  f.wire.observerExchange=async request=>{
    const response=await exchange(request);
    return request.kind==='disconnect'?{status:'reset_required',home_id:HOME,agent_id:AGENT,
      current_session:currentSession,reason:'observer_session_mismatch'}:response;
  };
  assert.equal((await f.transport.step()).status,'offline');
  const sent=f.requests.length,stored=writes;
  for(let index=1;index<=20;index++){
    f.now(T+index*1000);
    assert.equal((await f.transport.step()).status,'offline');
  }
  assert.equal(f.requests.length,sent);assert.equal(writes,stored);
  assert.equal((await f.state.observerState()).observer.previous_session,currentSession);
  await f.connect('ha_connection_beta');assert.equal((await f.transport.step()).status,'snapshot_pending');
  assert.equal(f.requests.at(-1).previous_session,currentSession);
});

test('a late disconnect reset reply cannot modify the successor HA epoch',async t=>{
  const entered=deferred(),release=deferred();
  const f=await fixture(t);await start(f);
  const exchange=f.wire.observerExchange;
  f.wire.observerExchange=async request=>{
    const response=await exchange(request);
    if(request.kind!=='disconnect')return response;
    entered.resolve();await release.promise;
    return {status:'reset_required',home_id:HOME,agent_id:AGENT,current_session:randomUUID(),reason:'observer_session_mismatch'};
  };
  f.lifecycle.fail(f.current(),'ha_disconnected');
  const pending=f.transport.step();await entered.promise;await f.connect('ha_connection_beta');
  const before=await f.state.observerState();release.resolve();
  assert.equal((await pending).status,'offline');
  assert.deepEqual(await f.state.observerState(),before);
  assert.equal(f.current().connected,true);await start(f);
});

test('an event waiting behind the queue lock cannot be appended after its HA epoch is replaced',async t=>{
  const f=await fixture(t);await start(f);
  const entered=deferred(),release=deferred(),old=f.current();
  const lock=f.state.observerTransaction(async()=>{entered.resolve();await release.promise;});await entered.promise;
  const event=f.event(),ingest=f.lifecycle.ingest(old,event);
  // Install a rejection handler before releasing the transaction.
  const rejected=assert.rejects(ingest,/HA observation connection changed/);
  f.lifecycle.fail(old,'ha_disconnected');
  const reconnected=f.connect('ha_connection_beta');
  release.resolve();await lock;await rejected;await reconnected;
  assert.equal((await f.state.observerState()).events.some(item=>item.event_id===event.event_id),false);
  await start(f);
});

for(const code of ['event_buffer_full','ENOSPC','EIO','EXDEV'])test(`selected event ${code} fences and closes before its fence write resolves`,async()=>{
  const order=[],pending=deferred(),epochs=new WeakMap();let current;
  const client={connected:true,close(){order.push('close');this.connected=false;}};current=client;epochs.set(client,'ha_connection_alpha');
  const lifecycle=createHaObservationLifecycle({
    getCurrent:()=>current,setCurrent:value=>{order.push('clear');current=value;},connectionEpochs:epochs,
    getObserver:()=>({fence(){order.push('fence');return pending.promise;}}),selectEvent:value=>value,
    enqueueEvent:async()=>{throw Object.assign(Error(code),{code});}
  });lifecycle.track(client);
  await assert.rejects(lifecycle.ingest(client,stateEvent(T)),new RegExp(code));
  assert.deepEqual(order,['fence','close','clear']);assert.equal(current,null);
  pending.resolve();
});

test('selection failure uses the same immediate lifecycle fence as queue errors',async()=>{
  const order=[],epochs=new WeakMap();let current;
  const client={connected:true,close(){order.push('close');this.connected=false;}};current=client;epochs.set(client,'ha_connection_alpha');
  const lifecycle=createHaObservationLifecycle({getCurrent:()=>current,setCurrent:value=>{current=value;},
    connectionEpochs:epochs,getObserver:()=>({fence(){order.push('fence');}}),
    selectEvent:()=>{throw Error('invalid_selected_event');},enqueueEvent:()=>assert.fail('must not enqueue')});
  lifecycle.track(client);await assert.rejects(lifecycle.ingest(client,{}),/invalid_selected_event/);
  assert.deepEqual(order,['fence','close']);assert.equal(current,null);
});

test('a connection that failed during subscription setup cannot be activated afterwards',()=>{
  const epochs=new WeakMap();let current=null;
  const client={connected:true,close(){this.connected=false;}};epochs.set(client,'ha_connection_alpha');
  const lifecycle=createHaObservationLifecycle({getCurrent:()=>current,setCurrent:value=>{current=value;},
    connectionEpochs:epochs,getObserver:()=>null,selectEvent:value=>value,enqueueEvent:()=>{}});
  lifecycle.track(client);lifecycle.fail(client,'ha_observation_failed');
  assert.throws(()=>lifecycle.activate(client),/HA disconnected/);
  assert.equal(current,null);
});

test('reset capture records actual receive/start instants and preserves the begin timestamp after lost reply',async t=>{
  let lose=true;const f=await fixture(t);
  const exchange=f.wire.observerExchange;
  f.wire.observerExchange=async request=>{const response=await exchange(request);if(lose){lose=false;throw Error('lost_reply');}return response;};
  await assert.rejects(f.transport.step(),/lost_reply/);f.now(T+200);
  assert.equal((await f.transport.step()).status,'snapshot_pending');
  assert.equal(f.requests[0].client_sent_at,iso(T));
  assert.equal(f.requests[1].client_sent_at,f.requests[0].client_sent_at);
  const snapshot=await f.state.firstEvent();assert.equal(snapshot.occurred_at,iso(T+200));
  await f.transport.step();
  assert.deepEqual(f.requests.at(-1).reset_capture,{offer_received_at:iso(T+200),capture_started_at:iso(T+200)});
});

test('the real HA client bounds get_states and ignores a reply after its request deadline',async()=>{
  const requests=[];
  class Socket extends EventTarget {
    constructor(){super();queueMicrotask(()=>this.message({type:'auth_required'}));}
    message(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
    send(raw){
      const request=JSON.parse(raw);
      if(request.type==='auth')queueMicrotask(()=>this.message({type:'auth_ok'}));
      else requests.push(request);
    }
    close(){this.dispatchEvent(new Event('close'));}
  }
  const client=await new HomeAssistantWebSocketClient({url:'ws://local.invalid',token:'test-only',WebSocketImpl:Socket}).connect();
  await assert.rejects(client.getStates({timeoutMs:20}),/HA request timed out/);
  assert.equal(client.pending.size,0);assert.equal(requests[0].type,'get_states');
  client.socket.message({type:'result',id:requests[0].id,success:true,result:[]});
  assert.equal(client.pending.size,0);client.close();
});
