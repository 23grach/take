import type { Page } from 'playwright';
import type { Focus, Room } from '../../take/format.ts';
import type { Box } from './events.ts';
import { describe, locate } from './targets.ts';
import { TakeError } from './take-error.ts';

export interface FocusLook {
  size: [number, number];
  background: string;
  maxZoom: number;
}

export function focusRegion(element: Box, [top, right, bottom, left]: Room, [vw, vh]: [number, number], [W, H]: [number, number], maxZoom: number): Box {
  const aspect = W / H;
  const across = element.width + 2 * Math.max(left, right);
  const down = element.height + 2 * Math.max(top, bottom);
  const width = Math.min(Math.max(across, down * aspect, W / maxZoom), vw, vh * aspect);
  const height = width / aspect;
  const r = (n: number) => Math.round(n * 100) / 100;
  return { x: r(element.x + element.width / 2 - width / 2), y: r(element.y + element.height / 2 - height / 2), width: r(width), height: r(height) };
}

export function clipToViewport(region: Box, [vw, vh]: [number, number]): Box {
  const x = Math.max(0, region.x);
  const y = Math.max(0, region.y);
  return { x, y, width: Math.min(vw, region.x + region.width) - x, height: Math.min(vh, region.y + region.height) - y };
}

function hideAllBut(element: Element, [light, dark]: [string, string]): void {
  const style = document.createElement('style');
  style.textContent = `[data-take-off] { visibility: hidden !important; } :where([data-take-on]) { visibility: visible; }
:where(html) { color-scheme: light dark; }
html { background: light-dark(${light}, ${dark}) !important; padding-bottom: 100vh !important; }`;
  document.head.append(style);
  document.body.setAttribute('data-take-off', '');
  for (const el of document.body.querySelectorAll('*')) if (!element.contains(el)) el.setAttribute('data-take-off', '');
  element.setAttribute('data-take-on', '');
  new MutationObserver((changes) => {
    for (const change of changes)
      for (const added of change.addedNodes)
        if (added instanceof Element && !element.contains(added) && !added.hasAttribute('data-take-off')) added.setAttribute('data-take-on', '');
  }).observe(document.body, { childList: true, subtree: true });
}

export async function isolate(page: Page, focus: Focus, viewport: [number, number], look: { light: FocusLook; dark: FocusLook }): Promise<Box> {
  const found = locate(page, focus.on).filter({ visible: true });
  const n = await found.count();
  if (n !== 1)
    throw new TakeError(-1, n ? `${n} elements match the component to film, ${describe(focus.on)}; give target.focus.on a target that matches one` : `the component to film, ${describe(focus.on)}, isn't on the page`);
  await found.evaluate(hideAllBut, [look.light.background, look.dark.background] as [string, string]);
  await found.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }));
  const box = await found.boundingBox();
  if (!box) throw new TakeError(-1, `the component to film, ${describe(focus.on)}, has no size on the page`);
  return focusRegion(box, focus.room, viewport, look.light.size, look.light.maxZoom);
}
