// Deterministic terminal surface for testing the actual fullscreen renderer and input routing.
export class MemoryTerminal {
  constructor(columns = 100, rows = 32) { this.columns = columns; this.rows = rows; this.output = ''; this.kittyProtocolActive = false; }
  start(onInput, onResize) { this.onInput = onInput; this.onResize = onResize; }
  stop() { this.onInput = null; }
  write(text) { this.output += text; if (this.output.length > 2000000) this.output = this.output.slice(-1000000); }
  moveBy() {} hideCursor() {} showCursor() {} clearLine() {} clearFromCursor() {} clearScreen() {} setTitle() {} setProgress() {} setProgramStatus() {}
  input(data) { this.onInput?.(data); }
  resize(columns, rows) { this.columns = columns; this.rows = rows; this.onResize?.(); }
}
