import type { Page } from 'playwright';

export function uniqueSelector(el: Element): string | null {
  const one = (sel: string) => {
    try {
      return document.querySelectorAll(sel).length === 1;
    } catch {
      return false;
    }
  };
  const own = (e: Element): string[] => {
    const tag = e.tagName.toLowerCase();
    const out: string[] = [];
    for (const a of ['data-testid', 'data-test', 'data-qa', 'aria-controls', 'title', 'name'])
      if (e.getAttribute(a)) out.push(`${tag}[${a}=${JSON.stringify(e.getAttribute(a))}]`);
    const href = e.getAttribute('href');
    if (tag === 'a' && href && href.length <= 80 && !href.startsWith('#')) out.push(`a[href=${JSON.stringify(href)}]`);
    for (const { name, value } of e.attributes)
      if (name.startsWith('data-') && value && value.length <= 40 && !/\d{3,}/.test(value)) out.push(`${tag}[${name}=${JSON.stringify(value)}]`);
    if (e.id && !/\d{3,}|:|«|_[rR]_/.test(e.id)) out.push(`#${CSS.escape(e.id)}`);
    const classes = [...e.classList].filter((c) => !/^(is-|has-)|\d{4,}/.test(c)).map((c) => `.${CSS.escape(c)}`);
    for (const c of classes) out.push(c, `${tag}${c}`);
    for (let i = 0; i < classes.length; i++) for (let j = i + 1; j < classes.length; j++) out.push(`${tag}${classes[i]}${classes[j]}`);
    return out;
  };
  for (const sel of own(el)) if (one(sel)) return sel;
  let path = el.tagName.toLowerCase() + (el.classList[0] ? `.${CSS.escape(el.classList[0])}` : '');
  for (let p = el.parentElement, depth = 0; p && p !== document.body && depth < 4; p = p.parentElement, depth++) {
    for (const sel of own(p)) if (one(sel) && one(`${sel} ${path}`)) return `${sel} ${path}`;
    path = `${p.tagName.toLowerCase()}${p.classList[0] ? `.${CSS.escape(p.classList[0])}` : ''} > ${path}`;
  }
  const nth = (e: Element) => `${e.tagName.toLowerCase()}:nth-of-type(${[...(e.parentElement?.children ?? [])].filter((x) => x.tagName === e.tagName).indexOf(e) + 1})`;
  let chain = nth(el);
  for (let p = el.parentElement, depth = 0; p && depth < 6; p = p.parentElement, depth++) {
    const named = p === document.body ? 'body' : own(p).find(one);
    if (named && one(`${named} > ${chain}`)) return `${named} > ${chain}`;
    if (p === document.body) break;
    chain = `${nth(p)} > ${chain}`;
  }
  return null;
}

export async function installCssHandles(page: Page): Promise<void> {
  await page.evaluate(`globalThis.__takeUniqueSelector ??= ${uniqueSelector}`).catch(() => {});
}
