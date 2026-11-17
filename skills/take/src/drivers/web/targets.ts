import type { Locator, Page } from 'playwright';
import type { Condition, Target } from '../../take/format.ts';

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
