import MarkdownIt from 'markdown-it';
import { diffArrays, diffChars } from 'diff';

/**
 * WYSIWYG 에디터는 편집 결과를 "정규화된" Markdown 으로 다시 직렬화한다
 * (리스트 기호 `*` → `-`, 표 패딩, 이스케이프 등). 그대로 파일에 쓰면 한 글자만 고쳐도
 * 문서 전체가 바뀌므로, 정규화본 사이의 변경분(prev → next)만 원본 텍스트에 반영한다.
 *
 * 1) 원본(O) ↔ 이전 정규화본(N) 을 서식 차이를 무시하고 줄 단위로 정렬한다.
 * 2) N → 새 정규화본(N') 의 줄 diff 를 구해, 바뀌지 않은 줄은 원본 줄을, 바뀐 줄은 N' 줄을 쓴다.
 * 3) 결과가 N' 과 동일하게 렌더링되는지 검증하고, 다르면 안전하게 N' 전체로 대체한다.
 */

/**
 * 이스케이프를 빼도 되는지 판단할 때 쓰는 엄격한 기준: GitHub 등 다른 뷰어처럼 참조형 링크와 URL 자동 링크를 해석한다
 */
const md = new MarkdownIt({ html: true, linkify: true });

/**
 * 편집기(Toast UI)와 같은 해석: 참조형 링크 정의를 지원하지 않고(referenceDefinition: false),
 * 맨 URL 을 링크로 만들지 않는다(extendedAutolinks: false). 원본 패치 결과가 편집기 화면과 같은지 볼 때 쓴다.
 * 이걸 엄격한 기준으로 보면 참조형 링크가 있는 문서는 편집할 때마다 문서 전체가 정규화본으로 바뀐다
 */
const toastLike = new MarkdownIt({ html: true }).disable('reference');
// Toast UI 는 리스트를 항상 붙여 쓴다(항목 사이 빈 줄 없음). 빈 줄로 띄운 리스트의 항목에 생기는 <p> 를 없애
// 원본이 띄운 리스트여도 편집기와 같은 기준으로 비교한다
toastLike.core.ruler.push('tight_lists', (state) => {
  const tokens = state.tokens;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i].type !== 'paragraph_open' || tokens[i - 1].type !== 'list_item_open') continue;
    tokens[i].hidden = true;
    for (let k = i + 1; k < tokens.length; k++) {
      if (tokens[k].type === 'paragraph_close' && tokens[k].level === tokens[i].level) {
        tokens[k].hidden = true;
        break;
      }
    }
  }
});

/** 참조형 링크 정의 (`[label]: url`). 문서 일부만 렌더링할 때 나머지 부분의 정의를 넘겨준다 */
export type References = Record<string, unknown>;

/** 문서에 있는 참조형 링크 정의 */
export function referencesOf(source: string): References {
  const env: { references?: References } = {};
  md.parse(source, env);
  return env.references ?? {};
}

function renderKey(source: string, references?: References): string {
  // markdown-it 은 env 에 이미 있는 정의를 덮어쓰지 않으므로 그대로 넘기면 된다 (env 는 렌더링마다 새로)
  const env = references ? { references: { ...references } } : {};
  return md.render(source, env).replace(/\s+/g, ' ').trim();
}

/** 서식 차이를 무시하고 줄을 비교하기 위한 느슨한 정규화 */
function looseLine(line: string): string {
  if (HR_RE.test(line)) return '---'; // 구분선 (`---`, `***`, `___`)
  return line
    .replace(/^(\s*)[*+](\s)/, '$1-$2') // 리스트 기호
    .replace(/^(\s*)\d+[.)](\s)/, '$11.$2') // 순서 리스트 번호
    .replace(/\\([\\`*_{}[\]()#+\-.!|~<>])/g, '$1') // 이스케이프
    .replace(/__|\*\*/g, '**')
    .replace(/(^|[^*])[_*]([^*]|$)/g, '$1*$2')
    .replace(/\s*\|\s*/g, '|') // 표 셀 패딩
    .replace(/:?-{3,}:?/g, '---') // 표 구분선
    .replace(/\s+/g, ' ')
    .trim();
}

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 리스트 항목 표시. 1: 앞부분(들여쓰기, 인용), 2: 기호 또는 번호+구분자 */
const BULLET_RE = /^((?:\s*>)*\s*)([-*+])(?=\s)/;
const ORDERED_RE = /^((?:\s*>)*\s*)(\d{1,9}[.)])(?=\s)/;
const FENCE_RE = /^(?:\s*>)*\s{0,3}(`{3,}|~{3,})/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
/** 원본에서 이 거리(줄) 안의 같은 들여쓰기 리스트 줄을 따른다 */
const NEIGHBOR_RANGE = 20;

/** 코드 블록 안의 줄 표시 */
function insideFence(lines: string[]): boolean[] {
  let fence: string | undefined;
  return lines.map((line) => {
    const m = FENCE_RE.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !line.slice(m.index + m[0].length).trim()) fence = undefined;
      return true;
    }
    if (m) fence = m[1];
    return false;
  });
}

