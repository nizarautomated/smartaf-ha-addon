import test from 'node:test';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';
const saved={SMARTAF_HOME_ID:'home_alpha',SMARTAF_AGENT_ID:'agent_alpha',SMARTAF_AGENT_TOKEN:'x'.repeat(40),SMARTAF_CONTROL_PLANE_URL:'https://example.test',SUPERVISOR_TOKEN:'local-test',SMARTAF_ALLOWED_SERVICES:'light.turn_on'};
test('unchanged saved configuration loads without the optional policy field',()=>{
  assert.equal(loadConfig(saved).accessPolicy,null);
  assert.equal(loadConfig({...saved,SMARTAF_ACCESS_POLICY_JSON:''}).accessPolicy,null);
});
test('invalid optional policy fails startup; explicit stop cannot become legacy',()=>{
  assert.throws(()=>loadConfig({...saved,SMARTAF_ACCESS_POLICY_JSON:'broken'}));
  assert.throws(()=>loadConfig({...saved,SMARTAF_ACCESS_POLICY_JSON:'{}'}));
  const stop={schema_version:1,home_id:'home_alpha',revision:1,enabled:false,runtime:{permissions:[]},telemetry:{entities:[]},support:{enabled:false,operators:[],entities:[],actions:[]}};
  assert.equal(loadConfig({...saved,SMARTAF_ACCESS_POLICY_JSON:JSON.stringify(stop)}).accessPolicy.enabled,false);
});

test('solar history remains optional inside the existing policy and adds no runtime permission',()=>{
  const policy={schema_version:1,home_id:'home_alpha',revision:1,enabled:true,runtime:{permissions:[]},telemetry:{entities:['sun.sun']},support:{enabled:false,operators:[],entities:[],actions:[]}};
  const load=value=>loadConfig({...saved,SMARTAF_ACCESS_POLICY_JSON:JSON.stringify(value)});
  assert.equal(load(policy).accessPolicy.telemetry.solar_history,undefined);
  const configured=structuredClone(policy);
  configured.telemetry.solar_history={timezone:'Europe/Amsterdam',source_entities:{sunrise:'sensor.sun_next_rising',sunset:'sensor.sun_next_setting'},configuration_epoch:'solar_config_test_001'};
  const result=load(configured);
  assert.deepEqual(result.accessPolicy.telemetry.solar_history,configured.telemetry.solar_history);
  assert.deepEqual(result.accessPolicy.runtime.permissions,[]);
  assert.equal(result.supportConsent.enabled,false);
  delete configured.telemetry.solar_history.configuration_epoch;
  assert.throws(()=>load(configured));
  assert.deepEqual(load(policy).accessPolicy.telemetry.entities,['sun.sun']);
});
