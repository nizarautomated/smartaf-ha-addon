// Optional own-call evidence, never a human/legacy origin classifier.
const CONTEXT_ID = /^(?:[0-9A-HJKMNP-TV-Z]{26}|[a-f0-9]{32})$/;
const COMMAND_ID = /^cmd_[a-f0-9-]{36}$/;
const ENTITY_ID = /^[a-z][a-z0-9_]*\.[a-z0-9_]+$/;
const SERVICE = /^[a-z_]+\.[a-z_]+$/;
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const NUMERIC = {
  brightness_pct:[0,100],brightness:[0,255],transition:[0,3600],color_temp_kelvin:[1000,20000],color_temp:[1,1000],
  temperature:[-50,100],target_temp_low:[-50,100],target_temp_high:[-50,100],position:[0,100],volume_level:[0,1]
};
const ENUMS = {flash:['short','long'],hvac_mode:['off','heat','cool','heat_cool','auto','dry','fan_only']};
const FIELDS = {
  'light.turn_on':['brightness_pct','brightness','transition','color_temp_kelvin','color_temp','flash'],
  'light.turn_off':['transition'],
  'cover.set_cover_position':['position'],
  'climate.set_temperature':['temperature','target_temp_low','target_temp_high','hvac_mode'],
  'media_player.volume_set':['volume_level']
};
const EMPTY = new Set(['button.press','cover.open_cover','cover.close_cover','cover.stop_cover','input_boolean.turn_on','input_boolean.turn_off','input_boolean.toggle','switch.turn_on','switch.turn_off','switch.toggle','media_player.media_play','media_player.media_pause','media_player.media_stop','media_player.turn_on','media_player.turn_off','vacuum.start','vacuum.return_to_base']);

export function commandParameterSummary(service,data) {
  const allowed = Object.hasOwn(FIELDS,service) ? FIELDS[service] : EMPTY.has(service) ? [] : null;
  const parameters = {};
  if (!plain(data) || Object.keys(data).length > 64) return {parameters,parameters_complete:false};
  let complete = allowed !== null;
  for (const [key,descriptor] of Object.entries(Object.getOwnPropertyDescriptors(data))) {
    if (!Object.hasOwn(descriptor,'value') || !allowed?.includes(key)) {complete=false;continue;}
    const value=descriptor.value, range=Object.hasOwn(NUMERIC,key)&&NUMERIC[key];
    if (range && typeof value==='number' && Number.isFinite(value) && value>=range[0] && value<=range[1]) parameters[key]=value;
    else if (Object.hasOwn(ENUMS,key)&&ENUMS[key].includes(value)) parameters[key]=value;
    else complete=false;
  }
  return {parameters,parameters_complete:complete};
}

export function createCommandContext(command,haResult) {
  const contextId=plain(haResult)&&plain(haResult.context)&&haResult.context.id;
  if (typeof contextId!=='string'||!CONTEXT_ID.test(contextId)||!plain(command)||!COMMAND_ID.test(command.command_id||'')||command.type!=='call_service'||!SERVICE.test(command.service||'')||!ENTITY_ID.test(command.entity_id||'')) return undefined;
  return {schema_version:1,command_id:command.command_id,context_id:contextId,service:command.service,entity_id:command.entity_id,...commandParameterSummary(command.service,command.data)};
}

// Reconstruct retries from the known command; never forward arbitrary stored
// response fields, account IDs, parent contexts or free-form parameters.
export function commandContextForAcknowledgement(command,stored,status) {
  if (status!=='succeeded'||!plain(stored)||stored.schema_version!==1||stored.command_id!==command.command_id||stored.service!==command.service||stored.entity_id!==command.entity_id) return undefined;
  const expected=createCommandContext(command,{context:{id:stored.context_id}});
  if (!expected||!plain(stored.parameters)||stored.parameters_complete!==expected.parameters_complete) return undefined;
  const entries=Object.entries(expected.parameters);
  if(Object.keys(stored.parameters).length!==entries.length||entries.some(([key,value])=>stored.parameters[key]!==value))return undefined;
  return expected;
}
