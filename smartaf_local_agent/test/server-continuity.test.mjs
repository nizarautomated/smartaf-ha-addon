import test from 'node:test';
import assert from 'node:assert/strict';
import { ServerContinuity } from '../src/server-continuity.mjs';
import { SupportStatusReporter } from '../src/support-status.mjs';

const a='server_00000000-0000-4000-a000-000000000001',b='server_00000000-0000-4000-a000-000000000002';
const response=(processId=a,token='000000000001',modern=true)=>({server_instance_id:`${processId}:00000000-0000-4000-a000-${token}`,...(modern?{server_process_id:processId}:{})});
test('server process and observer snapshot token have separate continuity effects',()=>{
  const c=new ServerContinuity();assert.deepEqual(c.observe(response()),{reset_support:false,request_snapshot:false,reason_code:'server_identity_unchanged'});
  assert.deepEqual(c.observe(response(a,'000000000002')),{reset_support:false,request_snapshot:true,reason_code:'household_resynchronization'});
  assert.equal(c.observe(response(a,'000000000002')).request_snapshot,false);
  assert.deepEqual(c.observe(response(b,'000000000003')),{reset_support:true,request_snapshot:true,reason_code:'control_plane_restart'});
});
test('legacy changes, field removal and identity ambiguity fail closed without fabricating a process id',()=>{
  for(const kind of ['legacy','downgrade','upgrade_changed']) {
    const c=new ServerContinuity();c.observe(response(a,'000000000001',kind==='downgrade'));
    const decision=c.observe(response(a,kind==='downgrade'?'000000000001':'000000000002',kind==='upgrade_changed'));
    assert.equal(decision.reset_support,true,kind);assert.equal(decision.request_snapshot,true,kind);
  }
  const c=new ServerContinuity();c.observe(response());
  for(const value of [null,{}, {...response(),server_process_id:null},{...response(),server_process_id:b},
    {...response(),server_instance_id:'private-marker'}, {...response(),server_process_id:'private-marker'},
    {...response(),server_instance_id:response().server_instance_id+'\n'}]) {
    assert.throws(()=>c.observe(value),error=>error.code==='invalid_server_identity'&&!error.message.includes('private-marker'));
  }
  assert.equal(c.observe(response()).reset_support,false); // malformed observations do not overwrite known identity
});
test('support status is bounded, structured and retains a short interruption across fast recovery',()=>{
  let now=0;const rows=[];const r=new SupportStatusReporter({emit:(event,details)=>rows.push({event,...details}),clock:()=>now});
  r.record({online:true});now=1;r.record({online:false,reason_code:'ha_disconnected'});now=2;r.record({online:true});
  assert.equal(rows.length,1);now=30_000;r.record({online:true});assert.equal(rows[1].reason_code,'ha_disconnected');
  now=60_000;r.record({online:true});assert.equal(rows[2].online,true);
  for(let i=0;i<100;i++){now++;r.record({online:false,reason_code:'private-marker'.repeat(10000),grant_id:'secret'});r.record({online:true});}
  assert.equal(rows.length,3);now=90_000;r.record({online:true});assert.equal(rows[3].reason_code,'support_transport_failed');
  assert.equal(JSON.stringify(rows).includes('private-marker'),false);assert.equal(JSON.stringify(rows).includes('secret'),false);
  now=1;r.record({online:false});assert.equal(rows.length,4);
});
