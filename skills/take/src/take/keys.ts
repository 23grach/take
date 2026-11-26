import { closest } from './closest.ts';

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
