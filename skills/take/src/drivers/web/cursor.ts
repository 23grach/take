import type { Page } from 'playwright';

const CURSOR_KEYWORDS = [
  'default', 'pointer', 'text', 'vertical-text', 'crosshair', 'grab', 'grabbing', 'move', 'not-allowed', 'copy', 'alias',
  'context-menu', 'help', 'cell', 'zoom-in', 'zoom-out', 'progress', 'wait', 'none',
  'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'col-resize', 'row-resize',
  'n-resize', 'e-resize', 's-resize', 'w-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize',
] as const;
export type CursorKeyword = (typeof CURSOR_KEYWORDS)[number];

interface CursorImage {
  image: string;
  hotspot?: [number, number];
  fallback: CursorKeyword;
}
export type Cursor = CursorKeyword | CursorImage;

const SYNONYMS: Record<string, CursorKeyword> = { 'all-scroll': 'move', 'no-drop': 'not-allowed', '-webkit-grab': 'grab', '-webkit-grabbing': 'grabbing', '-webkit-zoom-in': 'zoom-in', '-webkit-zoom-out': 'zoom-out' };

export function keyword(css: string): CursorKeyword {
  const k = SYNONYMS[css] ?? css;
  return (CURSOR_KEYWORDS as readonly string[]).includes(k) ? (k as CursorKeyword) : 'default';
}

type Raw = { css: string; field: boolean };

async function rawAt(page: Page, [x, y]: [number, number]): Promise<Raw> {
  return page.evaluate(([x, y]) => {
    let el = document.elementFromPoint(x, y);
    while (el?.shadowRoot) {
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    if (!el) return { css: 'default', field: false };
    const css = getComputedStyle(el).cursor;
    const f = el.closest('textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], input');
    const textual = ['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''];
    const field = !!f && !(f as HTMLInputElement).disabled && (!(f instanceof HTMLInputElement) || textual.includes(f.type));
    return { css, field };
  }, [x, y] as [number, number]);
}

export function parseCursor(css: string): { images: { url: string; hotspot?: [number, number] }[]; keyword: string } {
  const images: { url: string; hotspot?: [number, number] }[] = [];
  const re = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s]*))\s*\)\s*(?:(-?[\d.]+)\s+(-?[\d.]+))?\s*,\s*/gy;
  let m: RegExpExecArray | null;
  let end = 0;
  while ((m = re.exec(css))) {
    const url = (m[1] ?? m[2] ?? m[3]).replace(/\\(.)/g, '$1');
    images.push(m[4] !== undefined ? { url, hotspot: [+m[4], +m[5]] } : { url });
    end = re.lastIndex;
  }
  return { images, keyword: css.slice(end).trim() || 'auto' };
}

export function cursorReader(page: Page) {
  const images = new Map<string, string | null>();

  async function load(url: string): Promise<string | null> {
    if (!images.has(url)) {
      let data: string | null = null;
      if (url.startsWith('data:')) data = url;
      else {
        const res = await page.context().request.get(url, { timeout: 5000 }).catch(() => null);
        const type = res?.headers()['content-type']?.split(';')[0];
        if (res?.ok() && type?.startsWith('image/')) data = `data:${type};base64,${(await res.body()).toString('base64')}`;
      }
      images.set(url, data);
    }
    return images.get(url)!;
  }

  return async function cursorAt(point: [number, number]): Promise<Cursor> {
    const { css, field } = await rawAt(page, point);
    const parsed = parseCursor(css);
    const fallback: CursorKeyword = parsed.keyword === 'auto' ? (field ? 'text' : 'default') : keyword(parsed.keyword);
    for (const img of parsed.images) {
      const data = await load(img.url);
      if (data) return img.hotspot ? { image: data, hotspot: img.hotspot, fallback } : { image: data, fallback };
    }
    return fallback;
  };
}

export const sameCursor = (a: Cursor | undefined, b: Cursor) =>
  a === b || (typeof a === 'object' && typeof b === 'object' && a.image === b.image && a.hotspot?.join() === b.hotspot?.join());
