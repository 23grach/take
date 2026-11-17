import type { Page } from 'playwright';

export interface Caret {
  x: number;
  y: number;
  height: number;
  color: string;
}

const HIDE_ID = 'take-hidden-caret';

export async function hideCaret(page: Page): Promise<void> {
  const install = (id: string) => {
    const add = () => {
      if (document.getElementById(id)) return;
      const s = document.createElement('style');
      s.id = id;
      s.textContent = `*:not(#${id}) { caret-color: transparent !important; }`;
      (document.head ?? document.documentElement).append(s);
    };
    if (document.documentElement) add();
    else new MutationObserver((_, o) => document.documentElement && (o.disconnect(), add())).observe(document, { childList: true });
  };
  await page.addInitScript(install, HIDE_ID);
  await Promise.all(page.frames().map((f) => f.evaluate(install, HIDE_ID).catch(() => {})));
}

export async function caretAt(page: Page): Promise<Caret | null> {
  return page.evaluate((hideId) => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    const style = getComputedStyle(el);
    const colorOf = (s: CSSStyleDeclaration) => {
      const hide = document.getElementById(hideId) as HTMLStyleElement | null;
      if (hide) hide.disabled = true;
      try {
        const c = s.caretColor;
        return !c || c === 'auto' || c === 'transparent' || c === 'rgba(0, 0, 0, 0)' ? s.color : c;
      } finally {
        if (hide) hide.disabled = false;
      }
    };
    const round = (n: number) => Math.round(n * 10) / 10;

    const textual = ['text', 'search', 'email', 'url', 'tel', 'password', 'number', ''];
    const isInput = el instanceof HTMLInputElement && textual.includes(el.type);
    if (isInput || el instanceof HTMLTextAreaElement) {
      const field = el as HTMLInputElement | HTMLTextAreaElement;
      if (field.selectionStart !== field.selectionEnd || field.selectionEnd === null) return null;
      const r = field.getBoundingClientRect();
      const px = (v: string) => parseFloat(v) || 0;
      const fontSize = px(style.fontSize);
      const lineHeight = style.lineHeight === 'normal' ? fontSize * 1.2 : px(style.lineHeight);
      const ctx = new OffscreenCanvas(1, 1).getContext('2d')!;
      ctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const before = field.value.slice(0, field.selectionEnd);
      const shown = field instanceof HTMLInputElement && field.type === 'password' ? '•'.repeat(before.length) : before;
      const lines = shown.split('\n');
      const last = lines[lines.length - 1];
      const spacing = px(style.letterSpacing) * last.length;
      const left = r.left + px(style.borderLeftWidth) + px(style.paddingLeft);
      const contentWidth = r.width - px(style.borderLeftWidth) - px(style.borderRightWidth) - px(style.paddingLeft) - px(style.paddingRight);
      let x = left + ctx.measureText(last).width + spacing - field.scrollLeft;
      if (style.textAlign === 'center') x += (contentWidth - ctx.measureText(field.value.split('\n')[lines.length - 1] ?? '').width) / 2;
      const height = Math.min(lineHeight, fontSize * 1.25);
      let y: number;
      if (field instanceof HTMLInputElement) {
        const top = r.top + px(style.borderTopWidth) + px(style.paddingTop);
        const inner = r.height - px(style.borderTopWidth) - px(style.borderBottomWidth) - px(style.paddingTop) - px(style.paddingBottom);
        y = top + (inner - height) / 2;
      } else {
        y = r.top + px(style.borderTopWidth) + px(style.paddingTop) + (lines.length - 1) * lineHeight + (lineHeight - height) / 2 - field.scrollTop;
      }
      x = Math.min(Math.max(x, left), left + contentWidth);
      return { x: round(x), y: round(y), height: round(height), color: colorOf(style) };
    }

    if (el.isContentEditable) {
      const sel = getSelection();
      if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null;
      const range = sel.getRangeAt(0);
      let rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
      const host = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement ?? el;
      const hs = getComputedStyle(host);
      const fontSize = parseFloat(hs.fontSize) || 16;
      if (!rect || (rect.width === 0 && rect.height === 0 && rect.x === 0 && rect.y === 0)) {
        const b = host.getBoundingClientRect();
        rect = new DOMRect(b.left + (parseFloat(hs.paddingLeft) || 0), b.top + (parseFloat(hs.paddingTop) || 0), 0, fontSize * 1.2);
      }
      const height = Math.min(rect.height || fontSize * 1.2, fontSize * 1.25);
      return { x: round(rect.left), y: round(rect.top + ((rect.height || height) - height) / 2), height: round(height), color: colorOf(hs) };
    }
    return null;
  }, HIDE_ID);
}
