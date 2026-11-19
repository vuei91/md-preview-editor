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

const md = new MarkdownIt({ html: true, linkify: true });

function renderKey(source: string): string {
  return md.render(source).replace(/\s+/g, ' ').trim();
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

/**
 * 한 줄 안에서의 3-way 병합.
 * orig: 원본 줄, norm: 정규화된 같은 줄, next: 편집 후 정규화된 줄.
 * norm → next 에서 바뀐 구간이 원본과 정규화본이 같은 영역(앞쪽 또는 뒤쪽) 안에 있으면
 * 원본 줄에서 그 구간만 바꾼다. 위치를 확정할 수 없으면 undefined.
 */
function mergeLine(orig: string, norm: string, next: string): string | undefined {
  if (orig === norm) return next;
  // 내용은 그대로이고 서식(이스케이프 등)만 달라졌다면 원본 줄을 유지한다
  if (looseLine(orig) === looseLine(next)) return orig;

  // norm 의 [p, norm.length - s) 가 next 에서 y 로 바뀌었다
  const p = commonPrefix(norm, next);
  const s = commonSuffix(norm, next, Math.min(norm.length, next.length) - p);
  const y = next.slice(p, next.length - s);

  // norm ↔ orig 를 글자 단위로 정렬해 바뀐 구간의 양 끝을 원본 위치로 옮긴다.
  // 양 끝이 둘 다 "같은 글자" 영역에 있어야 위치가 확정된다
  const start = mapPosition(norm, orig, p, 'start');
  const end = mapPosition(norm, orig, norm.length - s, 'end');
  if (start === undefined || end === undefined || start > end) return undefined;
  return orig.slice(0, start) + y + orig.slice(end);
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

export function applyNormalizedEdit(original: string, prevNorm: string, nextNorm: string): string {
  if (prevNorm === nextNorm) return original;

  const orig = original.replace(/\r\n/g, '\n');
  const endsWithNewline = orig.endsWith('\n');
  const withTrailingNewline = (s: string) => (endsWithNewline && !s.endsWith('\n') ? `${s}\n` : s);
  const fallback = withTrailingNewline(nextNorm);

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
    const emitted = new Set<Group>();
    const emitGroup = (g: Group) => {
      if (!emitted.has(g)) {
        emitted.add(g);
        if (!touched.has(g)) out.push(...g.orig);
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
        const upcoming = groups.slice(gi, gi + 20).flatMap((x) => x.orig);
        out.push(merged ?? adaptBullet(op.line, [...out.slice(-20).reverse(), ...upcoming]));
        continue;
      }
      const g = groupOf[op.j];
      if (g.idx >= gi) emitUntil(g);
      if (touched.has(g)) {
        if (op.kind === 'keep') out.push(N[op.j]);
      } else {
        emitGroup(g);
      }
    }
    emitUntil(undefined);

    const result = out.join('\n') + (endsWithNewline ? '\n' : '');
    if (renderKey(result) === renderKey(nextNorm)) return result;
  } catch {
    // 아래 fallback
  }
  return fallback;
}
