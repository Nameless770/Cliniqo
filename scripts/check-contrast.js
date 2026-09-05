/**
 * WCAG contrast verification for the design tokens.
 *
 * "Accessible contrast" is a claim that should be measured. This resolves the semantic
 * tokens in src/styles/tokens.css for both themes and asserts every text/background
 * pair the UI actually uses meets AA.
 *
 * Run: node scripts/check-contrast.js
 */

import { readFileSync } from 'node:fs';

const css = readFileSync('src/styles/tokens.css', 'utf8');

/* Split the file into the light block (`:root { ... }` first occurrence) and the dark
 * override block inside the prefers-color-scheme media query. */
const darkStart = css.indexOf('@media (prefers-color-scheme: dark)');
const lightSrc = css.slice(0, darkStart);
const darkSrc = css.slice(darkStart);

function parseVars(src) {
  const out = new Map();
  for (const m of src.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    out.set(m[1], m[2].trim());
  }
  return out;
}

const lightVars = parseVars(lightSrc);
const darkVars = new Map([...lightVars, ...parseVars(darkSrc)]);

function resolve(vars, value, depth = 0) {
  if (depth > 10) return null;
  const ref = value.match(/^var\((--[a-z0-9-]+)\)$/i);
  if (ref) {
    const next = vars.get(ref[1]);
    return next ? resolve(vars, next, depth + 1) : null;
  }
  return value;
}

function toRgb(value) {
  if (!value) return null;
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  return null; // rgb()/alpha values are overlays, not text pairs — skipped by design
}

function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a, b) {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/* Pairs the UI genuinely renders. `min` is 4.5 for body text, 3 for large text and for
 * non-text UI boundaries (WCAG 1.4.11). */
const PAIRS = [
  ['--text-primary', '--bg-page', 4.5, 'body text on page'],
  ['--text-primary', '--bg-surface', 4.5, 'body text on card'],
  ['--text-primary', '--bg-sunken', 4.5, 'body text on sunken'],
  ['--text-secondary', '--bg-surface', 4.5, 'secondary text'],
  ['--text-secondary', '--bg-page', 4.5, 'secondary text on page'],
  ['--text-muted', '--bg-surface', 4.5, 'muted text'],
  ['--text-brand', '--bg-surface', 4.5, 'brand text / links'],
  ['--brand-text-on-solid', '--brand-solid', 4.5, 'primary button label'],
  ['--text-primary', '--bg-hover', 4.5, 'text on hover row'],
  ['--status-success-text', '--status-success-bg', 4.5, 'success badge'],
  ['--status-warn-text', '--status-warn-bg', 4.5, 'warning badge'],
  ['--status-danger-text', '--status-danger-bg', 4.5, 'danger badge'],
  ['--status-info-text', '--status-info-bg', 4.5, 'info badge'],
  ['--text-brand', '--brand-soft', 4.5, 'brand text on soft brand'],
  ['--border-default', '--bg-surface', 3, 'input border (UI boundary)'],
  ['--border-strong', '--bg-surface', 3, 'strong border'],
  ['--focus-ring', '--bg-surface', 3, 'focus ring on surface'],
  ['--focus-ring', '--bg-page', 3, 'focus ring on page'],
  ['--brand-solid', '--bg-surface', 3, 'solid brand as UI boundary'],
];

let failures = 0;
for (const [themeName, vars] of [
  ['light', lightVars],
  ['dark', darkVars],
]) {
  console.log(`\n  ${themeName.toUpperCase()}`);
  for (const [fgName, bgName, min, label] of PAIRS) {
    const fg = toRgb(resolve(vars, vars.get(fgName)));
    const bg = toRgb(resolve(vars, vars.get(bgName)));

    if (!fg || !bg) {
      console.log(`    ?  ${label.padEnd(32)} unresolved (${fgName} / ${bgName})`);
      failures++;
      continue;
    }

    const r = ratio(fg, bg);
    const pass = r >= min;
    if (!pass) failures++;
    console.log(
      `    ${pass ? 'ok' : 'FAIL'} ${label.padEnd(32)} ${r.toFixed(2)}:1 (needs ${min})`,
    );
  }
}

console.log(
  failures === 0
    ? '\n  All token pairs meet WCAG AA.\n'
    : `\n  ${failures} contrast failure(s).\n`,
);
process.exit(failures === 0 ? 0 : 1);
