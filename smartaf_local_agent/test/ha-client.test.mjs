import test from 'node:test';
import assert from 'node:assert/strict';
import {HomeAssistantWebSocketClient,subscribeHomeAssistantObservations} from '../src/ha-client.mjs';

test('optional admin-only service subscription denial preserves permitted state subscription',async()=>{
  for(const code of ['unauthorized','not_allowed']){
    const calls=[];const handler=()=>{};
    const client={subscribeStateChanges:async selected=>{assert.equal(selected,handler);calls.push('state_changed');},subscribeEvent:async type=>{calls.push(type);throw Object.assign(new Error('no permission'),{code});}};
    assert.deepEqual(await subscribeHomeAssistantObservations(client,handler),{service_observations:false});
    assert.deepEqual(calls,['state_changed','call_service']);
  }
});

test('successful optional subscription is reported, unrelated and state subscription errors remain failures',async()=>{
  assert.deepEqual(await subscribeHomeAssistantObservations({subscribeStateChanges:async()=>{},subscribeEvent:async()=>{}},()=>{}),{service_observations:true});
  await assert.rejects(subscribeHomeAssistantObservations({subscribeStateChanges:async()=>{throw new Error('state_denied');},subscribeEvent:async()=>assert.fail('must not run')},()=>{}),/state_denied/);
  await assert.rejects(subscribeHomeAssistantObservations({subscribeStateChanges:async()=>{},subscribeEvent:async()=>{throw Object.assign(new Error('offline'),{code:'ha_disconnected'});}},()=>{}),/offline/);
});

test('actual WebSocket client returns the own-call context without sending a client-supplied context',async()=>{
  const sent=[],context={id:'01J9Z7K1M3S8TQ0Y6E4H2B5N7C',user_id:'PRIVATE_ACCOUNT'};
  class Socket extends EventTarget {
    constructor(){super();queueMicrotask(()=>this.message({type:'auth_required'}));}
    message(data){this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify(data)}));}
    send(raw){const value=JSON.parse(raw);sent.push(value);queueMicrotask(()=>this.message(value.type==='auth'?{type:'auth_ok'}:{id:value.id,type:'result',success:true,result:{context}}));}
    close(){this.dispatchEvent(new Event('close'));}
  }
  const client=await new HomeAssistantWebSocketClient({url:'ws://local.invalid',token:'local-test-only',WebSocketImpl:Socket}).connect();
  const result=await client.callService({domain:'light',service:'turn_on',service_data:{entity_id:'light.example',brightness_pct:80},context:{id:'spoofed'}});
  assert.deepEqual(result,{context});
  const request=sent.find(value=>value.type==='call_service');
  assert.equal(request.return_response,false);assert.equal('context' in request,false);
  client.close();
});
