import { colorToRgb, parseColor } from '@earendil-works/pi-tui';
export const accents = {
  sage: 'oklch(68% 0.105 162)', cyan: 'oklch(72% 0.12 210)', blue: 'oklch(68% 0.14 255)',
  violet: 'oklch(73% 0.14 300)', rose: 'oklch(74% 0.14 355)', amber: 'oklch(78% 0.14 75)',
};
export function accentColor(config = {}) {
  try { return colorToRgb(parseColor(accents[config.accent] || config.accent || accents.sage)); }
  catch { return colorToRgb(parseColor(accents.sage)); }
}
export function accentText(text, config) { const {r,g,b}=accentColor(config); return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`; }
export function validAccent(value) { try { parseColor(accents[value] || value); return true; } catch { return false; } }

export function accentBadge(text,config) { const {r,g,b}=accentColor(config);return `\x1b[1m\x1b[48;2;${r};${g};${b}m\x1b[38;2;16;25;22m${text}\x1b[39;49m\x1b[22m`; }

// Shared by the composer, usage meter and command-line updater.
export function accentFlow(text,config,{time=Date.now(),offset=0,color=accentColor(config)}={}){
  if(config.animations===false)return accentText(text,config);
  const {r,g,b}=color;let output='',last=-1;
  for(const [i,c]of Array.from(text).entries()){
    const bucket=Math.round((0.5+0.5*Math.sin((i+offset)/11-time/850))*15);
    if(bucket!==last){const strength=0.75+Math.pow(bucket/15,2)*0.45;output+=`\x1b[38;2;${[r,g,b].map(n=>Math.min(255,Math.round(n*strength))).join(';')}m`;last=bucket;}
    output+=c;
  }
  return output+'\x1b[39m';
}
