import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Device } from '../take/format.ts';
import type { FocusLook } from '../drivers/web/focus.ts';
import { themeFor, type Theme } from './stage.ts';
import type { PhoneTheme } from './phone.ts';

const THEMES = fileURLToPath(new URL('../../themes/', import.meta.url));

const themeNames = () => fs.readdirSync(THEMES).filter((d) => fs.existsSync(path.join(THEMES, d, 'tokens.json'))).sort();

export function themeProblem(name: string, device: Device = 'desktop'): string | undefined {
  if (!themeNames().includes(name)) return `there's no theme "${name}". Themes: ${themeNames().join(', ')}`;
  if (device === 'phone' && !loadTheme(name).theme.phone) return phoneLessTheme(name);
  return undefined;
}

const phoneLessTheme = (name: string) => `the "${name}" theme has no phone look; use the default theme for phone takes`;

export function loadTheme(name = 'default'): { theme: Theme; dir: string } {
  const dir = path.join(THEMES, name);
  const problem = themeProblem(name);
  if (problem) throw new Error(problem);
  return { theme: JSON.parse(fs.readFileSync(path.join(dir, 'tokens.json'), 'utf8')), dir };
}

export function focusLook(name: string): { light: FocusLook; dark: FocusLook } {
  const { theme } = loadTheme(name);
  const light = theme.focus;
  const dark = themeFor(theme, 'dark').focus;
  if (!light || !dark) throw new Error(`the "${name}" theme has no look for component videos; use the default theme`);
  return { light, dark };
}

export function phoneLook(theme: Theme, name: string): PhoneTheme {
  if (!theme.phone) throw new Error(phoneLessTheme(name));
  return theme.phone;
}
