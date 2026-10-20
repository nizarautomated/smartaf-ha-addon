import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAccessPolicy, selectTelemetry } from '../src/access-policy.mjs';
import { eventFromHomeAssistant, stateSnapshotFromHomeAssistant } from '../src/protocol.mjs';

const homeId = 'home_presence_test', entity = 'person.resident', at = '2026-10-20T12:00:00.000Z';
const config = () => ({ schema_version: 1, home_id: homeId, revision: 1, enabled: true, runtime: { permissions: [] },
  telemetry: { entities: [entity, 'light.room'], state_values: { [entity]: ['home', 'not_home', 'unknown', 'unavailable'] },
    presence_categories: { [entity]: { schema_version: 1, configuration_epoch: 'a'.repeat(32), near_home_values: ['Near Area', 'Near_Area'], known_zone_values: ['Private Office', 'Private Gym'] } } } });
const selected = (value, input = config(), metadata = {}) => selectTelemetry(eventFromHomeAssistant({ homeId, agentId: 'agent_presence_test', sequence: 1,
  event: { event_type: 'state_changed', time_fired: at, data: { entity_id: entity, old_state: {state:'Private Office'},
    new_state: {state:value, last_changed:at, attributes:{latitude:52, longitude:4, ssid:'Secret Wifi', ...metadata}} } } }),
  { homeId, policy: compileAccessPolicy(input, {homeId}) });

test('opt-in maps only explicit local labels; category has no away/household decision', () => {
  for (const [raw, expected] of [['home','home'], ['HOME','home'], ['Near Area','near_home'], ['NEAR_AREA','near_home'],
    ['Private Office','known_zone'], ['PRIVATE GYM','known_zone'], ['not_home','not_home'], ['unknown','unknown'],
    ['unavailable','unavailable'], ['Unlisted private zone','unknown'], ['', 'unknown'], [' Private Office','unknown']]) {
    const event = selected(raw);
    assert.equal(event.metadata.presence_category.category, expected);
    assert.equal(event.new_state, ['home','not_home','unknown','unavailable'].includes(raw) ? raw : 'unknown');
    assert.equal(event.old_state, 'unknown');
    assert.equal(event.metadata.presence_category.entity_id, entity);
    assert.equal(event.metadata.presence_category.observed_at, at);
    assert.equal(event.metadata.presence_category.last_changed, at);
    assert.deepEqual(Object.keys(event.metadata).sort(), ['last_changed','presence_category','restored']);
    for (const secret of ['Private Office', 'Private Gym', 'Near Area', 'Secret Wifi', 'latitude', 'longitude']) assert(!JSON.stringify(event).includes(secret));
  }
});

test('snapshot and event use the same category and preserve original state-change time', () => {
  const policy = compileAccessPolicy(config(), {homeId});
  const event = stateSnapshotFromHomeAssistant({homeId, agentId:'agent_presence_test', capturedAt:at, states:[
    {entity_id:entity,state:'Private Gym',last_changed:'2026-10-20T11:00:00Z',attributes:{latitude:52}},
    {entity_id:'person.unselected',state:'Secret Location',last_changed:at},
    {entity_id:'light.room',state:'on',last_changed:at}
  ]});
  const result = selectTelemetry(event, {homeId,policy});
  assert.equal(result.payload.states.length, 2);
  const value = result.payload.states[0];
  assert.equal(value.state, 'unknown');
  assert.equal(value.metadata.presence_category.category, 'known_zone');
  assert.equal(value.metadata.presence_category.last_changed, '2026-10-20T11:00:00.000Z');
  assert(!result.payload.states[1].metadata.presence_category);
  assert(!JSON.stringify(result).includes('Private'));
});

test('omitted configuration preserves old selected payload exactly and drops caller-supplied fact', () => {
  const input = config(); delete input.telemetry.presence_categories;
  const event = selected('Near Area', input);
  assert.deepEqual(event.metadata, {last_changed:at,restored:false});
  event.metadata.presence_category = {schema_version:1,category:'not_home'};
  assert.deepEqual(selectTelemetry(event, {homeId,policy:compileAccessPolicy(input,{homeId})}).metadata, {last_changed:at,restored:false});
});