/** 원본 문서에서 가장 많이 쓴 리스트 기호와 구분선 표기. 없으면 `-`, `---` */
function documentStyle(orig: string[]): { bullet: string; hr: string } {
  const fenced = insideFence(orig);
  const count: Record<string, number> = {};
  let hr: string | undefined;
  orig.forEach((line, i) => {
    if (fenced[i]) return;
    const b = BULLET_RE.exec(line);
    if (b && !HR_RE.test(line)) count[b[2]] = (count[b[2]] ?? 0) + 1;
    else if (!hr && HR_RE.test(line) && (i === 0 || orig[i - 1].trim() === '')) hr = line.trim();
  });
  const bullet = Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-';
  return { bullet, hr: hr ?? '---' };
}

/**
 * 에디터가 새로 쓴 줄의 리스트 기호(`*`)·번호 구분자(`1.`)·구분선(`***`)을 원본 문서의 표기로 되돌린다.
 * 주변(같은 들여쓰기)에 원본 리스트 줄이 있으면 그 기호를 따르고(섞이면 별개의 리스트가 되므로),
 * 없으면 문서에서 가장 많이 쓴 기호를 쓴다.
 * @param keepRendering 렌더링이 달라지면 바꾸지 않는다. 검증을 마친 줄에 쓴다
 *   (검증 전에는 새 줄의 `*` 때문에 갈라진 리스트를 다시 잇는 것이 목적이라 렌더링이 달라지는 게 맞다)
 */
function restoreMarkers(
  lines: string[],
  spans: Array<Span | undefined>,
  orig: string[],
  keepRendering: boolean,
): string[] {
  const written = (i: number) => spans[i]?.from === 0;
  if (!lines.some((_, i) => written(i))) return lines;
  const style = documentStyle(orig);
  const fenced = insideFence(lines);

  // 내용이 같은 원본 줄이 있으면 그 줄의 표시를 그대로 쓴다 (편집기가 블록을 통째로 다시 쓴 경우).
  // 같은 내용이 서로 다른 표시로 여러 번 있으면 쓰지 않는다
  const origMarks = new Map<string, string | null>();
  const markKey = (re: RegExp, m: RegExpExecArray, line: string) =>
    `${re === BULLET_RE ? 'b' : 'o'}|${m[1].length}|${looseLine(line.slice(m[0].length))}`;
  const origFenced = insideFence(orig);
  orig.forEach((line, i) => {
    if (origFenced[i] || HR_RE.test(line)) return;
    for (const re of [BULLET_RE, ORDERED_RE]) {
      const m = re.exec(line);
      if (!m) continue;
      const key = markKey(re, m, line);
      const mark = re === BULLET_RE ? m[2] : m[2].slice(-1);
      origMarks.set(key, origMarks.has(key) && origMarks.get(key) !== mark ? null : mark);
    }
  });
  const sameContentMark = (re: RegExp, m: RegExpExecArray, line: string) => origMarks.get(markKey(re, m, line)) ?? undefined;

  /** 같은 리스트 안(위아래로 다른 블록을 만나기 전까지)의 원본 줄 중 같은 앞부분을 가진 항목의 표시 */
  const neighborMark = (i: number, re: RegExp, prefix: string): string | undefined => {
    for (const dir of [-1, 1]) {
      for (let j = i + dir, n = 0; j >= 0 && j < lines.length && n < NEIGHBOR_RANGE; j += dir, n++) {
        const line = lines[j];
        if (line.trim() === '' || fenced[j]) continue;
        const m = re.exec(line);
        if (m && m[1] === prefix && !HR_RE.test(line)) {
          if (!written(j)) return m[2];
          continue;
        }
        // 더 깊이 들여쓴 줄(중첩 리스트, 이어지는 줄)은 같은 리스트 안이다. 그 밖의 줄을 만나면 리스트가 끝난 것
        const indent = /^(?:\s*>)*\s*/.exec(line)![0].length;
        if (indent <= prefix.length) break;
      }
    }
    return undefined;
  };

  const out = lines.map((line, i) => {
    if (!written(i) || fenced[i]) return line;
    if (HR_RE.test(line)) {
      // 구분선: 바로 위가 빈 줄일 때만 (`---` 가 바로 위 문단을 제목으로 만들지 않도록)
      return i === 0 || lines[i - 1].trim() === '' ? style.hr : line;
    }
    const b = BULLET_RE.exec(line);
    if (b) {
      const mark = sameContentMark(BULLET_RE, b, line) ?? neighborMark(i, BULLET_RE, b[1]) ?? style.bullet;
      return mark === b[2] ? line : b[1] + mark + line.slice(b[0].length);
    }
    const o = ORDERED_RE.exec(line);
    if (o) {
      const delim = sameContentMark(ORDERED_RE, o, line) ?? neighborMark(i, ORDERED_RE, o[1])?.slice(-1);
      return !delim || delim === o[2].slice(-1) ? line : o[1] + o[2].slice(0, -1) + delim + line.slice(o[0].length);
    }
    return line;
  });
  if (!keepRendering) return out;
  return renderKey(out.join('\n')) === renderKey(lines.join('\n')) ? out : lines;
}

