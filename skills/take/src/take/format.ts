export const TAKE_VERSION = 0;

export const isLoginName = (name: string) => /^[a-z0-9][a-z0-9._-]*$/i.test(name) && !name.includes('..');

export type Target =
  | { role: string; name?: string; exact?: boolean }
  | { label: string; exact?: boolean }
  | { text: string; exact?: boolean }
  | { placeholder: string; exact?: boolean }
  | { css: string };

export type Spot = Target | [number, number];

export type Condition = { text: string } | { visible: Target } | { hidden: Target };

interface Common {
  mark?: string;
  waitFor?: Condition;
  ms?: number;
}

export type Step = Common &
  (
    | { do: 'click'; target: Spot; clicks?: 2 | 3 }
    | { do: 'hover'; target: Spot }
    | { do: 'drag'; from: Spot; to: Spot }
    | { do: 'type'; target?: Target; text: string; cps: number }
    | { do: 'press'; key: string }
    | { do: 'scroll'; target: Target }
    | { do: 'scroll'; by: [number, number] }
    | { do: 'wait'; for: Condition; timeout: number }
    | { do: 'hold'; ms: number }
  );

export const DEVICES = ['desktop', 'phone'] as const;
export type Device = (typeof DEVICES)[number];

export const APPEARANCES = ['light', 'dark'] as const;
export type Appearance = (typeof APPEARANCES)[number];

export const PHONE = {
  screen: [402, 874] as [number, number],
  statusBar: 54,
  safariBar: 82,
  keyboard: { top: 434, accessory: 472, clearance: 16, slide: 350 },
};
export const phonePage = (): [number, number] => [PHONE.screen[0], PHONE.screen[1] - PHONE.statusBar];

export interface WebTarget {
  kind: 'web';
  device: Device;
  url: string;
  address?: string;
  viewport: [number, number];
  scale: 1 | 1.5 | 2;
  login?: string;
  appearance?: Appearance;
}

export function isLocalUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.test') || host === '[::1]' || host === '0.0.0.0'
    || /^127\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host);
}

export function addressWarning(target: WebTarget): string | undefined {
  if (target.address !== undefined || !isLocalUrl(target.url)) return undefined;
  return `no address: the app runs at ${new URL(target.url).host}, which isn't shown, so the address bar will be blank. Add the product's domain as target.address, e.g. "boards.app"`;
}

export function shownAddress(target: WebTarget): string {
  if (target.address !== undefined) return target.address;
  if (isLocalUrl(target.url)) return '';
  const u = new URL(target.url);
  return (u.host + u.pathname).replace(/\/$/, '');
}

export function followedAddress(shown: string, firstUrl: string, url: string): string {
  const [first, now] = [new URL(firstUrl), new URL(url)];
  const path = now.pathname.replace(/\/$/, '');
  if (now.host !== first.host) return now.host + path;
  if (now.pathname === first.pathname) return shown;
  const domain = shown.split('/')[0];
  return domain ? domain + path : '';
}

export interface Take {
  version: 0;
  title: string;
  target: WebTarget;
  theme: string;
  ready?: Condition[];
  setup?: Step[];
  steps: Step[];
  loop: 'crossfade-to-start' | 'none';
  sound: boolean;
}

export const DEFAULTS = {
  viewport: [1440, 900] as [number, number],
  scale: 1.5 as const,
  theme: 'default',
  loop: 'crossfade-to-start' as const,
  sound: true,
  cps: { desktop: 14, phone: 7 } satisfies Record<Device, number>,
  timeout: 10_000,
};

export type Result = { ok: true; take: Take } | { ok: false; errors: string[] };

const TARGET_KINDS = ['role', 'label', 'text', 'placeholder', 'css'] as const;
const ACTIONS = ['click', 'hover', 'drag', 'type', 'press', 'scroll', 'wait', 'hold'] as const;
const LOOPS = ['crossfade-to-start', 'none'] as const;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const show = (v: unknown) => (typeof v === 'string' ? `"${v}"` : JSON.stringify(v));