test('restored, missing/invalid or future change time never produces a trusted fact', () => {
  assert.equal(selected('not_home', config(), {restored:true}).metadata.presence_category, undefined);
  const policy = compileAccessPolicy(config(),{homeId}), base = selected('home');
  for (const metadata of [{restored:false}, {restored:false,last_changed:'bad'}, {restored:false,last_changed:'2026-10-20T12:00:01.000Z'}, {restored:true,last_changed:at}, {last_changed:at}]) {
    assert.equal(selectTelemetry({...base,metadata},{homeId,policy}).metadata?.presence_category, undefined);
  }
});

test('strict optional config rejects unselected/non-person entities, missing four-value filter and unsafe shapes', () => {
  const bad = [p=>{p.telemetry.entities=[];},p=>{p.telemetry.presence_categories['light.room']=p.telemetry.presence_categories[entity];delete p.telemetry.presence_categories[entity];},
    p=>{delete p.telemetry.state_values;},p=>{p.telemetry.state_values[entity].push('Private Office');},
    p=>{p.telemetry.presence_categories={};},p=>{p.telemetry.presence_categories[entity].extra=true;},
    p=>{p.telemetry.presence_categories[entity].schema_version=2;},p=>{p.telemetry.presence_categories[entity].configuration_epoch='private-zone';},
    p=>{p.telemetry.presence_categories[entity].near_home_values=null;}];
  for (const mutate of bad) { const input=config();mutate(input);assert.throws(()=>compileAccessPolicy(input,{homeId})); }
});

test('labels are bounded, distinct after casefold, and exclude canonical values/control/bidi/surrogates', () => {
  for (const value of ['home','HOME','not_home','unknown','unavailable','Near Area','near_area',' private','private ', 'x\nzone','x\u202ezone','x\uD800zone','x'.repeat(97)]) {
    const input=config();input.telemetry.presence_categories[entity].known_zone_values.push(value);
    assert.throws(()=>compileAccessPolicy(input,{homeId}), value);
  }
  for (const [key,count] of [['near_home_values',9],['known_zone_values',33]]) {
    const input=config();input.telemetry.presence_categories[entity][key]=Array.from({length:count},(_,i)=>`Zone ${i}`);
    assert.throws(()=>compileAccessPolicy(input,{homeId}));
  }
});

test('separate people require separate opaque epochs; at most eight people opt in', () => {
  for (const count of [2,9]) {
    const input=config(), original=input.telemetry.presence_categories[entity];
    for(let i=1;i<count;i++) {const id=`person.resident_${i}`;input.telemetry.entities.push(id);input.telemetry.state_values[id]=input.telemetry.state_values[entity];
      input.telemetry.presence_categories[id]={...original,configuration_epoch:count===2?original.configuration_epoch:i.toString(16).padStart(32,'0')};}
    assert.throws(()=>compileAccessPolicy(input,{homeId}));
  }
});

test('classification cannot widen runtime or support permissions; disabled policy emits nothing', () => {
  const input=config(), policy=compileAccessPolicy(input,{homeId});
  assert.deepEqual(policy.runtime.permissions, []);assert.equal(policy.support.enabled,false);
  input.enabled=false;
  assert.equal(selectTelemetry(selected('home'),{homeId,policy:compileAccessPolicy(input,{homeId})}),null);
});

test('all documented upper bounds are accepted without raw-value export', () => {
  const input=config();
  const first=input.telemetry.presence_categories[entity];
  first.near_home_values=Array.from({length:8},(_,i)=>`Near ${i}`);
  first.known_zone_values=Array.from({length:31},(_,i)=>`Known ${i}`).concat('x'.repeat(96));
  for(let i=1;i<8;i++) {const id=`person.resident_${i}`;input.telemetry.entities.push(id);input.telemetry.state_values[id]=input.telemetry.state_values[entity];
    input.telemetry.presence_categories[id]={...first,configuration_epoch:i.toString(16).padStart(32,'0')};}
  const event=selected('x'.repeat(96),input);assert.equal(event.metadata.presence_category.category,'known_zone');assert(!JSON.stringify(event).includes('x'.repeat(96)));
});
