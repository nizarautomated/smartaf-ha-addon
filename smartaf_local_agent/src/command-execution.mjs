import { createCommandContext } from './command-provenance.mjs';
import { acknowledgement } from './protocol.mjs';

export function acknowledgeCommandResult(command,recorded,{agentId,acknowledge}={}) {
  const status=recorded.status==='executing'?'failed':recorded.status;
  const errorCode=recorded.status==='executing'?'execution_outcome_unknown':recorded.error_code;
  return acknowledge(acknowledgement(command,agentId,status,{errorCode,latencyMs:recorded.latency_ms,commandContext:recorded.command_context}));
}

// Transport acknowledgements deliberately happen after this function returns.
// An ACK outage must never turn a completed HA call into a failed execution.
export async function executeCommandAttempt(command,{perform,recordResult,clock=Date.now,monotonicClock=()=>performance.now()}={}) {
  const started=monotonicClock();
  await recordResult({command_id:command.command_id,status:'executing',occurred_at:new Date(clock()).toISOString()});
  let result;
  try {
    const response=await perform(command);
    const commandContext=createCommandContext(command,response);
    result={command_id:command.command_id,status:'succeeded',occurred_at:new Date(clock()).toISOString(),...(commandContext?{command_context:commandContext}:{})};
  } catch(error) {
    result={command_id:command.command_id,status:error.safetyRejection?(error.code==='command_expired'?'expired':'rejected'):'failed',occurred_at:new Date(clock()).toISOString(),error_code:error.code||'ha_call_failed'};
  }
  result.latency_ms=Number(Math.max(0,monotonicClock()-started).toFixed(3));
  // Do not turn a persistence failure into a second execution result either:
  // the durable pre-call record retains unknown outcome on process restart.
  await recordResult(result);
  return result;
}
