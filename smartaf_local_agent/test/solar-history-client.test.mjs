import test from 'node:test';
import assert from 'node:assert/strict';
import { HomeAssistantWebSocketClient } from '../src/ha-client.mjs';

const config = () => ({ homeId:'home_synthetic',timezone:'Europe/Amsterdam',sourceEntities:{sunrise:'sensor.sunrise_selected',sunset:'sensor.sunset_selected'},
  connectionEpoch:'connection_epoch_001',configurationEpoch:'configuration_epoch_001',now:Date.parse('2026-10-19T13:00:00Z') });
async function socketClient(respond) {
  const sent=[];
  class Socket extends EventTarget {
    constructor(){super();queueMicrotask(()=>this.message({type:'auth_required'}));}
    message(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
    send(raw){const value=JSON.parse(raw);sent.push(value);if(value.type==='auth')queueMicrotask(()=>this.message({type:'auth_ok'}));else respond?.(value,this);}
    close(){this.dispatchEvent(new Event('close'));}
  }
  return {client:await new HomeAssistantWebSocketClient({url:'ws://synthetic.invalid',token:'test-only',WebSocketImpl:Socket}).connect(),sent};
}

test('real client sends only the fixed two-sensor history query and cleans pending state on success',async()=>{
  const {client,sent}=await socketClient((q,s)=>queueMicrotask(()=>s.message({type:'result',id:q.id,success:true,result:{sample:[]}})));
  assert.deepEqual(await client.getSolarHistory(config()),{sample:[]});
  const q=sent.find(q=>q.type!=='auth');assert.equal(q.type,'history/history_during_period');assert.deepEqual(q.entity_ids,Object.values(config().sourceEntities));
  assert.equal(q.no_attributes,true);assert.equal(q.minimal_response,false);assert.equal(q.include_start_time_state,true);
  assert.equal(Date.parse(q.end_time)-Date.parse(q.start_time),36*3600000);assert.equal(client.pending.size,0);assert.equal(client.solarHistoryPending,false);
  await assert.rejects(client.getSolarHistory({...config(),sourceEntities:{...config().sourceEntities,extra:'sensor.secret'}}));
  await assert.rejects(client.getSolarHistory({...config(),query:{type:'call_service'}}));assert.equal(sent.length,2);client.close();
});

test('one history request per connection, timeout removes its response slot, late response cannot revive it',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {client,sent}=await socketClient();
  const pending=client.getSolarHistory(config());const rejected=assert.rejects(pending,{code:'ha_request_timeout'});
  await assert.rejects(client.getSolarHistory(config()),{code:'ha_solar_history_pending'});
  t.mock.timers.tick(5000);await rejected;
  assert.equal(client.pending.size,0);assert.equal(client.solarHistoryPending,false);
  client.socket.message({type:'result',id:sent[1].id,success:true,result:{old:'must be discarded'}});assert.equal(client.pending.size,0);
  const next=client.getSolarHistory(config());const disconnected=assert.rejects(next,{code:'ha_disconnected'});client.close();await disconnected;
  assert.equal(client.pending.size,0);assert.equal(client.solarHistoryPending,false);
});

test('oversized response is refused before exposing a result, errors never acquire extra history privileges',async()=>{
  for(const response of [{success:true,result:{payload:'x'.repeat(65536)}},{success:false,error:{code:'unauthorized',message:'denied'}}]) {
    const {client}=await socketClient((q,s)=>queueMicrotask(()=>s.message({type:'result',id:q.id,...response})));
    await assert.rejects(client.getSolarHistory(config()),{code:response.success?'ha_response_too_large':'unauthorized'});
    assert.equal(client.pending.size,0);assert.equal(client.solarHistoryPending,false);client.close();
  }
});
