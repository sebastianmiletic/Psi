import { accentColor } from './theme.mjs';
import { colorToRgb, parseColor, truncateToWidth } from '@earendil-works/pi-tui';

// A small extruded mesh, shaded on the CPU. No canvas, native binary or animation dependency.
const COLUMNS = 23, ROWS = 29, DX = 2.3 / COLUMNS, DY = 2.9 / ROWS, DEPTH = 0.34;
const mask = Array.from({ length: ROWS }, (_, row) => Array.from({ length: COLUMNS }, (_, col) => {
  const x = (col + 0.5) * DX - 1.15, y = (row + 0.5) * DY - 1.45;
  const stem = Math.abs(x) < 0.155 && y > -1.35 && y < 1.35;
  const arms = Math.abs(x) > 0.72 && Math.abs(x) < 1.03 && y > -1.15 && y <= -0.35;
  const outer = (x / 1.03) ** 2 + ((y + 0.35) / 0.94) ** 2;
  const inner = (x / 0.72) ** 2 + ((y + 0.35) / 0.63) ** 2;
  return stem || arms || (y > -0.35 && outer <= 1 && inner >= 1);
}));
const mesh = [];
function face(points, normal) { mesh.push({ points, normal }); }
for (let row = 0; row < ROWS; row++) for (let col = 0; col < COLUMNS; col++) {
  if (!mask[row][col]) continue;
  const x = col * DX - 1.15, y = row * DY - 1.45, z = DEPTH / 2;
  face([[x,y,z],[x+DX,y,z],[x+DX,y+DY,z],[x,y+DY,z]], [0,0,1]);
  face([[x,y,-z],[x,y+DY,-z],[x+DX,y+DY,-z],[x+DX,y,-z]], [0,0,-1]);
  if (!mask[row][col-1]) face([[x,y,-z],[x,y,z],[x,y+DY,z],[x,y+DY,-z]], [-1,0,0]);
  if (!mask[row][col+1]) face([[x+DX,y,z],[x+DX,y,-z],[x+DX,y+DY,-z],[x+DX,y+DY,z]], [1,0,0]);
  if (!mask[row-1]?.[col]) face([[x,y,-z],[x+DX,y,-z],[x+DX,y,z],[x,y,z]], [0,-1,0]);
  if (!mask[row+1]?.[col]) face([[x,y+DY,z],[x+DX,y+DY,z],[x+DX,y+DY,-z],[x,y+DY,-z]], [0,1,0]);
}
const palettes=new Map();
function paletteFor(accent) {
  if(palettes.has(accent))return palettes.get(accent);
  const rgb=accentColor({accent});
  const palette=Array.from({length:20},(_,i)=>{const factor=0.35+i*0.047;const c=[rgb.r,rgb.g,rgb.b].map(n=>Math.min(255,Math.round(n*factor)));return{fg:`\x1b[38;2;${c.join(';')}m`,bg:`\x1b[48;2;${c.join(';')}m`};});
  if(palettes.size>16)palettes.clear();palettes.set(accent,palette);return palette;
}
function rotation(yaw, pitch, roll) {
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cx = Math.cos(pitch), sx = Math.sin(pitch), cz = Math.cos(roll), sz = Math.sin(roll);
  return ([x, y, z]) => {
    const xx = x * cy + z * sy, zz = -x * sy + z * cy;
    const yy = y * cx - zz * sx, zzz = y * sx + zz * cx;
    return [xx * cz - yy * sz, xx * sz + yy * cz, zzz];
  };
}
export function renderPsi(width, rows, phase = 0, animated = false, accent='sage') {
  width = Math.max(1, Math.floor(width)); rows = Math.max(1, Math.floor(rows));
  const palette=paletteFor(accent);
  const height = rows * 2;
  const pixels = new Int16Array(width * height).fill(-1), depth = new Float32Array(width * height).fill(-Infinity);
  const turn = rotation(animated ? 0.42 + phase * 0.72 : 0.42, animated ? -0.12 + Math.sin(phase * 0.63) * 0.24 : -0.12, animated ? Math.sin(phase * 0.4) * 0.09 : -0.04);
  const scale = Math.min(width / 3.15, height / 3.3);
  const edge = (a, b, x, y) => (x - a[0]) * (b[1] - a[1]) - (y - a[1]) * (b[0] - a[0]);
  function triangle(a, b, c, color) {
    const area = edge(a,b,c[0],c[1]); if (Math.abs(area) < 0.0001) return;
    const minX = Math.max(0, Math.floor(Math.min(a[0],b[0],c[0]))), maxX = Math.min(width-1, Math.ceil(Math.max(a[0],b[0],c[0])));
    const minY = Math.max(0, Math.floor(Math.min(a[1],b[1],c[1]))), maxY = Math.min(height-1, Math.ceil(Math.max(a[1],b[1],c[1])));
    for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
      const w0 = edge(b,c,x+0.5,y+0.5)/area, w1 = edge(c,a,x+0.5,y+0.5)/area, w2 = 1-w0-w1;
      if (w0 < -0.001 || w1 < -0.001 || w2 < -0.001) continue;
      const z = w0*a[2]+w1*b[2]+w2*c[2], i = y*width+x;
      if (z > depth[i]) { depth[i] = z; pixels[i] = color; }
    }
  }
  for (const surface of mesh) {
    const normal = turn(surface.normal); if (normal[2] < -0.15) continue;
    const light = Math.max(0, normal[0]*-0.35 + normal[1]*-0.45 + normal[2]*0.82);
    const color = Math.max(0, Math.min(19, Math.round(3 + light*16)));
    const points = surface.points.map(point => {
      const [x,y,z] = turn(point); const perspective = 5 / (5-z);
      return [width/2 + x*scale*perspective, height/2 + y*scale*perspective, z];
    });
    triangle(points[0],points[1],points[2],color); triangle(points[0],points[2],points[3],color);
  }
  const lines = [];
  for (let row = 0; row < rows; row++) {
    let line = '', last = '';
    for (let x = 0; x < width; x++) {
      const top = pixels[row*2*width+x], bottom = pixels[(row*2+1)*width+x];
      let style, glyph;
      if (top < 0 && bottom < 0) { style = '\x1b[39;49m'; glyph = ' '; }
      else if (bottom < 0) { style = palette[top].fg+'\x1b[49m'; glyph = '▀'; }
      else if (top < 0) { style = palette[bottom].fg+'\x1b[49m'; glyph = '▄'; }
      else { style = palette[top].fg+palette[bottom].bg; glyph = '▀'; }
      if (style !== last) { line += style; last = style; } line += glyph;
    }
    lines.push(line+'\x1b[39;49m');
  }
  return lines;
}

