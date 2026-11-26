import type { Page } from 'playwright';

export const SHORT_LENGTH = 60;
export const LONG_OUTLINE = 20000;

const DISSOLVED_UNNAMED = new Set([
  'generic', 'list', 'listitem', 'paragraph', 'group', 'region', 'article', 'figure', 'table', 'rowgroup', 'row', 'cell',
  'definition', 'term', 'strong', 'emphasis', 'code', 'superscript', 'subscript', 'insertion', 'deletion', 'mark', 'time',
  'blockquote', 'note', 'caption', 'img', 'none', 'presentation', 'document', 'contentinfo', 'complementary',
]);
const DROPPED = new Set(['separator', '/url']);

interface Node {
  line: string;
  label: string;
  kind: 'text' | 'heading' | 'element';
  children: Node[];
}

interface OnScreen {
  text: string;
  pieces: string[];
}

interface Parsed {
  role: string;
  name?: string;
  attrs: string;
  value?: string;
  quoted: boolean;
}

export function shortOutline(outline: string, onScreen?: OnScreen): { outline: string; leftOut: number } {
  const roots = parse(outline);
  if (onScreen === undefined) return { outline: render(roots), leftOut: 0 };
  const shown = keepOnScreen(roots, shownOn(onScreen));
  return { outline: render(shown), leftOut: count(roots) - count(shown) };
}

const SHORT_LABEL = 15;

function shownOn({ text, pieces }: OnScreen): (n: Node) => boolean {
  const seenText = loose(text);
  const seenPieces = [...new Set(pieces.map(loose))];
  return (n) => {
    if (n.kind === 'heading') return true;
    const label = loose(n.label);
    if (normal(n.label).length < SHORT_LABEL) return n.kind === 'element' && !!label && seenPieces.some((p) => p.startsWith(label));
    return seenText.includes(loose(n.label).slice(0, 24));
  };
}

function parse(outline: string): Node[] {
  const roots: Node[] = [];
  const stack: { indent: number; into: Node[]; names: string[] }[] = [{ indent: -1, into: roots, names: [] }];
  for (const raw of outline.split('\n')) {
    const m = /^(\s*)- (.*)$/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    const p = parseLine(m[2]);
    if (!p || DROPPED.has(p.role)) {
      if (!p) parent.into.push({ line: m[2], label: '', kind: 'element', children: [] });
      stack.push({ indent, into: parent.into, names: parent.names });
      continue;
    }
    const inlineText = p.role === 'text' ? p.value : p.name === undefined && DISSOLVED_UNNAMED.has(p.role) ? p.value : undefined;
    if (p.role === 'text' || inlineText !== undefined) {
      const text = inlineText ?? '';
      if (text && !parent.names.some((n) => normal(n).includes(normal(text)))) parent.into.push({ line: `text: ${quoteValue(short(text))}`, label: text, kind: 'text', children: [] });
      stack.push({ indent, into: parent.into, names: parent.names });
      continue;
    }
    const repeatsParent = p.role === 'img' && p.name !== undefined && parent.names.some((n) => normal(n).includes(normal(p.name!)));
    if ((p.name === undefined && DISSOLVED_UNNAMED.has(p.role)) || repeatsParent) {
      stack.push({ indent, into: parent.into, names: parent.names });
      continue;
    }
    const key = `${p.role}${p.name === undefined ? '' : ` "${short(p.name)}"`}${p.attrs}`;
    const node: Node = {
      line: `${p.quoted ? `'${key.replace(/'/g, "''")}'` : key}${p.value !== undefined ? `: ${quoteValue(short(p.value))}` : ''}`,
      label: p.name ?? p.value ?? '',
      kind: p.role === 'heading' ? 'heading' : 'element',
      children: [],
    };
    parent.into.push(node);
    stack.push({ indent, into: node.children, names: p.name ? [...parent.names, p.name] : parent.names });
  }
  return roots;
}

function parseLine(line: string): Parsed | null {
  let key: string;
  let rest: string;
  let quoted = false;
  if (line.startsWith("'")) {
    const end = /'(?!')/.exec(line.slice(1));
    if (!end) return null;
    key = line.slice(1, end.index + 1).replace(/''/g, "'");
    rest = line.slice(end.index + 2);
    quoted = true;
  } else {
    const colon = keyEnd(line);
    key = line.slice(0, colon);
    rest = line.slice(colon);
  }
  const k = /^(\/?[\w-]+)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)$/.exec(key);
  if (!k) return null;
  const value = rest.startsWith(': ') ? unquoteValue(rest.slice(2)) : undefined;
  return { role: k[1], name: k[2]?.replace(/\\(.)/g, '$1'), attrs: k[3], value, quoted };
}

function keyEnd(line: string): number {
  let inName = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i++;
    else if (line[i] === '"') inName = !inName;
    else if (line[i] === ':' && !inName && (i + 1 === line.length || line[i + 1] === ' ')) return i;
  }
  return line.length;
}

function unquoteValue(v: string): string {
  if (v.length > 1 && v.startsWith('"') && v.endsWith('"')) return v.slice(1, -1).replace(/\\(.)/g, '$1');
  if (v.length > 1 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function quoteValue(v: string): string {
  return /^[\s'"&*!|>%@`#{[-]|: | #|\s$/.test(v) ? `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : v;
}

const short = (s: string) => (s.length > SHORT_LENGTH ? `${s.slice(0, SHORT_LENGTH).trimEnd()}…` : s);
const normal = (s: string) => s.replace(/[\s⁠]+/g, ' ').trim().toLowerCase();
const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

function keepOnScreen(nodes: Node[], onScreen: (n: Node) => boolean): Node[] {
  const kept = nodes.map((n) => {
    const children = keepOnScreen(n.children, onScreen);
    const shows = !!n.label && onScreen(n);
    return shows || children.length ? { ...n, children } : null;
  });
  const besideKept = kept.some(Boolean);
  return nodes.flatMap((n, i) => kept[i] ?? (besideKept && !n.label && !n.children.length ? [n] : []));
}

function count(nodes: Node[]): number {
  return nodes.reduce((sum, n) => sum + 1 + count(n.children), 0);
}

function render(nodes: Node[], depth = 0): string {
  return nodes.map((n) => `${'  '.repeat(depth)}- ${n.line}${n.children.length ? `:\n${render(n.children, depth + 1)}` : ''}`).join('\n');
}

export async function onScreen(page: Page): Promise<OnScreen> {
  return page
    .evaluate(() => {
      const vw = innerWidth;
      const vh = innerHeight;
      const shows = (r: DOMRect) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
      const seen = (el: Element | null) => !el || el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
      const text: string[] = [];
      const pieces: string[] = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const range = document.createRange();
      for (let t = walker.nextNode(); t; t = walker.nextNode()) {
        if (!t.textContent?.trim()) continue;
        range.selectNodeContents(t);
        if (shows(range.getBoundingClientRect()) && seen(t.parentElement)) text.push(t.textContent);
      }
      for (const el of document.querySelectorAll('a, button, input, select, textarea, summary, label, h1, h2, h3, h4, h5, h6, [role], [aria-label], [alt], [title], [placeholder]')) {
        if (!shows(el.getBoundingClientRect()) || !seen(el)) continue;
        pieces.push((el as HTMLElement).innerText ?? '');
        for (const a of ['aria-label', 'alt', 'title', 'placeholder', 'value']) {
          const v = el.getAttribute(a);
          if (v) pieces.push(v);
        }
      }
      return { text: [...text, ...pieces].join(' '), pieces };
    })
    .catch(() => ({ text: '', pieces: [] }));
}
