import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {commandParameterSummary,createCommandContext} from '../src/command-provenance.mjs';
import {acknowledgeCommandResult,executeCommandAttempt} from '../src/command-execution.mjs';
import {acknowledgement} from '../src/protocol.mjs';
import {DurableAgentState} from '../src/durable-state.mjs';

const command={command_id:'cmd_123e4567-e89b-12d3-a456-426614174000',type:'call_service',service:'light.turn_on',entity_id:'light.example',data:{brightness_pct:80,transition:0}};
const contextId='01J9Z7K1M3S8TQ0Y6E4H2B5N7C';
const response={context:{id:contextId,user_id:'PRIVATE_ACCOUNT',parent_id:'PRIVATE_PARENT'},response:{message:'PRIVATE_RESPONSE'}};

test('own-call evidence preserves only opaque context and safe command parameters',()=>{
  const context=createCommandContext(command,response);
  assert.deepEqual(context,{schema_version:1,command_id:command.command_id,context_id:contextId,service:command.service,entity_id:command.entity_id,parameters:command.data,parameters_complete:true});
  assert.ok(!JSON.stringify(context).includes('PRIVATE'));
  assert.equal('origin' in context,false);
  assert.equal(createCommandContext(command,{context:{id:'a'.repeat(32)}}).context_id,'a'.repeat(32));
});

test('absent malformed or oversized HA context never manufactures own-call evidence',()=>{
  for(const value of [undefined,null,{}, {context:null},{context:{id:''}},{context:{id:'../private'}},{context:{id:'a'.repeat(4097)}},{context:{id:123}}])assert.equal(createCommandContext(command,value),undefined);
  assert.equal(createCommandContext({...command,type:'unsupported'},response),undefined);
});

test('private unknown indirect and invalid parameters remain incomplete and unexported',()=>{
  for(const data of [{...command.data,message:'PRIVATE_TEXT'},{brightness_pct:101},{brightness_pct:NaN},{brightness_pct:'80'},{entity_id:'light.other'},{transition:-1},{flash:'PRIVATE_FLASH'}]){
    const summary=commandParameterSummary('light.turn_on',data);
    assert.equal(summary.parameters_complete,false);
    assert.ok(!JSON.stringify(summary).includes('PRIVATE'));
  }
  assert.deepEqual(commandParameterSummary('notify.send_message',{message:'PRIVATE'}),{parameters:{},parameters_complete:false});
  assert.deepEqual(commandParameterSummary('scene.turn_on',{}),{parameters:{},parameters_complete:false});
  assert.deepEqual(commandParameterSummary('switch.turn_off',{}),{parameters:{},parameters_complete:true});
  assert.deepEqual(commandParameterSummary('cover.set_cover_position',{position:40}),{parameters:{position:40},parameters_complete:true});
});

test('ACKs remain backwards compatible and reconstruction never exports arbitrary stored fields',()=>{
  const legacy=acknowledgement(command,'agent_example_001','succeeded');
  assert.equal('command_context' in legacy,false);
  const receipt=createCommandContext(command,response);
  const ack=acknowledgement(command,'agent_example_001','succeeded',{commandContext:{...receipt,user_id:'PRIVATE_USER',response:'PRIVATE_RESPONSE'}});
  assert.deepEqual(ack.command_context,receipt);
  assert.ok(!JSON.stringify(ack).includes('PRIVATE'));
  for(const status of ['failed','expired','rejected','executing'])assert.equal('command_context' in acknowledgement(command,'agent_example_001',status,{commandContext:receipt}),false);
  for(const patch of [{command_id:'cmd_223e4567-e89b-12d3-a456-426614174000'},{service:'light.turn_off'},{entity_id:'light.other'},{parameters:{brightness_pct:1}},{parameters_complete:false}])assert.equal('command_context' in acknowledgement(command,'agent_example_001','succeeded',{commandContext:{...receipt,...patch}}),false);
});

test('execution records intent before calling HA and preserves successful receipt across ACK failure and restart',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'smartaf-command-context-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const state=await new DurableAgentState({dataDir}).init();let calls=0;
  const result=await executeCommandAttempt(command,{recordResult:value=>state.recordCommandResult(value),perform:async()=>{assert.equal((await state.commandResult(command.command_id)).status,'executing');calls++;return response;}});
  await assert.rejects(acknowledgeCommandResult(command,result,{agentId:'agent_example_001',acknowledge:async()=>{throw new Error('ack_transport_failed');}}),/ack_transport_failed/);
  const restarted=await new DurableAgentState({dataDir}).init();
  const saved=await restarted.commandResult(command.command_id);
  assert.equal(saved.status,'succeeded');assert.deepEqual(saved.command_context,result.command_context);
  const retry=await acknowledgeCommandResult(command,saved,{agentId:'agent_example_001',acknowledge:async value=>value});
  assert.deepEqual(retry.command_context,result.command_context);assert.equal(calls,1);
  assert.ok(!JSON.stringify(saved).includes('PRIVATE'));
});

test('an interrupted executing record never promotes old evidence when acknowledging after restart',async()=>{
  const receipt=createCommandContext(command,response);
  const ack=await acknowledgeCommandResult(command,{status:'executing',command_context:receipt},{agentId:'agent_example_001',acknowledge:async value=>value});
  assert.equal(ack.status,'failed');assert.equal(ack.error_code,'execution_outcome_unknown');assert.equal('command_context' in ack,false);
});

test('execution error or safety rejection never carries an HA receipt',async()=>{
  for(const [error,status] of [[Object.assign(new Error('unavailable'),{code:'ha_disconnected'}),'failed'],[Object.assign(new Error('blocked'),{code:'runtime_denied',safetyRejection:true}),'rejected'],[Object.assign(new Error('old'),{code:'command_expired',safetyRejection:true}),'expired']]){
    const saved=[];
    const result=await executeCommandAttempt(command,{recordResult:async value=>saved.push(structuredClone(value)),perform:async()=>{throw error;}});
    assert.deepEqual(saved.map(value=>value.status),['executing',status]);assert.equal('command_context' in result,false);
  }
});

test('post-call persistence failure does not mislabel successful execution as a new failed attempt',async()=>{
  const saved=[];let calls=0;
  await assert.rejects(executeCommandAttempt(command,{recordResult:async value=>{saved.push(structuredClone(value));if(value.status==='succeeded')throw new Error('disk_failure');},perform:async()=>{calls++;return response;}}),/disk_failure/);
  assert.equal(calls,1);assert.deepEqual(saved.map(value=>value.status),['executing','succeeded']);
});
