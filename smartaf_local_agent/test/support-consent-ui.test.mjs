import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { renderSupportConsentPage } from '../src/support-consent-ui.mjs';

// Execute the actual inline UI with a text-only DOM. An HTML sink fails the
// test; this proves rendering boundaries, not real HA Ingress/browser layout.
class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.textContent = ''; }
  addEventListener() {}
  set innerHTML(_value) { throw new Error('Unsafe HTML sink'); }
}
const text = element => [element.textContent, ...element.children.map(text)].join('\n');
const grant = { home_id:'home_fixture', operator_id:'operator_fixture', incident_id:'incident_fixture', actions:['read_entity_availability'], entities:['light.kitchen','light.hall'], issued_at:'2026-10-19T18:00:00Z', expires_at:'2026-10-19T18:30:00Z' };
async function render(display, value = grant) {
  const elements = new Map(), created = [];
  const document = {
    querySelector: selector => ({ content: selector.includes('support-csrf') ? 'synthetic' : '/synthetic' }),
    querySelectorAll: () => [],
    getElementById: id => { if (!elements.has(id)) elements.set(id,new Element()); return elements.get(id); },
    createElement: tag => { created.push(tag); return new Element(tag); }
  };
  const context = vm.createContext({ document, incomingDisplay:display, grant:value, target:new Element(), fetch:async()=>({ ok:true,json:async()=>({ enabled:true,connected:true,proposals:[],grants:[],entities:['light.kitchen','light.hall'] }) }) });
  const page=renderSupportConsentPage({nonce:'synthetic',csrf:'synthetic',basePath:'/synthetic'});
  const script=page.match(/<script nonce="synthetic">([\s\S]*)<\/script>/)[1];
  vm.runInContext(script,context);await new Promise(resolve=>setImmediate(resolve));
  vm.runInContext('display=incomingDisplay;details(target,grant)',context);
  return { element:context.target, created };
}
test('support review shows local names with the exact original technical scope',async()=>{
  const {element}=await render({home_name:'Mijn woning',entities:{'light.kitchen':'Keukenlamp','light.hall':'Ganglamp'}});
  const content=text(element);assert.match(content,/Woning: Mijn woning/);assert.match(content,/Keukenlamp/);assert.match(content,/Supportaccount: operator_fixture/);
  const technical=element.children.find(child=>child.tag==='details');assert.ok(technical);assert.match(text(technical),/home_fixture/);assert.match(text(technical),/incident_fixture/);assert.match(text(technical),/read_entity_availability/);assert.match(text(technical),/Keukenlamp — light.kitchen/);assert.match(text(technical),/Ganglamp — light.hall/);
});
test('identical local names are disambiguated before the technical details are expanded',async()=>{
  const {element}=await render({entities:{'light.kitchen':'Lamp','light.hall':'Lamp'}});
  const visible=element.children.filter(child=>child.tag!=='details').map(text).join('\n');
  assert.match(visible,/Lamp \(light.kitchen\)/);assert.match(visible,/Lamp \(light.hall\)/);
});
test('a single requested device remains distinguishable from an unrequested same-name device',async()=>{
  for(const labels of [{'light.kitchen':'Lamp','light.hall':'lamp'},{'light.kitchen':'Café','light.hall':'Cafe\u0301'},{'light.kitchen':'light.hall'}]){
    const {element}=await render({entities:labels},{...grant,entities:['light.kitchen']});
    const visible=element.children.filter(child=>child.tag!=='details').map(text).join('\n');
    assert.ok(visible.includes(labels['light.kitchen']+' (light.kitchen)'));
  }
});
test('missing labels fall back to exact IDs and markup-like labels remain literal text',async()=>{
  const value='<img src=x onerror=alert(1)>', {element,created}=await render({home_name:value,entities:{'light.kitchen':value}});
  assert.ok(text(element).includes(value));assert.ok(text(element).includes('light.hall'));assert.equal(created.includes('img'),false);assert.equal(created.includes('script'),false);
  const fallback=await render({entities:{}});assert.match(text(fallback.element),/Woning: home_fixture/);
});
