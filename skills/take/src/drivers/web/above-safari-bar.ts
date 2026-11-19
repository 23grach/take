export function keepAboveSafariBar(bar: number): void {
  type Lift = { by: number; base: string; inline: string; applied: string };
  const pinned = new Set<HTMLElement>();
  const lifted = new Map<HTMLElement, Lift>();

  const scan = (root: Element) => {
    for (const el of [root, ...root.querySelectorAll('*')])
      if (el instanceof HTMLElement && /fixed|sticky/.test(getComputedStyle(el).position)) pinned.add(el);
  };
  const insideLifted = (el: HTMLElement) => {
    for (let e = el.parentElement; e; e = e.parentElement) if (lifted.has(e)) return true;
    return false;
  };
  const wanted = (el: HTMLElement): number => {
    const style = getComputedStyle(el);
    if (!/fixed|sticky/.test(style.position) || insideLifted(el)) return 0;
    const map = el.computedStyleMap();
    const anchored = String(map.get('top')) === 'auto' && String(map.get('bottom')) !== 'auto';
    const r = el.getBoundingClientRect();
    const now = lifted.get(el)?.by ?? 0;
    const [top, bottom] = [r.top + now, r.bottom + now];
    if (style.position === 'sticky') return anchored ? Math.min(bar, Math.max(0, bottom - (innerHeight - bar - parseFloat(style.bottom)))) : 0;
    if (anchored) return bar;
    return r.width && r.height && top > 0 && bottom > innerHeight - bar && bottom <= innerHeight + 1 ? bar : 0;
  };
  const parts = (value: string) => (value === 'none' ? [] : value.match(/(?:[^\s()]|\((?:[^()]|\([^()]*\))*\))+/g) ?? []);
  const shifted = (base: string, by: number) => {
    const [x = '0px', y = '0px', z] = parts(base);
    return [x, `calc(${y} - ${by}px)`, ...(z ? [z] : [])].join(' ');
  };
  const slides = (style: CSSStyleDeclaration) =>
    style.transitionProperty.split(',').some((p) => /^(all|translate)$/.test(p.trim())) && style.transitionDuration.split(',').some((d) => parseFloat(d) > 0);
  const apply = (el: HTMLElement, by: number) => {
    const had = lifted.get(el);
    const ours = had && el.style.translate === had.applied;
    if (!by) {
      if (had) {
        if (ours) el.style.translate = had.inline;
        lifted.delete(el);
      }
      return;
    }
    if (ours && had.by === by) return;
    const style = getComputedStyle(el);
    const base = ours ? had.base : style.translate;
    const inline = ours ? had.inline : el.style.translate;
    const applied = shifted(base, by);
    const instant = slides(style);
    const transition = el.style.transition;
    if (instant) el.style.transition = 'none';
    el.style.translate = applied;
    lifted.set(el, { by, base, inline, applied: el.style.translate });
    if (instant) {
      void getComputedStyle(el).translate;
      el.style.transition = transition;
    }
  };
  const follow = (els: Iterable<HTMLElement>) => {
    for (const el of els) {
      if (el.isConnected) apply(el, wanted(el));
      else {
        pinned.delete(el);
        lifted.delete(el);
      }
    }
  };
  const restyles = (n: Node) => n instanceof HTMLStyleElement || n instanceof HTMLLinkElement;
  new MutationObserver((records) => {
    const roots = new Set<Element>();
    for (const r of records) {
      if (r.type === 'attributes' && r.target instanceof Element) roots.add(r.target);
      else if (restyles(r.target) || [...r.addedNodes, ...r.removedNodes].some(restyles)) roots.add(document.documentElement);
      else for (const n of r.addedNodes) if (n instanceof Element) roots.add(n);
    }
    const all = roots.has(document.documentElement) ? [document.documentElement] : [...roots].filter((root) => root.isConnected);
    for (const root of all) scan(root);
    follow([...pinned].filter((el) => all.some((root) => root.contains(el))));
  }).observe(document, { subtree: true, childList: true, attributes: true });
  const everything = () => {
    if (document.documentElement) scan(document.documentElement);
    follow(pinned);
  };
  document.addEventListener('load', (e) => restyles(e.target as Node) && everything(), true);
  document.addEventListener('DOMContentLoaded', everything);
  addEventListener('load', everything);
  requestAnimationFrame(function keepLifting() {
    follow(pinned);
    requestAnimationFrame(keepLifting);
  });
}
