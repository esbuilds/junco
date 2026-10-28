// Offline check for the desk's design tokens and UI helpers (no browser, no desk, no PayPal).
//   npm run check-ui
import assert from 'node:assert/strict';
import { TOKENS, contrast } from './src/theme';

// Every text pair the desk uses passes WCAG AA (4.5:1) in both colour schemes.
for (const mode of ['light', 'dark'] as const) {
  const t = TOKENS[mode];
  for (const [fg, bg] of [['ink', 'surface'], ['muted', 'bg'], ['muted', 'surface'], ['attn-text', 'bg'], ['attn-text', 'surface'], ['attn-text', 'attn-bg'], ['danger', 'danger-bg'], ['accent-ink', 'accent']] as const)
    assert.ok(contrast(t[fg], t[bg]) >= 4.5, `${mode} ${fg} on ${bg}: ${contrast(t[fg], t[bg]).toFixed(2)}`);
}
assert.equal(TOKENS.light.attn, '#c2531f');
assert.equal(TOKENS.light['attn-text'], '#b5471c');
assert.equal(TOKENS.light.accent, '#18181b');

console.log('check-ui: ok');