export class PsiHeader {
  constructor({ app, onActivate, format = s => s, subdued = s => s }) {
    this.app = app; this.onActivate = onActivate; this.format = format; this.subdued = subdued; this.cached = null;
  }
  invalidate() {}
  render(width) {
    const logoWidth = Math.min(12, Math.max(6, width - 4)), logoRows = 4;
    const accent=this.app.engine.config.accent || 'sage';
    const key = `${logoWidth}:${logoRows}:${accent}`;
    if (this.cached?.key !== key) this.cached = { key, lines: renderPsi(logoWidth,logoRows,0,false,accent) };
    this.bounds = { x: 1, y: 1, width: logoWidth, height: logoRows };
    const path = this.app.session.meta.cwd.replace(process.env.HOME || '\0', '~');
    const labels = width >= 48 ? { 0: this.format('P S I'), 1: this.subdued('long + intensive loops'), 3: this.subdued(path) } : {};
    return ['', ...this.cached.lines.map((line, i) => truncateToWidth(' '+line+'  '+(labels[i] || ''), width)), ''];
  }
  // Bound the click region to the mark, leaving workspace text selectable.
  handleMouse(event) {
    const b = this.bounds;
    if (event.type === 'click' && event.button === 'left' && b && event.x >= b.x && event.x < b.x+b.width && event.y >= b.y && event.y < b.y+b.height) {
      this.onActivate(); return { handled: true, render: true };
    }
  }
}

export class PsiAnimation {
  focused = true;
  constructor({ terminal, onClose, config=()=>({}), now = () => performance.now() }) {
    this.config=config; this.terminal = terminal; this.onClose = onClose; this.now = now; this.started = now(); this.offset = 0;
  }
  invalidate() {}
  render(width) {
    const height = Math.max(1, this.terminal.rows);
    const rows = Math.max(1, Math.min(16, Math.max(1, Math.floor(height * 0.5))));
    const columns = Math.max(1, Math.min(52, Math.max(1, Math.floor(width * 0.55))));
    const phase = (this.now()-this.started)/1000 + this.offset;
    const glyph = renderPsi(columns, rows, phase, this.config().animations!==false,this.config().accent);
    const padX = ' '.repeat(Math.max(0, Math.floor((width-columns)/2)));
    const padY = Math.max(0, Math.floor((height-rows-2)/2));
    const hint = 'click or esc to return';
    return [...Array(padY).fill(''), ...glyph.map(line => padX+line), '', ' '.repeat(Math.max(0,Math.floor((width-hint.length)/2)))+'\x1b[2m'+truncateToWidth(hint,width)+'\x1b[22m', ...Array(height).fill('')].slice(0,height);
  }
  handleInput(data) {
    if (data === '\x1b' || data === 'q' || data === '\r' || data === '\n') this.onClose();
    else if (data === '\x1b[D') this.offset -= 0.3;
    else if (data === '\x1b[C') this.offset += 0.3;
  }
  handleMouse(event) {
    if (event.type === 'click' && event.button === 'left') this.onClose();
    return { handled: true, render: true };
  }
}