export function validateTake(input: unknown): Result {
  const errors: string[] = [];
  const fail = (path: string, msg: string) => errors.push(`${path}: ${msg}`);

  function onlyKeys(o: Obj, path: string, allowed: readonly string[]) {
    for (const k of Object.keys(o)) {
      if (!allowed.includes(k)) {
        const near = closest(k, allowed);
        fail(path ? `${path}.${k}` : k, `unknown field${near ? ` (did you mean "${near}"?)` : ''}`);
      }
    }
  }

  function text(o: Obj, key: string, path: string): string | undefined {
    if (!(key in o)) return void fail(path, `missing "${key}"`);
    if (!isText(o[key])) return void fail(`${path}.${key}`, `must be non-empty text, got ${show(o[key])}`);
    return o[key] as string;
  }

  function optText(o: Obj, key: string, path: string) {
    if (key in o && !isText(o[key])) fail(`${path}.${key}`, `must be non-empty text, got ${show(o[key])}`);
  }

  function optBool(o: Obj, key: string, path: string) {
    if (key in o && typeof o[key] !== 'boolean') fail(`${path}.${key}`, `must be true or false, got ${show(o[key])}`);
  }

  function positive(o: Obj, key: string, path: string, fallback?: number): number | undefined {
    if (!(key in o)) {
      if (fallback === undefined) fail(path, `missing "${key}"`);
      return fallback;
    }
    const v = o[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
      fail(`${path}.${key}`, `must be a number above 0, got ${show(v)}`);
      return undefined;
    }
    return v;
  }

  function target(v: unknown, path: string): Target | undefined {
    if (!isObj(v)) return void fail(path, `must be an object such as { "role": "button", "name": "Save" }, got ${show(v)}`);
    const kinds = TARGET_KINDS.filter((k) => k in v);
    if (kinds.length !== 1) {
      fail(path, `give exactly one of ${TARGET_KINDS.join(', ')}${kinds.length ? ` (got ${kinds.join(' and ')})` : ''}`);
      onlyKeys(v, path, [...TARGET_KINDS, 'name', 'exact']);
      return undefined;
    }
    const [kind] = kinds;
    onlyKeys(v, path, kind === 'role' ? ['role', 'name', 'exact'] : kind === 'css' ? ['css'] : [kind, 'exact']);
    text(v, kind, path);
    if (kind === 'role') {
      if (isText(v.role) && v.role !== v.role.toLowerCase()) fail(`${path}.role`, `roles are lowercase, e.g. "${v.role.toLowerCase()}"`);
      optText(v, 'name', path);
    }
    optBool(v, 'exact', path);
    return v as Target;
  }

  function spot(v: unknown, path: string) {
    if (!Array.isArray(v)) return void target(v, path);
    if (v.length !== 2 || !v.every((n) => typeof n === 'number' && Number.isFinite(n)))
      return void fail(path, `must be a target such as { "role": "button", "name": "Card" } or a point [x, y] in pixels, e.g. [600, 400], got ${show(v)}`);
    points.push([path, v as [number, number]]);
  }
  const points: [string, [number, number]][] = [];

  function condition(v: unknown, path: string): Condition | undefined {
    const kinds = ['text', 'visible', 'hidden'];
    if (!isObj(v)) return void fail(path, `must be { "text": … }, { "visible": target } or { "hidden": target }, got ${show(v)}`);
    const given = kinds.filter((k) => k in v);
    if (given.length !== 1) {
      fail(path, `give exactly one of text, visible, hidden${given.length ? ` (got ${given.join(' and ')})` : ''}`);
      return undefined;
    }
    onlyKeys(v, path, given);
    if (given[0] === 'text') text(v, 'text', path);
    else target(v[given[0]], `${path}.${given[0]}`);
    return v as Condition;
  }

  function step(v: unknown, path: string): Step | undefined {
    if (!isObj(v)) return void fail(path, `must be an object such as { "do": "click", "target": … }, got ${show(v)}`);
    if (!('do' in v)) return void fail(path, `missing "do" (one of ${ACTIONS.join(', ')})`);
    const action = v.do;
    if (!ACTIONS.includes(action as (typeof ACTIONS)[number])) {
      const near = typeof action === 'string' ? closest(action, ACTIONS) : undefined;
      return void fail(`${path}.do`, `unknown action ${show(action)}${near ? ` (did you mean "${near}"?)` : ''}; use one of ${ACTIONS.join(', ')}`);
    }
    const common = ['do', 'mark', 'waitFor', 'ms'];
    optText(v, 'mark', path);
    if (action !== 'hold' && 'ms' in v) positive(v, 'ms', path);
    if ('waitFor' in v) condition(v.waitFor, `${path}.waitFor`);
    const out: Obj = { ...v };

    switch (action) {
      case 'click':
      case 'hover':
        onlyKeys(v, path, [...common, 'target', ...(action === 'click' ? ['clicks'] : [])]);
        if (!('target' in v)) fail(path, `missing "target" (what to ${action})`);
        else spot(v.target, `${path}.target`);
        if ('clicks' in v && v.clicks !== 2 && v.clicks !== 3) fail(`${path}.clicks`, `must be 2 (double-click: selects a word) or 3 (triple-click: selects a line), got ${show(v.clicks)}`);
        break;
      case 'drag':
        onlyKeys(v, path, [...common, 'from', 'to']);
        for (const k of ['from', 'to']) {
          if (!(k in v)) fail(path, `missing "${k}" (where the drag ${k === 'from' ? 'starts' : 'ends'}: a target or a point [x, y])`);
          else spot(v[k], `${path}.${k}`);
        }
        break;
      case 'type':
        onlyKeys(v, path, [...common, 'target', 'text', 'cps']);
        if ('target' in v) target(v.target, `${path}.target`);
        if (!('text' in v)) fail(path, 'missing "text" (what to type)');
        else if (typeof v.text !== 'string' || v.text === '') fail(`${path}.text`, `must be non-empty text, got ${show(v.text)}`);
        if ('cps' in v && 'ms' in v) fail(path, 'give "cps" (typing speed) or "ms" (how long the step lasts: the typing speed follows), not both');
        out.cps = positive(v, 'cps', path, DEFAULTS.cps[web?.device ?? 'desktop']);
        break;
      case 'press': {
        onlyKeys(v, path, [...common, 'key']);
        const key = text(v, 'key', path);
        const bad = key === undefined ? undefined : keyProblem(key);
        if (bad) fail(`${path}.key`, bad);
        break;
      }
      case 'scroll':
        onlyKeys(v, path, [...common, 'target', 'by']);
        if ('target' in v === 'by' in v) fail(path, 'give either "target" (scroll it into view) or "by": [x, y] in pixels');
        else if ('target' in v) target(v.target, `${path}.target`);
        else if (!Array.isArray(v.by) || v.by.length !== 2 || !v.by.every((n) => typeof n === 'number' && Number.isFinite(n)))
          fail(`${path}.by`, `must be [x, y] in pixels, e.g. [0, 600], got ${show(v.by)}`);
        break;
      case 'wait':
        onlyKeys(v, path, [...common, 'for', 'timeout']);
        if (!('for' in v)) fail(path, 'missing "for" (what to wait for)');
        else condition(v.for, `${path}.for`);
        out.timeout = positive(v, 'timeout', path, DEFAULTS.timeout);
        break;
      case 'hold':
        onlyKeys(v, path, common);
        positive(v, 'ms', path);
        break;
    }
    return out as unknown as Step;
  }

  if (!isObj(input)) return { ok: false, errors: ['the take must be a JSON object'] };
  onlyKeys(input, '', ['version', 'title', 'target', 'theme', 'ready', 'setup', 'steps', 'loop', 'sound']);
  const ready = 'ready' in input ? (Array.isArray(input.ready) ? input.ready : [input.ready]) : undefined;
  if (ready?.length === 0) fail('ready', 'give a condition, e.g. { "visible": { "role": "button", "name": "Deposit" } }, or a list of them');
  ready?.forEach((c, i) => condition(c, Array.isArray(input.ready) ? `ready[${i}]` : 'ready'));

  if (input.version !== TAKE_VERSION) fail('version', `must be ${TAKE_VERSION}, got ${show(input.version)}`);
  text(input, 'title', 'take');
  optText(input, 'theme', 'take');

  let web: WebTarget | undefined;
  if (!isObj(input.target)) fail('target', `must be an object such as { "kind": "web", "url": "http://localhost:3000" }, got ${show(input.target)}`);
  else {
    const t = input.target;
    onlyKeys(t, 'target', ['kind', 'device', 'url', 'address', 'viewport', 'scale', 'login', 'appearance']);
    const device = t.device ?? 'desktop';
    if (!DEVICES.includes(device as Device)) {
      const near = typeof device === 'string' ? closest(device, DEVICES) : undefined;
      fail('target.device', `must be ${DEVICES.map((d) => `"${d}"`).join(' or ')}, got ${show(device)}${near ? ` (did you mean "${near}"?)` : ''}`);
    }
    const phone = device === 'phone';
    if (phone && 'viewport' in t) fail('target.viewport', `a phone's page is always ${phonePage().join('×')} (an iPhone screen minus its status bar); leave "viewport" out`);
    if (t.kind !== 'web') fail('target.kind', `must be "web", got ${show(t.kind)}`);
    const url = text(t, 'url', 'target');
    if (url && !/^https?:\/\//.test(url)) fail('target.url', `must start with http:// or https://, got ${show(url)}`);
    const address = t.address;
    if (address !== undefined && (typeof address !== 'string' || /^[a-z]+:\/\//i.test(address) || /\s/.test(address.trim())))
      fail('target.address', `must be the address as it should appear in the address bar, e.g. "boards.app" or "boards.app/projects" (no http://), got ${show(address)}`);
    const viewport = phone ? phonePage() : t.viewport ?? DEFAULTS.viewport;
    if (!Array.isArray(viewport) || viewport.length !== 2 || !viewport.every((n) => Number.isInteger(n) && n >= 320 && n <= 3840))
      fail('target.viewport', `must be [width, height] in whole pixels between 320 and 3840, e.g. [1440, 900], got ${show(t.viewport)}`);
    const scale = t.scale ?? DEFAULTS.scale;
    if (scale !== 1 && scale !== 1.5 && scale !== 2) fail('target.scale', `must be 1, 1.5 or 2, got ${show(t.scale)}`);
    const login = t.login;
    if (login !== undefined && (typeof login !== 'string' || !isLoginName(login)))
      fail('target.login', `must be the name of a saved login, e.g. "boards.app" (letters, digits, dots, dashes, underscores), got ${show(login)}`);
    const appearance = t.appearance;
    if (appearance !== undefined && !APPEARANCES.includes(appearance as Appearance))
      fail('target.appearance', `must be ${APPEARANCES.map((a) => `"${a}"`).join(' or ')}, or left out to follow the site, got ${show(appearance)}`);
    web = {
      kind: 'web',
      device: phone ? 'phone' : 'desktop',
      url: url ?? '',
      ...(typeof address === 'string' ? { address: address.trim() } : {}),
      viewport: viewport as [number, number],
      scale: scale as 1 | 1.5 | 2,
      ...(typeof login === 'string' ? { login } : {}),
      ...(appearance !== undefined ? { appearance: appearance as Appearance } : {}),
    };
  }

  const setup: Step[] = [];
  if ('setup' in input) {
    if (!Array.isArray(input.setup) || input.setup.length === 0) fail('setup', 'must be a list of steps, e.g. [{ "do": "click", "target": { "role": "button", "name": "Reject all" } }]');
    else input.setup.forEach((s, i) => {
      const out = step(s, `setup[${i}]`);
      if (out) setup.push(out);
    });
  }

  const steps: Step[] = [];
  if (!Array.isArray(input.steps) || input.steps.length === 0) fail('steps', 'must be a list with at least one step');
  else input.steps.forEach((s, i) => {
    const out = step(s, `steps[${i}]`);
    if (out) steps.push(out);
  });

  if (web?.device === 'phone')
    for (const [list, name] of [[setup, 'setup'], [steps, 'steps']] as const)
      list.forEach((s, i) => s.do === 'hover' && fail(`${name}[${i}].do`, 'a phone has no hover: tap the element ("click") or leave the step out'));

  if (web && Array.isArray(web.viewport)) {
    const [w, h] = web.viewport;
    for (const [path, [x, y]] of points)
      if (x < 0 || y < 0 || x > w || y > h) fail(path, `point [${x}, ${y}] is outside the ${w}×${h} page`);
  }

  const marks = steps.map((s) => s.mark).filter((m): m is string => !!m);
  for (const m of new Set(marks.filter((m, i) => marks.indexOf(m) !== i))) fail('steps', `mark "${m}" is used more than once; marks must be unique`);

  const loop = input.loop ?? DEFAULTS.loop;
  if (!LOOPS.includes(loop as (typeof LOOPS)[number])) fail('loop', `must be one of ${LOOPS.join(', ')}, got ${show(input.loop)}`);
  const sound = input.sound ?? DEFAULTS.sound;
  if (typeof sound !== 'boolean') fail('sound', `must be true or false, got ${show(input.sound)}`);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    take: {
      version: 0,
      title: input.title as string,
      target: web!,
      theme: (input.theme as string | undefined) ?? DEFAULTS.theme,
      ...(ready ? { ready: ready as Condition[] } : {}),
      ...(setup.length ? { setup } : {}),
      steps,
      loop: loop as Take['loop'],
      sound: sound as boolean,
    },
  };
}

const KEY_NAMES = new Set([
  'Shift', 'Control', 'Alt', 'Meta', 'ControlOrMeta', 'Escape', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'CapsLock', 'ContextMenu',
  'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'AltGraph', 'MetaLeft', 'MetaRight',
  'Backquote', 'Minus', 'Equal', 'Backslash', 'BracketLeft', 'BracketRight', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
  'PrintScreen', 'ScrollLock', 'Pause', 'NumLock', 'NumpadDivide', 'NumpadMultiply', 'NumpadSubtract', 'NumpadAdd', 'NumpadDecimal', 'NumpadEnter',
  'AudioVolumeMute', 'AudioVolumeDown', 'AudioVolumeUp', 'MediaTrackNext', 'MediaTrackPrevious', 'MediaPlayPause',
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
  ...Array.from({ length: 10 }, (_, i) => `Numpad${i}`),
  ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
]);
const KEY_ALIASES: Record<string, string> = {
  cmd: 'Meta', command: 'Meta', '⌘': 'Meta', super: 'Meta', win: 'Meta', ctrl: 'Control', control: 'Control', '⌃': 'Control',
  option: 'Alt', opt: 'Alt', alt: 'Alt', '⌥': 'Alt', shift: 'Shift', '⇧': 'Shift', esc: 'Escape', escape: 'Escape', return: 'Enter',
  enter: 'Enter', del: 'Delete', delete: 'Delete', backspace: 'Backspace', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft',
  right: 'ArrowRight', space: 'Space', spacebar: 'Space', tab: 'Tab', pgup: 'PageUp', pgdn: 'PageDown', home: 'Home', end: 'End',
};

export function keyProblem(key: string): string | undefined {
  const parts = key === '+' ? ['+'] : key.split(/\+(?!$)/);
  for (const part of parts) {
    if ([...part].length === 1 || KEY_NAMES.has(part)) continue;
    const name = KEY_ALIASES[part.toLowerCase()] ?? closest(part, [...KEY_NAMES]);
    return `unknown key "${part}"${name ? `; use ${name} (e.g. "${key.replace(part, name)}")` : ''}. Join keys with +, as in "Meta+K"`;
  }
  return undefined;
}

function closest(word: string, options: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDist = Infinity;
  for (const o of options) {
    const d = distance(word.toLowerCase(), o.toLowerCase());
    if (d < bestDist) [best, bestDist] = [o, d];
  }
  return bestDist <= Math.max(1, Math.floor(word.length / 3)) ? best : undefined;
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}
