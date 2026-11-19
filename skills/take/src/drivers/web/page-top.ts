import type { PageTop } from './events.ts';

export function pageTop(): PageTop {
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
  const top = document.elementFromPoint(innerWidth / 2, 0.5) ?? document.body;
  const pinned = (el: Element) => upFrom(el).find((e) => /fixed|sticky/.test(getComputedStyle(e).position));
  const hits = Array.from({ length: 9 }, (_, i) => document.elementFromPoint((innerWidth * (i + 1)) / 10, 0.5)).filter((e): e is Element => !!e);
  const counts = new Map<Element, number>();
  for (const hit of hits) {
    const p = pinned(hit);
    if (p) counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const [bar] = [...counts].filter(([el, n]) => {
    const r = el.getBoundingClientRect();
    return n >= 7 && r.top <= 0.5 && r.width >= innerWidth * 0.8;
  }).sort((a, b) => b[1] - a[1])[0] ?? [];
  const barHit = bar && (bar.contains(top) ? top : hits.find((h) => bar.contains(h)));
  const page = bar ? document.elementsFromPoint(innerWidth / 2, 0.5).find((e) => !bar.contains(e)) ?? document.body : top;
  const scrollers = upFrom(page).filter((e) => e !== root && e !== document.body && /auto|scroll/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight);
  const inner = upFrom(page).reduce((sum, e) => (e === root ? sum : sum + e.scrollTop), 0);
  return {
    scrollY: Math.round(scrollY * 100) / 100,
    inner: Math.round(inner * 100) / 100,
    cover: barHit ? flatten(upFrom(barHit, bar), null) : null,
    color: flatten(upFrom(scrollers[0] ?? page), '#fff')!,
  };
}
