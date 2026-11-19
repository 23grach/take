import type { PageEdge, PageEdges } from './events.ts';

export function pageEdges(): PageEdges {
  const paint = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  paint.canvas.width = paint.canvas.height = 1;
  const upFrom = (el: Element, last: Element | null = null) => {
    const chain: Element[] = [];
    for (let e: Element | null = el; e; e = e === last ? null : e.parentElement) chain.push(e);
    return chain;
  };
  const opacity = (el: Element) => upFrom(el).reduce((o, e) => o * Number(getComputedStyle(e).opacity), 1);
  const flatten = (layers: Element[], base: string | null) => {
    paint.globalAlpha = 1;
    paint.clearRect(0, 0, 1, 1);
    if (base) {
      paint.fillStyle = base;
      paint.fillRect(0, 0, 1, 1);
    }
    for (const el of [...layers].reverse()) {
      paint.globalAlpha = opacity(el);
      paint.fillStyle = getComputedStyle(el).backgroundColor;
      paint.fillRect(0, 0, 1, 1);
    }
    const [r, g, b, a] = paint.getImageData(0, 0, 1, 1).data;
    return a ? `rgb(${r} ${g} ${b} / ${+(a / 255).toFixed(3)})` : null;
  };
  const root = document.scrollingElement;
  const pinned = (el: Element) => upFrom(el).find((e) => /fixed|sticky/.test(getComputedStyle(e).position));
  const edgeAt = (y: number, reaches: (r: DOMRect) => boolean, depth: (r: DOMRect) => number) => {
    const middle = document.elementFromPoint(innerWidth / 2, y) ?? document.body;
    const hits = Array.from({ length: 9 }, (_, i) => document.elementFromPoint((innerWidth * (i + 1)) / 10, y)).filter((e): e is Element => !!e);
    const counts = new Map<Element, number>();
    for (const hit of hits) {
      const p = pinned(hit);
      if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    const [bar] = [...counts].filter(([el, n]) => {
      const r = el.getBoundingClientRect();
      return n >= 7 && reaches(r) && r.width >= innerWidth * 0.8;
    }).sort((a, b) => b[1] - a[1])[0] ?? [];
    const barHit = bar && (bar.contains(middle) ? middle : hits.find((h) => bar.contains(h)));
    const page = bar ? document.elementsFromPoint(innerWidth / 2, y).find((e) => !bar.contains(e)) ?? document.body : middle;
    const scrollers = upFrom(page).filter((e) => e !== root && e !== document.body && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight);
    const edge: PageEdge = {
      cover: barHit ? flatten(upFrom(barHit, bar), null) : null,
      depth: bar ? Math.round(depth(bar.getBoundingClientRect())) : 0,
      color: flatten(upFrom(scrollers[0] ?? page).filter((e) => e.getBoundingClientRect().width >= innerWidth * 0.95), '#fff')!,
    };
    return { edge, page };
  };
  const top = edgeAt(0.5, (r) => r.top <= 0.5, (r) => r.bottom);
  const bottom = edgeAt(innerHeight - 1, (r) => r.bottom >= innerHeight - 1, (r) => innerHeight - r.top);
  const inner = upFrom(top.page).reduce((sum, e) => (e === root ? sum : sum + e.scrollTop), 0);
  return {
    scrollY: Math.round(scrollY * 100) / 100,
    scrollHeight: root?.scrollHeight ?? 0,
    inner: Math.round(inner * 100) / 100,
    top: top.edge,
    bottom: bottom.edge,
  };
}
