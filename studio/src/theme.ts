import { themeQuartz } from 'ag-grid-community';

// The desk's one colour source (Graphite, docs/superpowers/specs/2026-10-28-ui-polish-design.md): grays carry the page,
// copper (attn) marks only what needs the owner, red (danger) only failures, violet only what-if.
// applyTokens() writes them as --jd-* CSS variables; the Studio and AG Grid themes read the same values.
const NAMES = ['bg', 'surface', 'surface-2', 'line', 'line-2', 'ink', 'muted', 'faint', 'accent', 'accent-ink', 'attn', 'attn-text', 'attn-bg', 'danger', 'danger-bg', 'ok', 'ok-bg', 'focus', 'whatif', 'whatif-bg'] as const;
export type TokenName = typeof NAMES[number];
export type Tokens = Record<TokenName, string>;

export const TOKENS: { light: Tokens; dark: Tokens } = {
  light: {
    bg: '#fafafa', surface: '#ffffff', 'surface-2': '#f4f4f5', line: '#e4e4e7', 'line-2': '#ededf0',
    ink: '#18181b', muted: '#52525b', faint: '#71717a', accent: '#18181b', 'accent-ink': '#ffffff',
    attn: '#c2531f', 'attn-text': '#b5471c', 'attn-bg': '#fff4ed', danger: '#b42318', 'danger-bg': '#fef3f2',
    ok: '#52525b', 'ok-bg': '#f4f4f5', focus: '#2563eb', whatif: '#6d4fa3', 'whatif-bg': '#f5f2fa',
  },
  dark: {
    bg: '#111113', surface: '#18181b', 'surface-2': '#202024', line: '#303036', 'line-2': '#26262b',
    ink: '#f4f4f5', muted: '#a1a1aa', faint: '#8b8b94', accent: '#f4f4f5', 'accent-ink': '#18181b',
    attn: '#ed916b', 'attn-text': '#ed916b', 'attn-bg': '#302019', danger: '#f97066', 'danger-bg': '#3a1a17',
    ok: '#a1a1aa', 'ok-bg': '#202024', focus: '#7aa7f0', whatif: '#c9a7e8', 'whatif-bg': '#2a2238',
  },
};

export const isDark = typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
export const T: Tokens = isDark ? TOKENS.dark : TOKENS.light;

// Old class names still in widgets read these; they point at the new roles so amber and blue don't come back.
const ALIASES: Record<string, TokenName> = { warn: 'attn-text', 'warn-bg': 'attn-bg', info: 'muted', 'info-bg': 'surface-2' };
export function applyTokens() {
  const s = document.documentElement.style;
  for (const n of NAMES) s.setProperty(`--jd-${n}`, T[n]);
  for (const [a, n] of Object.entries(ALIASES)) s.setProperty(`--jd-${a}`, T[n]);
  document.documentElement.style.colorScheme = isDark ? 'dark' : 'light';
}

// WCAG 2 contrast ratio of two #rrggbb colours.
export function contrast(a: string, b: string) {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

// AG Grid takes literal colours here (picked by colour scheme, as before), so dark mode follows T.
export const gridTheme = themeQuartz.withParams({
  backgroundColor: T.surface, foregroundColor: T.ink, borderColor: T.line, accentColor: T.muted,
  fontFamily: 'Geist, system-ui, sans-serif', fontSize: 14,
  rowHeight: 44, headerHeight: 36, headerFontSize: 12, headerFontWeight: 500,
  headerTextColor: T.muted, headerBackgroundColor: T.surface,
  columnBorder: false, headerColumnBorder: false, rowBorder: { width: 1, color: T['line-2'] },
  wrapperBorder: false, wrapperBorderRadius: 0,
  rowHoverColor: T.bg, selectedRowBackgroundColor: T['surface-2'],
  cellHorizontalPaddingScale: 0.9,
});
export const gridThemeTall = gridTheme.withParams({ rowHeight: 52 });
