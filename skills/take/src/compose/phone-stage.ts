import fs from 'node:fs';
import path from 'node:path';
import { escapeHtml } from '../escape-html.ts';
import { PHONE } from '../take/format.ts';
import { LETTERS, NUMBERS, type KeyboardLayout, type PhoneLayout, type PhoneTheme } from './phone.ts';
import { phoneStageScript } from './phone-stage-script.ts';
import type { Theme } from './stage.ts';

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function keyboardHtml(icon: (name: string) => string, layout: KeyboardLayout): string {
  const rows = layout === 'letters' ? LETTERS : NUMBERS;
  const chars = (keys: string) => [...keys].map((c) => `<div class="key char" data-key="${escapeHtml(c)}"><span>${escapeHtml(c)}</span></div>`).join('');
  const toggle = layout === 'letters' ? '<span class="label">123</span>' : '<span class="label">ABC</span>';
  const side = layout === 'letters'
    ? `<div class="key side" data-key="shift">${icon('shift')}${icon('shiftOn')}</div>`
    : `<div class="key side" data-key="symbols">${icon('symbols')}</div>`;
  return `<div class="layout" data-layout="${layout}">
      <div class="row">${chars(rows[0])}</div>
      <div class="row${layout === 'letters' ? ' inset' : ''}">${chars(rows[1])}</div>
      <div class="row third">${side}<div class="center">${chars(rows[2])}</div><div class="key side" data-key="delete">${icon('delete')}</div></div>
      <div class="row bottom"><div class="key wide" data-key="toggle">${toggle}</div><div class="key space" data-key="space"></div><div class="key wide" data-key="return">${icon('return')}</div></div>
    </div>`;
}

function softEdge({ blur, depth, steps }: PhoneTheme['edge'], k: number): string {
  const band = depth / steps;
  return Array.from({ length: steps }, (_, i) => {
    const mask = `linear-gradient(to bottom, #000 ${(depth - (i + 1) * band) * k}px, transparent ${(depth - i * band) * k}px)`;
    const each = (blur / steps) * Math.sqrt(2 * i + 1) * k;
    return `<div class="soft-edge" style="height: ${(depth + 3 * blur) * k}px; backdrop-filter: blur(${each}px); -webkit-mask-image: ${mask}; mask-image: ${mask};"></div>`;
  }).join('');
}

