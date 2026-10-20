import test from 'node:test';
import assert from 'node:assert/strict';
import { loadSupportConsentConfig } from '../src/support-consent-config.mjs';
import { loadConfig } from '../src/config.mjs';
import { SmartAFServerClient } from '../src/server-client.mjs';

const env={SMARTAF_HOME_ID:'home_alpha',SMARTAF_AGENT_ID:'agent_alpha',SMARTAF_AGENT_TOKEN:'a'.repeat(32),SMARTAF_CONTROL_PLANE_URL:'https://server.example.test',SUPERVISOR_TOKEN:'synthetic'};
const option={enabled:true,allowed_origins:['https://home.example.test'],allowed_user_ids:['a'.repeat(32)]};
test('optional local labels preserve old settings and invalid labels disable only support',()=>{
  const prior=loadSupportConsentConfig(JSON.stringify(option));
  assert.equal(Object.hasOwn(prior,'display'),false);
  const display={home_name:'Woning aan de tuin',entities:{'light.kitchen':'Keukenlamp'}};
  assert.deepEqual(loadSupportConsentConfig(JSON.stringify({...option,display})),{...prior,display});
  const invalid=[null,[],{operator_name:'Beheerder'},{home_name:''},{home_name:' x'},{home_name:'x\n'},{home_name:'x\u202ey'},{home_name:'x'.repeat(97)},{entities:{'bad/id':'Lamp'}},{entities:{'light.test':''}},{entities:{'light.test':true}},{entities:Object.fromEntries(Array.from({length:257},(_,i)=>['light.item_'+i,'Lamp']))}];
  for(const display of invalid){const config=loadConfig({...env,SMARTAF_SUPPORT_CONSENT_JSON:JSON.stringify({...option,display})});assert.equal(config.supportConsent.enabled,false);assert.equal(config.supportConsent.errorCode,'support_configuration_invalid');assert.equal(config.allowedServices.has('light.turn_on'),true);}
});
test('absent, disabled or malformed optional consent config preserves existing agent behavior',()=>{
  assert.deepEqual(loadConfig(env).supportConsent,{enabled:false});
  assert.deepEqual(loadSupportConsentConfig('{"enabled":false}'),{enabled:false});
  for(const value of ['{','{}',JSON.stringify({...option,port:80}),JSON.stringify({...option,allowed_origins:['http://home.example.test']}),JSON.stringify({...option,allowed_user_ids:['admin']})]) {
    const config=loadConfig({...env,SMARTAF_SUPPORT_CONSENT_JSON:value});
    assert.equal(config.supportConsent.enabled,false);assert.equal(config.allowedServices.has('light.turn_on'),true);
    assert.equal(config.supportConsent.errorCode,'support_configuration_invalid');
  }
  assert.equal(loadSupportConsentConfig(JSON.stringify(option),{secureTransport:false}).enabled,false);
  assert.equal(loadConfig({...env,SMARTAF_SUPPORT_CONSENT_JSON:JSON.stringify(option)}).supportConsent.port,8099);
});

test('support client uses only existing agent credential, bounded response, timeout and no redirects',async()=>{
  let options,path;
  const client=new SmartAFServerClient({baseUrl:'https://server.example.test',homeId:'home_alpha',agentId:'agent_alpha',token:'synthetic-token',fetchImpl:async(url,input)=>{path=url;options=input;return new Response('{"ok":true}',{status:200});}});
  assert.deepEqual(await client.supportExchange({protocol_version:1}),{ok:true});
  assert.equal(path,'https://server.example.test/v1/agents/home_alpha/support/exchange');assert.equal(options.redirect,'error');assert.equal(options.headers.authorization,'Bearer synthetic-token');assert.ok(options.signal);
  client.fetchImpl=async()=>new Response('x'.repeat(300001));
  await assert.rejects(client.supportExchange({}),{code:'support_response_too_large'});
  assert.throws(()=>client.supportExchange({raw:'x'.repeat(300001)}),{code:'support_request_too_large'});
});
