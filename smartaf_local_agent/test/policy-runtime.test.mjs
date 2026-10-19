import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAccessPolicy } from '../src/access-policy.mjs';
import { enforceLocalPolicy } from '../src/policy-runtime.mjs';
const homeId='home_alpha', now=Date.parse('2026-10-19T15:00:00Z');
const policy=compileAccessPolicy({schema_version:1,home_id:homeId,revision:1,enabled:true,runtime:{permissions:[{entity_id:'light.room',service:'light.turn_on',parameters:{brightness_pct:{type:'number',min:1,max:80}},required:['brightness_pct']}]},telemetry:{entities:['light.room']},support:{enabled:false,operators:[],entities:[],actions:[]}},{homeId});
const command={home_id:homeId,policy_revision:1,entity_id:'light.room',service:'light.turn_on',data:{brightness_pct:40},not_before:new Date(now-1000).toISOString(),expires_at:new Date(now+1000).toISOString()};
const client=()=>({connected:true,getStates:async()=>[{entity_id:'light.room',state:'off',attributes:{}}],getEntityRegistry:async()=>[{entity_id:'light.room',platform:'zha',disabled_by:null}]});
test('strict runtime integration reads actual registry and rechecks expiry/connection after reading',async()=>{
  const options={policy,homeId,client:client(),clock:()=>now};
  assert.equal((await enforceLocalPolicy(command,options)).mode,'strict');
  await assert.rejects(enforceLocalPolicy(command,{...options,isCurrentClient:()=>false}),{code:'policy_ha_disconnected'});
  await assert.rejects(enforceLocalPolicy(command,{...options,clock:()=>now+1001}),{code:'runtime_deadline'});
  await assert.rejects(enforceLocalPolicy(command,{...options,client:{...client(),getEntityRegistry:async()=>[]}}),{code:'runtime_target_not_direct'});
  await assert.rejects(enforceLocalPolicy(command,{...options,client:{...client(),getStates:async()=>[{entity_id:'light.room',state:'off',attributes:{entity_id:['light.private']}}]}}),{code:'runtime_target_not_direct'});
});
test('unavailable metadata times out closed; disabled policy cannot trigger HA reads or allow execution',async()=>{
  await assert.rejects(enforceLocalPolicy(command,{policy,homeId,client:{...client(),getStates:()=>new Promise(()=>{})},clock:()=>now,timeoutMs:5}),{code:'policy_metadata_timeout'});
  await assert.rejects(enforceLocalPolicy(command,{policy,homeId,client:{...client(),getEntityRegistry:async()=>{throw Error('admin required');}},clock:()=>now}),{code:'policy_metadata_unavailable'});
});
test('legacy compatibility still rejects support work through runtime channel',async()=>{
  assert.equal((await enforceLocalPolicy(command,{policy:null,homeId,client:null,clock:()=>now})).mode,'legacy');
  await assert.rejects(enforceLocalPolicy({...command,access_scope:'support'},{policy:null,homeId,clock:()=>now}),{code:'runtime_support_separation'});
});