export function phoneStageHtml(theme: Theme, phone: PhoneTheme, themeDir: string, box: PhoneLayout, page: [number, number], address: string): string {
  const [W, H] = theme.stage.size;
  const { statusBar: bar, finger, safari, keyboard: kb } = phone;
  const [sw, sh] = PHONE.screen;
  const file = (name: string) => fs.readFileSync(path.join(themeDir, name), 'utf8').trim();
  const icon = (name: string) => `<i class="icon ${kebab(name)}">${file(phone.icons[name])}</i>`;
  const art = `/theme/${encodeURIComponent(phone.art)}`;
  const place = (l: number, t: number, w: number, h: number) => `left: ${l}px; top: ${t}px; width: ${w}px; height: ${h}px;`;
  const domain = address.split('/')[0];
  const colors = Object.keys(phone.light)
    .map((name) => `--${kebab(name)}: color-mix(in srgb, ${phone.light[name]}, ${phone.dark[name]} calc(var(--dark) * 100%));`)
    .join('\n    ');
  const { top: kbTop, accessory } = PHONE.keyboard;
  const band = box.statusBar * box.k;
  return `<!doctype html>
<meta charset="utf-8">
<style>
  html, body { margin: 0; width: ${W}px; height: ${H}px; overflow: hidden; }
  body { background: ${theme.stage.background}; -webkit-font-smoothing: antialiased; }
  .art { position: absolute; ${place(box.left, box.top, box.width, box.height)} display: block; }
  .art.shadow { filter: ${phone.shadow}; }
  .backing { position: absolute; ${place(box.screenLeft - 1, box.screenTop - 1, box.screenWidth + 2, box.screenHeight + 2)} border-radius: ${box.screenRadius + 1}px; background: #000; }
  .screen { position: absolute; ${place(box.screenLeft, box.screenTop, box.screenWidth, box.screenHeight)} border-radius: ${box.screenRadius}px; overflow: hidden;
    --dark: 0;
    ${colors} }
  .viewport { position: absolute; inset: 0; filter: opacity(1); }
  .scene { position: absolute; inset: 0; }
  .band { position: absolute; left: 0; top: 0; width: 100%; height: ${band + 1}px; display: block; }
  .page { position: absolute; left: 0; top: ${band}px; width: 100%; height: ${page[1] * box.k}px; overflow: hidden; }
  .page img { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .soft-edge { position: absolute; left: 0; top: 0; width: 100%; pointer-events: none; }
  #caret { position: absolute; left: 0; top: 0; display: none; }
  .points { position: absolute; transform: scale(${box.k}); transform-origin: 0 0; pointer-events: none; }
  .ui { left: 0; top: 0; width: ${sw}px; height: ${sh}px; }
  .status { position: absolute; left: 0; top: 0; width: ${sw}px; height: ${box.statusBar}px; display: flex; align-items: center; justify-content: center;
    padding: 11px 8px 0; box-sizing: border-box; color: var(--ink); }
  .time { flex: 1; height: 13px; display: flex; align-items: center; justify-content: center; font: ${bar.font}; white-space: nowrap; }
  .island { width: 95px; align-self: stretch; }
  .levels { flex: 1; display: flex; gap: 8px; align-items: center; justify-content: center; }
  .cellular { display: flex; gap: 2.333px; align-items: flex-end; padding-top: 1.333px; }
  .cellular i { width: 3.333px; border-radius: 4px; background: currentColor; }
  .levels svg { display: block; }
  .icon { position: absolute; display: block; line-height: 0; font-style: normal; }
  .icon svg { display: block; }
  .glass { position: absolute; border-radius: 24px; box-shadow: 0 6px 10px -3px var(--glass-shadow); }
  .lens { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
  .button { width: 48px; height: 48px; top: ${sh - PHONE.safariBar}px; color: var(--glyph); }
  #back { left: 34px; } #tabs { left: 320px; }
  .glass > .icon { top: 50%; translate: 0 -50%; }
  .button > .icon { left: 50%; translate: -50% -50%; }
  #field { color: var(--glyph); }
  #field .menu { left: 14px; } #field .reload { right: 12.64px; }
  .address { position: absolute; left: 40px; right: 40px; top: 50%; transform: translateY(-50%); text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .address.big { font: ${safari.font}; letter-spacing: -0.4522px; padding-left: 1px; }
  .address.small { left: 0; right: 0; font: ${safari.pillFont}; letter-spacing: 0.12px; color: var(--pill-text); }
  #keys { position: absolute; left: 0; top: ${accessory}px; width: ${sw}px; }
  #accessory { left: 17px; top: 0; width: 368px; height: 48px; color: var(--accessory-glyph); }
  #accessory .up { left: 14.73px; } #accessory .down { left: 68.73px; } #accessory .done { left: 333px; }
  .keyboard { position: absolute; left: 0; top: ${kbTop + 95 - accessory}px; width: ${sw}px; height: ${sh - kbTop - 95}px; box-sizing: border-box; padding: 8px 4px 0;
    border-radius: 27px 27px 62.16px 62.16px; background: var(--kb-background); backdrop-filter: blur(${kb.blur}px);
    box-shadow: inset 0 0 0 1px var(--kb-border), inset 0 1px 2px var(--kb-inset-soft), inset 0 0 1px var(--kb-inset-hair); }
  .suggestions { height: 39px; display: flex; align-items: center; font: ${kb.suggestionFont}; color: var(--suggestion); }
  .suggestions span { flex: 1; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 6px; }
  .suggestions i { width: 1px; height: 24px; border-radius: 1px; background: var(--divider); }
  .layout { padding-top: 8px; display: flex; flex-direction: column; gap: 10px; position: relative; }
  .layout + .layout { display: none; }
  .row { display: flex; gap: 6px; height: 45px; }
  .row.inset { padding: 0 16px; }
  .row.third { gap: 14px; }
  .center { flex: 1; display: flex; gap: 6px; }
  .key { position: relative; flex: 1; min-width: 0; border-radius: 8.5px; background: var(--key); color: var(--key-text);
    display: flex; align-items: center; justify-content: center; }
  .key.down { background: var(--key-pressed); }
  .key.char span { font: ${kb.letterFont}; margin-top: -5px; }
  .shifted .layout[data-layout="letters"] .key.char span { text-transform: uppercase; }
  .key.side { flex: 0 0 42px; }
  .key.wide { flex: 0 0 91px; }
  .key .icon { position: static; }
  .key .label { font: ${kb.labelFont}; letter-spacing: -0.32px; }
  .key .shift-on, .shifted .key .shift { display: none; }
  .shifted .key .shift-on { display: block; }
  .kb-icon { color: var(--kb-icon); }
  .kb-icon.emoji { left: 29px; bottom: 26px; } .kb-icon.mic { left: 350.07px; bottom: 25.4px; }
  .callout { position: absolute; display: none; filter: drop-shadow(0 0 0.5px rgb(0 0 0 / 0.25)) drop-shadow(0 4px 10px rgb(0 0 0 / 0.18)); }
  .callout svg { position: absolute; inset: 0; overflow: visible; }
  .callout path { fill: var(--callout); }
  .callout span { position: absolute; left: 0; right: 0; top: 2px; text-align: center; font: ${kb.calloutFont}; color: var(--key-text); }
  .touch { left: ${box.contentLeft}px; top: ${box.contentTop}px; width: ${page[0]}px; height: ${page[1]}px; }
  #finger { position: absolute; left: 0; top: 0; width: ${finger.size}px; height: ${finger.size}px; margin: ${-finger.size / 2}px 0 0 ${-finger.size / 2}px;
    border-radius: 50%; box-sizing: border-box; background: ${finger.fill}; border: ${finger.border}; box-shadow: ${finger.shadow}; visibility: hidden; }
</style>
<img class="art shadow" src="${art}" alt="">
<div class="backing"></div>
<div class="screen" id="screen">
  <div class="viewport">
    <div class="scene" id="scene">
      <canvas class="band" id="band"></canvas><canvas class="band" id="band-fade" style="opacity: 0"></canvas>
      <div class="page"><img id="shot" alt=""><img id="fade" alt="" style="opacity: 0"><div id="caret"></div></div>
    </div>
    ${softEdge(phone.edge, box.k)}
  </div>
  <div class="points ui">
    <div class="status">
      <div class="time">${escapeHtml(bar.time)}</div>
      <div class="island"></div>
      <div class="levels">
        <div class="cellular">${[6.333, 8.67, 11, 13.667].map((h) => `<i style="height: ${h}px"></i>`).join('')}</div>
        ${file(bar.wifi)}
        ${file(bar.battery)}
      </div>
    </div>
    <div class="glass button" id="back">${icon('back')}</div>
    <div class="glass button" id="tabs">${icon('tabs')}</div>
    <div id="keys">
      <div class="glass" id="accessory">${icon('up')}${icon('down')}${icon('done')}</div>
      <div class="keyboard" id="keyboard">
        <div class="suggestions"><span></span><i></i><span id="word"></span><i></i><span></span></div>
        ${keyboardHtml(icon, 'letters')}
        ${keyboardHtml(icon, 'numbers')}
        <div class="kb-icon emoji icon">${file(phone.icons.emoji)}</div>
        <div class="kb-icon mic icon">${file(phone.icons.mic)}</div>
        <div class="callout" id="callout"><svg><path></path></svg><span></span></div>
      </div>
    </div>
    <div class="glass" id="field">${icon('menu')}${icon('reload')}<div class="address big">${escapeHtml(domain)}</div><div class="address small">${escapeHtml(domain)}</div></div>
  </div>
</div>
<img class="art" src="${art}" alt="">
<div class="points touch"><div id="finger"></div></div>
${phoneStageScript(theme, phone, box, page, band)}`;
}
