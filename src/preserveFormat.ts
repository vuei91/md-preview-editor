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

/** 참조형 링크 정의 (`[label]: url`). 문서 일부만 렌더링할 때 나머지 부분의 정의를 넘겨준다 */
export type References = Record<string, unknown>;

/** 문서에 있는 참조형 링크 정의 */
export function referencesOf(source: string): References {
  const env: { references?: References } = {};
  md.parse(source, env);
  return env.references ?? {};
}

function renderKey(source: string, references?: References, parser = md): string {
  // markdown-it 은 env 에 이미 있는 정의를 덮어쓰지 않으므로 그대로 넘기면 된다 (env 는 렌더링마다 새로)
  const env = references ? { references: { ...references } } : {};
  return parser.render(source, env).replace(/\s+/g, ' ').trim();
}

/** 서식 차이를 무시하고 줄을 비교하기 위한 느슨한 정규화 */
function looseLine(line: string): string {
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

const BULLET_RE = /^(\s*)([-*+])(\s+)/;

/** 새로 들어가는 리스트 줄은 주변 원본 리스트의 기호(`*`, `+`, `-`)를 따른다. 섞이면 별개의 리스트가 되기 때문 */
function adaptBullet(line: string, neighbors: string[]): string {
  const m = BULLET_RE.exec(line);
  if (!m) return line;
  for (const n of neighbors) {
    const nm = BULLET_RE.exec(n);
    if (nm && nm[1] === m[1]) return nm[2] === m[2] ? line : line.replace(BULLET_RE, `$1${nm[2]}$3`);
  }
  return line;
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
  const finish = (lines: string[], spans: Array<Span | undefined>) =>
    stripRedundantEscapes(lines, spans, references).join('\n') + (endsWithNewline ? '\n' : '');

  // 원본 패치 결과가 편집기 화면과 같게 그려지는지 편집기 기준으로 확인한다.
  // (블록만 넘어온 경우에도 편집기는 참조형 링크를 해석하지 않으므로 references 는 필요 없다)
  const patched = patchOriginal(orig, prevNorm, nextNorm);
  const toastKey = (s: string) => renderKey(s, undefined, toastLike);
  if (patched && toastKey(patched.lines.join('\n')) === toastKey(nextNorm)) {
    return finish(patched.lines, patched.spans);
  }
  // 안전장치: 정규화본 전체로 대체 (모든 줄이 에디터가 쓴 것)
  const all = splitLines(nextNorm);
  return finish(all, all.map(wholeLine));
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
        if (merged) {
          push(merged.line, merged.span);
        } else {
          const upcoming = groups.slice(gi, gi + 20).flatMap((x) => x.orig);
          const line = adaptBullet(op.line, [...out.slice(-20).reverse(), ...upcoming]);
          push(line, wholeLine(line));
        }
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
