import { cleanTerminal } from './storage.mjs';
// Presentation only. Provider-qualified route IDs remain untouched internally.
export function modelLabel(model){
 const raw=typeof model==='string'?model:model?.id||model?.name||'';
 const id=raw.includes('/')?raw.slice(raw.lastIndexOf('/')+1):raw;
 return cleanTerminal(id).replace(/^(?:(?:global|us|eu|apac|in|jp|au|ap)\.)?(?:openai|anthropic|google|amazon|meta|mistralai|cohere|deepseek)[.:_-]/i,'').replace(/^gpt[- ]?/i,'').replace(/^claude[- ]?/i,'').replace(/[-_]/g,' ').replace(/\s+/g,' ').trim();
}
