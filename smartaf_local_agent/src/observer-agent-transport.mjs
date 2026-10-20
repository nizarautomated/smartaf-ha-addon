import {randomUUID} from 'node:crypto';
import {observerQueueCheckpoint} from './observer-checkpoint.mjs';

const id=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,96}$/.test(value);
const failure=code=>Object.assign(Error(code),{code});
const copy=value=>structuredClone(value);
const instant=value=>new Date(value).toISOString();
const time=value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)&&Number.isFinite(Date.parse(value))&&instant(Date.parse(value))===value;
const CLOCK_LIMIT_MS=1000;

// Optional protocol, using the SAME durable file/lock as ordinary event
// buffering. The adapter has no command client and never executes HA actions.
export class ObserverAgentTransport {
  #lock=Promise.resolve(); #lastHeartbeat=-Infinity; #begin=null;
  #live={connected:false,connection_id:null,generation:0}; #disconnectedSession=null;
  constructor({state,client,homeId,agentId,captureSnapshot,isCurrentConnection=()=>true,onLocalFailure=()=>{},captureTimeoutMs=10000,clock=Date.now}={}){
    if(!state||!client||typeof captureSnapshot!=='function'||typeof isCurrentConnection!=='function'||typeof onLocalFailure!=='function'||
      !Number.isInteger(captureTimeoutMs)||captureTimeoutMs<1||captureTimeoutMs>10000)throw failure('observer_configuration_invalid');
    Object.assign(this,{state,client,homeId,agentId,captureSnapshot,isCurrentConnection,onLocalFailure,captureTimeoutMs,clock});
  }
  #current(expected=this.#live){
    try{return expected.connected===true&&this.#live.connected&&expected.generation===this.#live.generation&&
      expected.connection_id===this.#live.connection_id&&this.isCurrentConnection(expected.connection_id)===true;}catch{return false;}
  }
  #assertCurrent(expected){if(!this.#current(expected))throw failure('observer_connection_changed');}
  #off(connectionId=this.#live.connection_id){
    if(this.#live.connected||this.#live.connection_id!==connectionId)this.#live={connected:false,connection_id:connectionId,generation:this.#live.generation+1};
  }
  async #local(operation,connectionId=this.#live.connection_id){
    try{return await operation();}
    catch(error){
      if(error.code!=='observer_connection_changed'&&connectionId===this.#live.connection_id){
        this.#off(connectionId);
        // The main HA lifecycle closes synchronously. No successful disk write
        // is required to stop this process from publishing connected:true.
        try{this.onLocalFailure(error,connectionId);}catch{}
      }
      throw error;
    }
  }
  async #capture(connectionId){
    let timer;
    try {
      // Both settlements are observed, including a late reply after timeout.
      // On timeout #local fences and the HA lifecycle closes all pending reads.
      // The timed-out capture can never install a snapshot or retain the lock.
      return await Promise.race([
        Promise.resolve().then(()=>this.captureSnapshot({connection_id:connectionId})),
        new Promise((resolve,reject)=>{timer=setTimeout(()=>reject(failure('observer_capture_timeout')),this.captureTimeoutMs);})
      ]);
    } finally {clearTimeout(timer);}
  }
  async init(){
    await this.state.observerTransaction(draft=>{
      const old=draft.observer;
      if(old&&(old.home_id!==this.homeId||old.agent_id!==this.agentId))throw failure('observer_identity_changed');
      draft.observer={schema_version:1,home_id:this.homeId,agent_id:this.agentId,
        previous_session:old?.session_id||old?.previous_session||null,session_id:null,reset_id:randomUUID(),
        connection_id:randomUUID(),connected:false,needs_reset:true,loss_counter:(old?.loss_counter||0)+1,
        produced_sequence:0,acknowledged_sequence:0,reset_count:old?.reset_count||0,
        superseded_events:old?.superseded_events||0,last_reason:'process_restart'};
    });return this;
  }
  async connection(connected,connectionId){
    if(typeof connected!=='boolean'||!id(connectionId))throw failure('observer_connection_invalid');
    if(!connected&&this.#live.connection_id!==connectionId)return false;
    if(connected&&this.isCurrentConnection(connectionId)!==true)throw failure('observer_connection_changed');
    // This fence is synchronous and independent of queue/disk success. A failed
    // disconnect write can never keep a stale connected:true value authoritative.
    if(this.#live.connected!==connected||this.#live.connection_id!==connectionId){
      this.#live={connected,connection_id:connectionId,generation:this.#live.generation+1};this.#disconnectedSession=null;
    }
    const expected={...this.#live};
    try{const result=await this.#local(()=>this.state.observerTransaction(draft=>{
      if(expected.generation!==this.#live.generation)throw failure('observer_connection_changed');
      const stream=draft.observer;
      if(stream.connected===connected&&stream.connection_id===connectionId)return;
      stream.connected=connected;stream.connection_id=connectionId;
      stream.needs_reset=true;stream.reset_id=randomUUID();stream.loss_counter++;
      stream.disconnect_sent=false;
      stream.previous_session=stream.session_id||stream.previous_session;stream.last_reason='ha_connection_changed';
    }),connectionId);if(connected)this.#assertCurrent(expected);return result;}
    catch(error){if(expected.generation===this.#live.generation)this.#off(connectionId);throw error;}
  }
  async fence(reason='observer_local_failed',connectionId=this.#live.connection_id){
    if(!id(connectionId)||this.#live.connection_id!==connectionId)return false;
    this.#off(connectionId);
    const generation=this.#live.generation;
    await this.state.observerTransaction(draft=>{
      if(this.#live.generation!==generation||this.#live.connection_id!==connectionId)return;
      const stream=draft.observer;
      stream.connected=false;stream.connection_id=connectionId;stream.needs_reset=true;stream.reset_id=randomUUID();stream.loss_counter++;
      stream.disconnect_sent=false;stream.previous_session=stream.session_id||stream.previous_session;
      stream.last_reason=typeof reason==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(reason)?reason:'observer_local_failed';
    });return true;
  }
  async reset(reason,currentSession){
    this.#live={...this.#live,generation:this.#live.generation+1};
    return this.#local(()=>this.state.observerTransaction(draft=>{
      const stream=draft.observer;
      stream.previous_session=id(currentSession)?currentSession:stream.session_id||stream.previous_session;
      stream.needs_reset=true;stream.reset_id=randomUUID();stream.loss_counter++;stream.last_reason=reason;
    }));
  }
  async #install(offer,expected,continuity,clientSentAt,offerReceivedAt){
    this.#assertCurrent(continuity);
    if(offer?.status!=='reset_offered'||offer.home_id!==this.homeId||offer.agent_id!==this.agentId||offer.reset_id!==expected.reset_id||
      offer.connection_id!==expected.connection_id||offer.loss_counter!==expected.loss_counter||!id(offer.session_id)||!id(offer.reset_token)||
      offer.client_sent_at!==clientSentAt||![offer.issued_at,offer.expires_at,clientSentAt,offerReceivedAt].every(time)||
      Date.parse(offer.expires_at)<=this.clock())throw failure('observer_offer_invalid');
    const sent=Date.parse(clientSentAt),received=Date.parse(offerReceivedAt),issued=Date.parse(offer.issued_at);
    if(received<sent||received-sent>CLOCK_LIMIT_MS||sent-issued< -CLOCK_LIMIT_MS||received-issued>CLOCK_LIMIT_MS)throw failure('observer_offer_clock_invalid');
    await this.#local(()=>this.state.observerTransaction(async draft=>{
      this.#assertCurrent(continuity);
      const stream=draft.observer;
      if(!stream.connected||stream.reset_id!==expected.reset_id||stream.connection_id!==expected.connection_id)throw failure('observer_connection_changed');
      // Capture while holding the queue lock. Incoming callbacks wait and are
      // appended after this baseline. Late older observations are NOT silently
      // dropped: server ordering checks require a new reset if inconsistent.
      const captureStartedAt=instant(this.clock());
      if(Date.parse(captureStartedAt)<received)throw failure('observer_capture_clock_invalid');
      const event=await this.#capture(stream.connection_id);
      this.#assertCurrent(continuity);
      if(event?.home_id!==this.homeId||event.agent_id!==this.agentId||event.type!=='state_snapshot'||
        !time(event.occurred_at)||Date.parse(event.occurred_at)<Date.parse(captureStartedAt)||Date.parse(event.occurred_at)>this.clock()||
        Date.parse(offer.expires_at)<=this.clock())throw failure('observer_reset_snapshot_invalid');
      const superseded=draft.events.length;
      draft.events=[{...event,sequence:++draft.sequence,observer_sequence:1,observer_epoch:offer.session_id}];
      Object.assign(stream,{session_id:offer.session_id,previous_session:offer.session_id,reset_token:offer.reset_token,
        reset_capture:{offer_received_at:offerReceivedAt,capture_started_at:captureStartedAt},
        needs_reset:false,produced_sequence:1,acknowledged_sequence:0,reset_count:stream.reset_count+1,
        superseded_events:stream.superseded_events+superseded,last_reason:'server_authorized_snapshot_reset'});
    }),continuity.connection_id);
    this.#assertCurrent(continuity);
  }
  async #packet(){
    return this.#local(()=>this.state.observerRead(draft=>{const stream=draft.observer;
    if(!this.#current())this.#off();
    if(!this.#live.connected)return stream?.session_id&&!stream.disconnect_sent&&this.#disconnectedSession!==stream.session_id?{request:{schema_version:1,kind:'disconnect',home_id:this.homeId,
      agent_id:this.agentId,session_id:stream.session_id},offlineContinuity:{...this.#live}}:{idle:true};
    if(!stream?.connected||stream.connection_id!==this.#live.connection_id)return {idle:true};
    const continuity={...this.#live};
    if(stream.needs_reset){
      if(this.#begin?.reset_id!==stream.reset_id)this.#begin={reset_id:stream.reset_id,client_sent_at:instant(this.clock())};
      return {request:{schema_version:1,kind:'begin',home_id:this.homeId,agent_id:this.agentId,
        reset_id:stream.reset_id,previous_session:stream.previous_session,connection_id:stream.connection_id,loss_counter:stream.loss_counter,
        client_sent_at:this.#begin.client_sent_at},expected:stream,continuity};
    }
    if(draft.events.length===0&&this.clock()-this.#lastHeartbeat<5000)return {idle:true};
    const events=draft.events.map(event=>({...event,sequence:event.observer_sequence}));
    const checkpoint=observerQueueCheckpoint({homeId:this.homeId,agentId:this.agentId,epoch:stream.session_id,
      producedSequence:stream.produced_sequence,acknowledgedSequence:stream.acknowledged_sequence,
      lossCounter:stream.loss_counter,events,connected:true,now:this.clock()});
    return {request:{schema_version:1,kind:draft.events.length?'event':'heartbeat',home_id:this.homeId,agent_id:this.agentId,
      session_id:stream.session_id,checkpoint,...(draft.events.length?{event:copy(draft.events[0]),
        ...(stream.acknowledged_sequence===0?{reset_token:stream.reset_token,reset_capture:copy(stream.reset_capture)}:{})}: {})},continuity};
    }));
  }
  async #ack(response,request,continuity){
    this.#assertCurrent(continuity);
    if(response?.status!=='committed'||response.home_id!==this.homeId||response.agent_id!==this.agentId||
      response.receipt?.epoch!==request.session_id||response.receipt.event_id!==request.event.event_id||
      response.receipt.sequence!==request.event.observer_sequence||response.receipt.status!=='committed')throw failure('observer_receipt_invalid');
    await this.#local(()=>this.state.observerTransaction(draft=>{
      this.#assertCurrent(continuity);
      const stream=draft.observer,first=draft.events[0];
      if(stream.session_id!==request.session_id||stream.needs_reset||first?.event_id!==request.event.event_id||
        first?.observer_sequence!==response.receipt.sequence)throw failure('observer_receipt_superseded');
      draft.events.shift();stream.acknowledged_sequence=response.receipt.sequence;
      if(stream.acknowledged_sequence===1){delete stream.reset_token;delete stream.reset_capture;}
    }),continuity.connection_id);
    this.#assertCurrent(continuity);
  }
  async #disconnected(response,packet){
    const {request,offlineContinuity}=packet;
    if(response?.home_id!==this.homeId||response.agent_id!==this.agentId||
      !(response.status==='offline'&&response.session_id===request.session_id||
        response.status==='reset_required'&&(response.current_session===null||id(response.current_session))))throw failure('observer_disconnect_invalid');
    // A reset-required reply also confirms that this old session is unusable.
    // Remember it before any disk await, including on a persistently full disk.
    this.#disconnectedSession=request.session_id;
    const sameOffline=()=>!this.#live.connected&&this.#live.generation===offlineContinuity.generation&&
      this.#live.connection_id===offlineContinuity.connection_id;
    if(!sameOffline())return;
    await this.#local(()=>this.state.observerTransaction(draft=>{
      const stream=draft.observer;
      if(!sameOffline()||stream.session_id!==request.session_id||stream.connection_id!==offlineContinuity.connection_id)return;
      stream.disconnect_sent=true;
      if(response.status==='reset_required'){
        stream.connected=false;stream.previous_session=response.current_session;stream.session_id=null;
        stream.needs_reset=true;stream.reset_id=randomUUID();stream.loss_counter++;
        stream.last_reason='server_reset_while_offline';
        delete stream.reset_token;delete stream.reset_capture;
      }
    }),offlineContinuity.connection_id);
  }
  step(){const run=this.#lock.catch(()=>{}).then(async()=>{
    let packet;
    try{packet=await this.#packet();}catch(error){await this.reset(error.code||'observer_queue_invalid');return {status:'reset_pending'};}
    if(packet.idle)return {status:'offline'};
    if(packet.continuity)this.#assertCurrent(packet.continuity);
    const response=await this.client.observerExchange(packet.request);
    const receivedAt=instant(this.clock());
    if(packet.continuity)this.#assertCurrent(packet.continuity);
    if(packet.request.kind==='disconnect'){
      await this.#disconnected(response,packet);return {status:'offline'};
    }
    if(response?.status==='reset_required'){
      await this.reset(response.reason||'server_reset_required',response.current_session);return {status:'reset_pending'};
    }
    if(packet.request.kind==='begin'){await this.#install(response,packet.expected,packet.continuity,packet.request.client_sent_at,receivedAt);return {status:'snapshot_pending'};}
    if(packet.request.kind==='event')await this.#ack(response,packet.request,packet.continuity);
    else {if(response?.status!=='current'||response.home_id!==this.homeId||response.agent_id!==this.agentId||response.session_id!==packet.request.session_id)throw failure('observer_heartbeat_invalid');this.#lastHeartbeat=this.clock();}
    return {status:packet.request.kind==='event'?'committed':'current'};
  });this.#lock=run;return run;}
}
