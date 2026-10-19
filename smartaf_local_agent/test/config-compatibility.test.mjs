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
