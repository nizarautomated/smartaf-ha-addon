import test from 'node:test';
import assert from 'node:assert/strict';
import { eventFromHomeAssistant, stateSnapshotFromHomeAssistant } from '../src/protocol.mjs';
const at='2026-10-19T15:00:00.000Z';
test('only restoration/timing and explicit sun fields leave the local adapter',()=>{
  const secret={user_id:'private-user',latitude:52,longitude:4,ssid:'private-network'};
  const state={entity_id:'binary_sensor.bed',state:'off',last_changed:at,attributes:{restored:true,...secret}};
  const event=eventFromHomeAssistant({homeId:'home_alpha',agentId:'agent_alpha',sequence:1,event:{event_type:'state_changed',time_fired:at,context:secret,data:{entity_id:state.entity_id,new_state:state}}});
  assert.deepEqual(event.metadata,{last_changed:at,restored:true});
  assert.equal(JSON.stringify(event).includes('private'),false);
  const snapshot=stateSnapshotFromHomeAssistant({homeId:'home_alpha',agentId:'agent_alpha',capturedAt:at,states:[{...state,entity_id:'sun.sun',attributes:{...secret,next_rising:'2026-10-20T06:00:00Z',next_setting:'2026-10-19T17:00:00Z'}},state]});
  assert.deepEqual(snapshot.payload.states[0].metadata.solar,{next_rising:'2026-10-20T06:00:00.000Z',next_setting:'2026-10-19T17:00:00.000Z'});
  assert.equal(JSON.stringify(snapshot).includes('latitude'),false);
});
