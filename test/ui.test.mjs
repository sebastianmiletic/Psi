import test from 'node:test';
import assert from 'node:assert/strict';
import { TerminalUI, commands } from '../src/ui.mjs';
import { visibleWidth, stripTerminalSequences } from '@earendil-works/pi-tui';
import { estimateTokens } from '../src/engine.mjs';
import { fixture } from './helpers.mjs';

test('terminal header and footer fit narrow widths, and secret prompts never render their value', async t => {
  const f = await fixture(t, () => ({ text: 'Unused' }));
  const ui = new TerminalUI(f.app); t.after(() => clearTimeout(ui.renderTimer));
  for (const width of [24, 40, 80, 140]) for (const line of [...ui.header.render(width), ...ui.footer.render(width)]) assert.ok(visibleWidth(line) <= width);
  const answer = ui.ask({ type: 'secret', message: 'API key' });
  const input = ui.panel.children[1]; input.handleInput('test-secret-value');
  const rendered = stripTerminalSequences(input.render(80).join('\n'));
  assert.doesNotMatch(rendered, /test-secret-value/); assert.match(rendered, /•/);
  input.handleInput('\r'); assert.equal(await answer, 'test-secret-value');
  assert.equal(ui.pending, null);
  assert.ok(commands.some(c => c.name === 'model'));
  assert.ok(commands.some(c => c.name === 'effort'));
  assert.ok(commands.some(c => c.name === 'accounts'));
});

test('context estimates do not count image base64 as millions of text tokens', () => {
  const count = estimateTokens([{ role: 'toolResult', content: [{ type: 'image', mimeType: 'image/png', data: 'a'.repeat(1_000_000) }] }]);
  assert.ok(count < 4000); assert.ok(count >= 3000);
});
