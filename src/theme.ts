import type { Theme } from './types';

let preference: Theme = 'system';
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');

export function applyTheme(theme: Theme): void {
  preference = theme;
  const resolved = theme === 'system' ? systemTheme.matches ? 'dark' : 'light' : theme;
  document.documentElement.dataset['theme'] = resolved;
  document.documentElement.style.colorScheme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta instanceof HTMLMetaElement) meta.content = resolved === 'dark' ? '#0b1017' : '#eef3f6';
}

systemTheme.addEventListener('change', () => { if (preference === 'system') applyTheme('system'); });
applyTheme('system');
