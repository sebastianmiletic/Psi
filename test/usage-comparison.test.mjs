import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizedUsage } from '../benchmarks/compare_codex.mjs';

test('comparison normalizes Codex inclusive input and Psi separate cached input without counting reasoning twice', () => {
  const psi = normalizedUsage('psi', [{ type: 'usage', usage: { input: 200, cacheRead: 800, cacheWrite: 40, output: 100, reasoning: 60 } }]);
  const codex = normalizedUsage('codex', [{ type: 'turn.completed', usage: { input_tokens: 1040, cached_input_tokens: 800, output_tokens: 100, reasoning_output_tokens: 60 } }]);
  assert.equal(psi.total, 1140); assert.equal(codex.total, 1140);
  assert.equal(psi.uncachedInput + psi.cacheWrite, codex.uncachedInput);
  assert.equal(psi.output, codex.output); assert.equal(psi.reasoning, codex.reasoning);
});

test('comparison sums completed usage receipts and ignores other events or missing counters', () => {
  const events = [{ type: 'item.completed', usage: { input_tokens: 9999 } }, { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 50 } }, { type: 'turn.completed', usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 70 } }];
  const result = normalizedUsage('codex', events);
  assert.equal(result.total, 2320); assert.equal(result.uncachedInput, 400); assert.equal(result.cachedInput, 1800); assert.equal(result.output, 120);
  assert.equal(normalizedUsage('psi', []), null); assert.equal(normalizedUsage('codex', [{ type: 'turn.failed' }]), null);
});