function commonPrefix(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

function commonSuffix(a: string, b: string, max: number): number {
  let i = 0;
  while (i < max && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** 줄에서 에디터가 새로 써 넣은 구간 [from, to). 이 구간의 이스케이프만 걷어낼 수 있다 */
interface Span {
  from: number;
  to: number;
}

const wholeLine = (line: string): Span => ({ from: 0, to: line.length });

/**
 * 한 줄 안에서의 3-way 병합.
 * orig: 원본 줄, norm: 정규화된 같은 줄, next: 편집 후 정규화된 줄.
 * norm → next 에서 바뀐 구간이 원본과 정규화본이 같은 영역(앞쪽 또는 뒤쪽) 안에 있으면
 * 원본 줄에서 그 구간만 바꾼다. 위치를 확정할 수 없으면 undefined.
 */
function mergeLine(orig: string, norm: string, next: string): { line: string; span?: Span } | undefined {
  // 내용은 그대로이고 서식(이스케이프 등)만 달라졌다면 원본 줄을 유지한다
  if (orig !== norm && looseLine(orig) === looseLine(next)) return { line: orig };

  // norm 의 [p, norm.length - s) 가 next 에서 y 로 바뀌었다
  const p = commonPrefix(norm, next);
  const s = commonSuffix(norm, next, Math.min(norm.length, next.length) - p);
  const y = next.slice(p, next.length - s);
  if (orig === norm) return { line: next, span: { from: p, to: p + y.length } };

  // norm ↔ orig 를 글자 단위로 정렬해 바뀐 구간의 양 끝을 원본 위치로 옮긴다.
  // 양 끝이 둘 다 "같은 글자" 영역에 있어야 위치가 확정된다
  const start = mapPosition(norm, orig, p, 'start');
  const end = mapPosition(norm, orig, norm.length - s, 'end');
  if (start === undefined || end === undefined || start > end) return undefined;
  return { line: orig.slice(0, start) + y + orig.slice(end), span: { from: start, to: start + y.length } };
}

/** CommonMark 백슬래시 이스케이프 (`\` + ASCII 구두점) */
const ESCAPE_RE = /\\[!-/:-@[-`{-~]/g;

/** 리스트 항목 표시까지 (인용 안 포함). 이 바로 뒤의 `[ ]` 는 작업 목록(체크박스)이 된다 */
const LIST_ITEM_START_RE = /^(?:\s*>)*\s*(?:[-*+]|\d+[.)])\s+$/;

/**
 * 판단에 쓰는 markdown-it 이 모르는 문법이라, 렌더링이 같아 보여도 남겨야 하는 이스케이프.
 * - `\~`: GitHub 은 `~a~` 한 개짜리도 취소선으로 그린다
 * - 리스트 항목 맨 앞의 `\[`: `[ ]` / `[x]` 가 작업 목록이 된다 (Toast UI, GitHub)
 * - `\[^` `\[!`: GitHub 각주 `[^1]`, 알림 `[!NOTE]`
 */
function mustKeepEscape(line: string, pos: number): boolean {
  const ch = line[pos + 1];
  if (ch === '~') return true;
  if (ch !== '[') return false;
  return line[pos + 2] === '^' || line[pos + 2] === '!' || LIST_ITEM_START_RE.test(line.slice(0, pos));
}

function removeAt(line: string, positions: number[]): string {
  let out = line;
  for (let k = positions.length - 1; k >= 0; k--) out = out.slice(0, positions[k]) + out.slice(positions[k] + 1);
  return out;
}

/**
 * Toast UI 는 글 속의 `* _ ~ [ ] ( ) # . - \` 등을 렌더링에 영향이 없어도 모두 `\` 로 이스케이프한다.
 * 에디터가 새로 써 넣은 구간(spans)의 이스케이프 중, 빼도 문서 렌더링이 그대로인 것만 걷어낸다.
 * (예: `C:\\Users` → `C:\Users`, `1\. 항목` 은 빼면 리스트가 되므로 유지)
 */
function stripRedundantEscapes(
  lines: string[],
  spans: Array<Span | undefined>,
  references?: References,
): string[] {
  const candidates = lines.map((line, i) => {
    const span = spans[i];
    if (!span) return [];
    const found: number[] = [];
    for (const m of line.matchAll(ESCAPE_RE)) {
      if (m.index! >= span.from && m.index! < span.to && !mustKeepEscape(line, m.index!)) found.push(m.index!);
    }
    return found;
  });
  if (candidates.every((c) => c.length === 0)) return lines;

  // 렌더링한 글자 수 예산. 다 쓰면 남은 이스케이프는 그대로 둔다 (편집이 느려지지 않도록)
  let budget = RENDER_BUDGET;
  const render = (ls: string[], refs?: References) => {
    const source = ls.join('\n');
    budget -= source.length + 1;
    return renderKey(source, refs);
  };
  // 걷어내기 전과 똑같이 그려져야 한다 (엄격한 기준)
  const target = render(lines, references);

  // 1) 빈 줄로 나뉜 덩어리마다 따로 판단한다 (작게 렌더링하므로 빠르다).
  //    덩어리 밖에 있는 참조형 링크 정의도 알 수 있도록 문서 전체의 정의를 함께 넘긴다
  const localRefs = { ...referencesOf(lines.join('\n')), ...references };
  const chunks: Chunk[] = [];
  let start = 0;
  for (let i = 0; i <= lines.length; i++) {
    if (i < lines.length && lines[i].trim() !== '') continue;
    if (candidates.slice(start, i).some((c) => c.length > 0) && budget > 0) {
      const stripped = stripChunk(lines.slice(start, i), candidates.slice(start, i), localRefs, render, () => budget > 0);
      if (stripped) chunks.push({ start, lines: stripped });
    }
    start = i + 1;
  }

  // 2) 덩어리 사이에 영향을 주는 경우(코드 블록, 리스트 등)가 있으므로 문서 전체로 확인한다.
  //    대부분 한 번에 통과하고, 아니면 반씩 나눠 문제 없는 덩어리만 받아들인다
  const apply = (set: Chunk[]) => {
    const out = [...lines];
    for (const c of set) out.splice(c.start, c.lines.length, ...c.lines);
    return out;
  };
  const accepted: Chunk[] = [];
  const bisect = (group: Chunk[]) => {
    if (group.length === 0 || budget <= 0) return;
    if (render(apply([...accepted, ...group]), references) === target) {
      accepted.push(...group);
    } else if (group.length > 1) {
      const mid = group.length >> 1;
      bisect(group.slice(0, mid));
      bisect(group.slice(mid));
    }
  };
  bisect(chunks);
  return apply(accepted);
}

/** 렌더링 예산(글자 수). 수백 KB 문서에서도 수백 ms 안쪽 */
const RENDER_BUDGET = 3_000_000;

interface Chunk {
  start: number;
  lines: string[];
}

/** 한 덩어리 안에서 렌더링이 그대로인 이스케이프를 걷어낸다. 바뀐 게 없으면 undefined */
function stripChunk(
  lines: string[],
  candidates: number[][],
  refs: References,
  render: (ls: string[], refs?: References) => string,
  hasBudget: () => boolean,
): string[] | undefined {
  const target = render(lines, refs);
  // 대부분은 한꺼번에 빼도 같다
  const all = lines.map((line, i) => removeAt(line, candidates[i]));
  if (render(all, refs) === target) return all;

  // 아니면 줄 단위로, 그래도 안 되면 이스케이프 하나씩 (뒤에서부터 빼야 앞쪽 위치가 유지된다)
  const cur = [...lines];
  let changed = false;
  const tryLine = (i: number, line: string) => {
    if (!hasBudget()) return true; // 예산을 다 쓰면 더 시도하지 않는다
    const before = cur[i];
    cur[i] = line;
    if (render(cur, refs) === target) return (changed = true);
    cur[i] = before;
    return false;
  };
  candidates.forEach((positions, i) => {
    if (positions.length === 0 || tryLine(i, removeAt(cur[i], positions))) return;
    for (let k = positions.length - 1; k >= 0; k--) tryLine(i, removeAt(cur[i], [positions[k]]));
  });
  return changed ? cur : undefined;
}

/** norm 의 위치 pos 를 orig 의 위치로 옮긴다. 같은 글자 구간 밖이면 undefined */
function mapPosition(norm: string, orig: string, pos: number, edge: 'start' | 'end'): number | undefined {
  let n = 0;
  let o = 0;
  let candidate: number | undefined;
  for (const part of diffChars(norm, orig)) {
    const len = part.value.length;
    if (part.added) {
      o += len; // 원본에만 있는 글자
    } else if (part.removed) {
      n += len; // 정규화본에만 있는 글자 (예: 이스케이프 \)
    } else {
      if (pos >= n && pos <= n + len) {
        candidate = o + (pos - n);
        // 구간 경계에 걸친 경우: 시작점은 처음 만난 구간, 끝점은 다음 구간 시작이 더 정확하므로 계속 본다
        if (edge === 'start' || pos < n + len) return candidate;
      }
      n += len;
      o += len;
    }
  }
  return candidate;
}

interface Group {
  /** groups 배열 내 위치 */
  idx: number;
  /** 이 그룹에 대응하는 원본 줄들 */
  orig: string[];
  /** 대응하는 정규화본(N) 줄 인덱스들 */
  norm: number[];
}

/**
 * @param references 문서 일부(블록)만 넘길 때, 문서 나머지에 있는 참조형 링크 정의.
 *   없으면 `\[foo\]` 처럼 블록 안에서는 글자로 보이지만 문서 전체에서는 링크가 되는 이스케이프를 걷어낼 수 있다
 */
export function applyNormalizedEdit(
  original: string,
  prevNorm: string,
  nextNorm: string,
  references?: References,
): string {
  if (prevNorm === nextNorm) return original;

  const orig = original.replace(/\r\n/g, '\n');
  const endsWithNewline = orig.endsWith('\n');
  const origLines = splitLines(orig);
  const finish = (lines: string[], spans: Array<Span | undefined>) =>
    stripRedundantEscapes(restoreMarkers(lines, spans, origLines, true), spans, references).join('\n') +
    (endsWithNewline ? '\n' : '');

  // 원본 패치 결과가 편집기 화면과 같게 그려지는지 편집기 기준으로 확인한다.
  // (블록만 넘어온 경우에도 편집기는 참조형 링크를 해석하지 않으므로 references 는 필요 없다)
  const patched = patchOriginal(orig, prevNorm, nextNorm);
  // 새로 쓴 리스트 줄이 원본과 다른 기호면 별개의 리스트가 되므로, 원본 표기로 맞춘 것을 먼저 검증한다
  const verified =
    patched &&
    (verifyPatch(orig, prevNorm, nextNorm, { ...patched, lines: restoreMarkers(patched.lines, patched.spans, origLines, false) }) ??
      verifyPatch(orig, prevNorm, nextNorm, patched));
  if (verified) return finish(verified.lines, verified.spans);
  // 안전장치: 정규화본 전체로 대체 (모든 줄이 에디터가 쓴 것)
  const all = splitLines(nextNorm);
  return finish(all, all.map(wholeLine));
}

const HTML_TOKEN_RE = /<[^>]*>|&[#a-zA-Z0-9]+;|[\p{L}\p{N}_]+|\s+|[\s\S]/gu;
const isWordToken = (t: string) => !t.startsWith('<') && t.trim() !== '';
/** 바뀐 곳마다 앞뒤로 비교하는 글자 토큰 수. 같은 변화가 엉뚱한 자리에 들어간 것을 걸러낸다 */
const DELTA_CONTEXT = 4;

/**
 * 렌더링 결과(편집기 기준)가 before → after 로 어떻게 바뀌었는지: 바뀐 곳마다 [앞 문맥, 지운 것, 넣은 것, 뒤 문맥].
 * 문맥은 글자 토큰만 쓴다 (빈 줄로 띄운 리스트의 <p> 처럼 편집기가 바꾼 태그는 문맥에서 빠진다)
 */
function editDelta(before: string, after: string): string[] {
  const tokens = (s: string) => (toastLike.render(s).match(HTML_TOKEN_RE) ?? []).map((t) => (t.trim() ? t : ' '));
  const b = tokens(before);
  const parts = diffArrays(b, tokens(after));
  const out: string[] = [];
  let bi = 0; // before 에서의 위치
  for (let k = 0; k < parts.length; k++) {
    if (!parts[k].added && !parts[k].removed) {
      bi += parts[k].value.length;
      continue;
    }
    let removed: string[] = [];
    let added: string[] = [];
    for (; k < parts.length && (parts[k].added || parts[k].removed); k++) {
      if (parts[k].added) added = added.concat(parts[k].value);
      else removed = removed.concat(parts[k].value);
    }
    k--;
    let at = bi;
    // 넣기만 / 지우기만 한 경우 같은 변화라도 diff 가 고른 자리가 앞뒤로 밀릴 수 있다
    // (`<li>새</li>` ↔ `새</li><li>`). 갈 수 있는 가장 앞자리로 옮겨 같은 모양으로 맞춘다
    if (removed.length === 0) {
      while (at > 0 && b[at - 1] === added[added.length - 1]) added = [b[--at], ...added.slice(0, -1)];
    } else if (added.length === 0) {
      while (at > 0 && b[at - 1] === b[at + removed.length - 1]) at--;
      removed = b.slice(at, at + removed.length);
    }
    const prev = b.slice(Math.max(0, at - 200), at).filter(isWordToken).slice(-DELTA_CONTEXT);
    const next = b.slice(at + removed.length, at + removed.length + 200).filter(isWordToken).slice(0, DELTA_CONTEXT);
    out.push(JSON.stringify([prev, removed.join(''), added.join(''), next]));
    bi += removed.length;
  }
  return out;
}

const sameEdit = (a: string[], b: string[]) => a.length > 0 && a.length === b.length && a.every((x, k) => x === b[k]);

/** 편집기 기준으로 렌더링한 최상위 블록 */
interface RenderedBlock {
  html: string;
  /** 줄 범위 [시작, 끝) */
  range: [number, number];
}

function renderBlocks(source: string): RenderedBlock[] {
  const env = {};
  const tokens = toastLike.parse(source, env);
  const blocks: RenderedBlock[] = [];
  let i = 0;
  while (i < tokens.length) {
    const start = i;
    let depth = 0;
    do {
      depth += tokens[i].nesting;
      i++;
    } while (depth > 0 && i < tokens.length);
    const map = tokens[start].map;
    if (!map) continue;
    const html = toastLike.renderer.render(tokens.slice(start, i), toastLike.options, env).replace(/\s+/g, ' ').trim();
    blocks.push({ html, range: [map[0], map[1]] });
  }
  return blocks;
}

interface BlockHunk {
  a: RenderedBlock[];
  b: RenderedBlock[];
  /** a 쪽 hunk 바로 앞까지 일치한 블록 수 (블록 인덱스) */
  aAt: number;
  bAt: number;
}

function blockHunks(a: RenderedBlock[], b: RenderedBlock[]): BlockHunk[] {
  const hunks: BlockHunk[] = [];
  let ai = 0;
  let bi = 0;
  let cur: BlockHunk | undefined;
  for (const part of diffArrays(a, b, { comparator: (x, y) => x.html === y.html })) {
    const n = part.value.length;
    if (part.removed || part.added) {
      if (!cur) hunks.push((cur = { a: [], b: [], aAt: ai, bAt: bi }));
      if (part.removed) {
        cur.a.push(...a.slice(ai, ai + n));
        ai += n;
      } else {
        cur.b.push(...b.slice(bi, bi + n));
        bi += n;
      }
    } else {
      cur = undefined;
      ai += n;
      bi += n;
    }
  }
  return hunks;
}

const hunkKey = (a: RenderedBlock[], b: RenderedBlock[]) => JSON.stringify([a.map((x) => x.html), b.map((x) => x.html)]);

/**
 * 패치 결과(P)가 새 정규화본(N')과 같게 그려지는지 블록 단위로 확인한다.
 *
 * Toast UI 의 직렬화는 일부 문법에서 내용을 잃는다 (HTML 블록, 엔티티 `&nbsp;` `&lt;`, 줄 끝 공백 두 칸 줄바꿈 등).
 * 이런 블록은 편집하지 않아도 원본(O)과 이전 정규화본(N)이 다르게 그려지므로, 문서 전체를 비교하면
 * 어디를 고치든 검증에 실패해 문서 전체가 정규화본으로 바뀌어 버린다 (원래 기호·서식이 모두 무너짐).
 *
 * 그래서 O ↔ N 에 원래 있던 차이는 허용하고, 그 밖의 차이가 나는 블록만 N' 의 해당 줄로 바꾼다.
 * 그래도 맞지 않으면 undefined (호출한 쪽에서 문서 전체를 정규화본으로 대체).
 */
function verifyPatch(
  orig: string,
  prevNorm: string,
  nextNorm: string,
  patched: { lines: string[]; spans: Array<Span | undefined> },
): { lines: string[]; spans: Array<Span | undefined> } | undefined {
  const target = renderBlocks(nextNorm);
  const hunks = blockHunks(renderBlocks(patched.lines.join('\n')), target);
  if (hunks.length === 0) return patched;

  // 편집한 블록 자체가 직렬화로 달라지는 블록이어도 (빈 줄로 띄운 리스트, 줄 끝 공백 줄바꿈 등)
  // 원본에 일어난 변화가 편집기에서 일어난 변화와 같으면 그대로 받아들인다
  const patchedText = patched.lines.join('\n');
  if (sameEdit(editDelta(orig, patchedText), editDelta(prevNorm, nextNorm))) return patched;

  // 편집 전부터 있던 차이 (편집기 직렬화로 잃은 것들): hunk 전체, 그리고 같은 수로 짝지어지는 블록 쌍
  const known = new Set<string>();
  for (const h of blockHunks(renderBlocks(orig), renderBlocks(prevNorm))) {
    known.add(hunkKey(h.a, h.b));
    if (h.a.length === h.b.length) h.a.forEach((x, k) => known.add(hunkKey([x], [h.b[k]])));
  }
  const isKnown = (h: BlockHunk) =>
    known.has(hunkKey(h.a, h.b)) ||
    (h.a.length === h.b.length && h.a.every((x, k) => known.has(hunkKey([x], [h.b[k]]))));

  const nextLines = splitLines(nextNorm);
  const lines = [...patched.lines];
  const spans = [...patched.spans];
  /** [시작, 끝) 줄 범위를 N' 의 [시작, 끝) 줄로 바꾼다. 뒤쪽부터 바꿔야 앞쪽 줄 번호가 유지된다 */
  const replacements: Array<{ from: number; to: number; with: string[] }> = [];
  const replace = (a: RenderedBlock[], b: RenderedBlock[]) => {
    const withLines = nextLines.slice(b[0].range[0], b[b.length - 1].range[1]);
    replacements.push({ from: a[0].range[0], to: a[a.length - 1].range[1], with: withLines });
  };
  for (const h of hunks) {
    if (isKnown(h)) continue;
    // 블록이 한쪽에만 있는 경우는 바꿀 위치를 정할 수 없다
    if (h.a.length === 0 || h.b.length === 0) return undefined;
    if (h.a.length === h.b.length) {
      h.a.forEach((x, k) => {
        if (!known.has(hunkKey([x], [h.b[k]]))) replace([x], [h.b[k]]);
      });
    } else {
      replace(h.a, h.b);
    }
  }
  for (const r of replacements.sort((x, y) => y.from - x.from)) {
    lines.splice(r.from, r.to - r.from, ...r.with);
    spans.splice(r.from, r.to - r.from, ...r.with.map(wholeLine));
  }

  // 바꾼 뒤 남은 차이가 모두 원래 있던 것인지 다시 확인한다
  return blockHunks(renderBlocks(lines.join('\n')), target).every(isKnown) ? { lines, spans } : undefined;
}

function patchOriginal(
  orig: string,
  prevNorm: string,
  nextNorm: string,
): { lines: string[]; spans: Array<Span | undefined> } | undefined {
  try {
    const O = splitLines(orig);
    const N = splitLines(prevNorm);
    const N2 = splitLines(nextNorm);

    // 1) O ↔ N 정렬. 일치하는 줄은 1:1 그룹, 서로 대응하지 않는 줄 묶음(hunk)은 하나의 그룹
    const groups: Group[] = [];
    const groupOf: Group[] = new Array(N.length);
    let oi = 0;
    let nj = 0;
    let hunk: Group | undefined;
    for (const part of diffArrays(O, N, { comparator: (a, b) => looseLine(a) === looseLine(b) })) {
      const count = part.value.length;
      if (part.removed || part.added) {
        if (!hunk) groups.push((hunk = { idx: groups.length, orig: [], norm: [] }));
        if (part.removed) {
          hunk.orig.push(...O.slice(oi, oi + count));
          oi += count;
        } else {
          for (let k = 0; k < count; k++, nj++) {
            hunk.norm.push(nj);
            groupOf[nj] = hunk;
          }
        }
      } else {
        hunk = undefined;
        for (let k = 0; k < count; k++, oi++, nj++) {
          const g = { idx: groups.length, orig: [O[oi]], norm: [nj] };
          groups.push(g);
          groupOf[nj] = g;
        }
      }
    }

    // 2) N → N' 줄 diff. 지워진 줄 바로 뒤에 추가된 줄은 "그 줄을 고친 것"으로 짝지어 둔다
    const removed = new Set<number>();
    const ops: Array<{ kind: 'keep' | 'drop'; j: number } | { kind: 'add'; line: string; replaces?: number }> = [];
    let j = 0;
    let dropRun: number[] = [];
    for (const part of diffArrays(N, N2)) {
      if (part.added) {
        part.value.forEach((line, k) => ops.push({ kind: 'add', line, replaces: dropRun[k] }));
        dropRun = [];
        continue;
      }
      dropRun = [];
      for (let k = 0; k < part.value.length; k++) {
        if (part.removed) {
          removed.add(j);
          dropRun.push(j);
        }
        ops.push({ kind: part.removed ? 'drop' : 'keep', j: j++ });
      }
    }
    // 정규화본 줄이 하나라도 지워진 그룹은 원본 줄 대신 정규화본 줄을 쓴다
    const touched = new Set(groups.filter((g) => g.norm.some((n) => removed.has(n))));

    // 3) 출력 조립
    const out: string[] = [];
    /** 줄마다 에디터가 써 넣은 구간. 원본 줄은 undefined */
    const spans: Array<Span | undefined> = [];
    const push = (line: string, span: Span | undefined) => {
      out.push(line);
      spans.push(span);
    };
    const emitted = new Set<Group>();
    const emitGroup = (g: Group) => {
      if (!emitted.has(g)) {
        emitted.add(g);
        if (!touched.has(g)) g.orig.forEach((line) => push(line, undefined));
      }
    };
    let gi = 0;
    /** N 줄이 없는(원본에만 있는) 그룹을 포함해, 지정 그룹 이전의 그룹들을 순서대로 내보낸다 */
    const emitUntil = (target: Group | undefined) => {
      while (gi < groups.length && groups[gi] !== target) {
        if (groups[gi].norm.length === 0) emitGroup(groups[gi]);
        gi++;
      }
    };

    for (const op of ops) {
      if (op.kind === 'add') {
        // 원본 줄 하나를 고친 경우면 줄 안에서도 실제로 바뀐 부분만 반영한다
        const g = op.replaces !== undefined ? groupOf[op.replaces] : undefined;
        const merged =
          g && g.orig.length === 1 && g.norm.length === 1 ? mergeLine(g.orig[0], N[op.replaces!], op.line) : undefined;
        if (merged) push(merged.line, merged.span);
        else push(op.line, wholeLine(op.line));
        continue;
      }
      const g = groupOf[op.j];
      if (g.idx >= gi) emitUntil(g);
      if (touched.has(g)) {
        if (op.kind === 'keep') push(N[op.j], wholeLine(N[op.j]));
      } else {
        emitGroup(g);
      }
    }
    emitUntil(undefined);
    return { lines: out, spans };
  } catch {
    return undefined;
  }
}
