import type { Locator, Page } from 'playwright';
import type { Condition, Target } from '../../take/format.ts';
import { installCssHandles } from './css-handle.ts';

export function locate(page: Page, t: Target): Locator {
  if ('role' in t) return page.getByRole(t.role as Parameters<Page['getByRole']>[0], { name: t.name, exact: t.exact });
  if ('label' in t) return page.getByLabel(t.label, { exact: t.exact });
  if ('text' in t) return page.getByText(t.text, { exact: t.exact });
  if ('placeholder' in t) return page.getByPlaceholder(t.placeholder, { exact: t.exact });
  return page.locator(t.css);
}

export function describe(t: Target): string {
  if ('role' in t) return t.name ? `${t.role} "${t.name}"` : `a ${t.role}`;
  if ('label' in t) return `field labelled "${t.label}"`;
  if ('text' in t) return `text "${t.text}"`;
  if ('placeholder' in t) return `field with placeholder "${t.placeholder}"`;
  return `element "${t.css}"`;
}

export function describeCondition(c: Condition): string {
  if ('text' in c) return `text "${c.text}" to show`;
  if ('visible' in c) return `${describe(c.visible)} to show`;
  return `${describe(c.hidden)} to go away`;
}

export async function holds(page: Page, c: Condition): Promise<boolean> {
  if ('text' in c) return (await page.getByText(c.text).filter({ visible: true }).count()) > 0;
  if ('visible' in c) return (await locate(page, c.visible).filter({ visible: true }).count()) > 0;
  return (await locate(page, c.hidden).filter({ visible: true }).count()) === 0;
}

export async function describeMatches(page: Page, loc: Locator, n: number, [top, bottom]: [number, number]): Promise<string[]> {
  await installCssHandles(page);
  const out: string[] = [];
  for (let i = 0; i < Math.min(n, 4); i++) {
    const match = loc.nth(i);
    const first = (await match.ariaSnapshot({ timeout: 1000 }).catch(() => '')).split('\n')[0];
    const line = first.startsWith("- '") ? first.slice(3).replace(/''/g, "'") : first.slice(2);
    const name = /^[\w-]+ "((?:[^"\\]|\\.)*)"/.exec(line)?.[1].replace(/\\(.)/g, '$1');
    const css = await match
      .evaluate((el, [top, bottom]) => {
        const r = el.getBoundingClientRect();
        const y = r.y + r.height / 2;
        const on = r.width > 0 && r.right > 0 && r.left < innerWidth && y >= top && y <= bottom;
        return on ? (globalThis as unknown as { __takeUniqueSelector: (el: Element) => string | null }).__takeUniqueSelector(el) : null;
      }, [top, bottom] as [number, number])
      .catch(() => null);
    out.push(`${name === undefined ? 'one with no name' : JSON.stringify(name)}${css ? ` on screen: { "css": ${JSON.stringify(css)} }` : ''}`);
  }
  return out;
}
