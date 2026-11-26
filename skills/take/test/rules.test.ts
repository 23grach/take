import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const TOOL = path.resolve(import.meta.dirname, '..');
const REPO = path.resolve(TOOL, '../..');
const CODE_DIRS = ['src', 'test', 'bin', 'examples', 'themes'].map((dir) => path.join(TOOL, dir));
const NO_COMMENTS = 'No comments in code (AGENTS.md). Rename or restructure until the code says it, and put the reason in the commit message';

const REGEX_CAN_FOLLOW = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_CAN_FOLLOW_WORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);
const VALUE_END = ')';

function scriptCommentLines(source: string): number[] {
  const found: number[] = [];
  const templateBraceDepths: number[] = [];
  let braceDepth = 0;
  let previous = '';
  let i = source.startsWith('#!') ? source.indexOf('\n') : 0;
  const lineAt = (at: number) => source.slice(0, at).split('\n').length;

  const skipQuoted = (quote: string) => {
    for (i++; i < source.length && source[i] !== quote && source[i] !== '\n'; i++) if (source[i] === '\\') i++;
    i++;
  };
  const skipTemplateText = () => {
    while (i < source.length) {
      if (source[i] === '\\') i += 2;
      else if (source[i] === '`') {
        i++;
        return;
      } else if (source[i] === '$' && source[i + 1] === '{') {
        templateBraceDepths.push(braceDepth);
        braceDepth++;
        i += 2;
        return;
      } else i++;
    }
  };
  const skipRegex = () => {
    let inClass = false;
    for (i++; i < source.length && source[i] !== '\n'; i++) {
      if (source[i] === '\\') i++;
      else if (source[i] === '[') inClass = true;
      else if (source[i] === ']') inClass = false;
      else if (source[i] === '/' && !inClass) break;
    }
    for (i++; /[a-z]/.test(source[i] ?? ''); i++);
  };
  const skipComment = () => {
    found.push(lineAt(i));
    const end = source[i + 1] === '/' ? source.indexOf('\n', i) : source.indexOf('*/', i + 2) + 2;
    i = end <= 1 ? source.length : end;
  };

  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) {
      i++;
    } else if (c === '/' && (source[i + 1] === '/' || source[i + 1] === '*')) {
      skipComment();
    } else if (c === '"' || c === "'") {
      skipQuoted(c);
      previous = VALUE_END;
    } else if (c === '`') {
      i++;
      skipTemplateText();
      previous = VALUE_END;
    } else if (c === '/' && (previous === '' || REGEX_CAN_FOLLOW.has(previous))) {
      skipRegex();
      previous = VALUE_END;
    } else if (c === '{') {
      braceDepth++;
      i++;
      previous = c;
    } else if (c === '}') {
      braceDepth--;
      i++;
      previous = c;
      if (templateBraceDepths.at(-1) === braceDepth) {
        templateBraceDepths.pop();
        skipTemplateText();
        previous = VALUE_END;
      }
    } else if (/[\w$]/.test(c)) {
      const start = i;
      while (/[\w$]/.test(source[i] ?? '')) i++;
      previous = REGEX_CAN_FOLLOW_WORDS.has(source.slice(start, i)) ? '(' : VALUE_END;
    } else {
      previous = c;
      i++;
    }
  }
  return found;
}

function commentLines(file: string): number[] {
  const source = fs.readFileSync(file, 'utf8');
  const linesWhere = (matches: (line: string) => boolean) => source.split('\n').flatMap((line, n) => (matches(line) ? [n + 1] : []));
  if (/\.(ts|js|mjs)$/.test(file) || path.basename(file) === 'take') return scriptCommentLines(source);
  if (/\.(svg|html|css)$/.test(file)) return linesWhere((line) => line.includes('<!--') || line.includes('/*'));
  if (/\.ya?ml$/.test(file)) return linesWhere((line) => /^\s*#/.test(line));
  if (file.endsWith('.json')) return linesWhere((line) => line.includes('"$comment"'));
  return [];
}

const filesIn = (dir: string) =>
  fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && !entry.parentPath.includes('node_modules'))
    .map((entry) => path.join(entry.parentPath, entry.name));

test('the comment finder sees comments, and not strings, templates or regexes that look like them', () => {
  const source = [
    '#!/usr/bin/env node',
    "const url = 'http://a.test/' + \"//b\";",
    'const page = `<a href="//c">${x ? `/*` : y}</a>`;',
    'const slash = /https?:\\/\\//g.test(url) ? a / b / c : 0;',
    'const html = s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);',
    'const half = total / 2; // a trailing comment',
    '/* a block',
    '   comment */',
  ].join('\n');
  assert.deepEqual(scriptCommentLines(source), [6, 7]);
});

test('no comments in code, tests, themes or CI', () => {
  const files = [...CODE_DIRS.flatMap(filesIn), ...filesIn(path.join(REPO, '.github'))];
  const found = files.flatMap((file) => commentLines(file).map((line) => `${path.relative(REPO, file)}:${line}`));
  assert.deepEqual(found, [], `${NO_COMMENTS}:\n  ${found.join('\n  ')}`);
});

test('a release bumps the version in package.json and both plugin manifests together', () => {
  const files = ['skills/take/package.json', '.claude-plugin/plugin.json', '.cursor-plugin/plugin.json'];
  const versionOf = (file: string) => (JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8')) as { version?: string }).version;
  const versions = files.map((file) => `${file}: ${versionOf(file)}`);
  assert.equal(new Set(files.map(versionOf)).size, 1, `Versions differ (AGENTS.md): set the same "version" in all three files:\n  ${versions.join('\n  ')}`);
});
