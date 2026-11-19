import MarkdownIt from 'markdown-it';
import { diffArrays } from 'diff';

type Token = ReturnType<MarkdownIt['parse']>[number];

/**
 * 렌더링된 Markdown 끼리의 diff.
 *
 * 1) 두 문서를 markdown-it 으로 파싱해 최상위 블록(문단, 헤딩, 리스트, 표, 코드블록 ...) 단위로 나눈다.
 * 2) 블록 원문을 키로 diffArrays 해서 블록을 정렬한다.
 * 3) 같은 종류의 블록이 바뀐 경우(modified) 렌더링된 HTML 을 단어 단위로 다시 diff 해서
 *    <ins>/<del> 로 표시한다.
 */

export type RowKind = 'equal' | 'added' | 'removed' | 'modified';

export interface DiffRow {
  kind: RowKind;
  /** 왼쪽(원본) 열 HTML. added 행은 빈 문자열 */
  left: string;
  /** 오른쪽(수정본) 열 HTML. removed 행은 빈 문자열 */
  right: string;
  /** 한 열로 합쳐 보여줄 HTML */
  inline: string;
  /** 수정본에서 이 블록의 줄 범위 [시작, 끝) — equal/added/modified */
  newRange?: [number, number];
  /** 수정본 블록 원문 — equal/added/modified */
  newSource?: string;
  /** 원본 블록 원문 — removed/modified (되돌리기용) */
  oldSource?: string;
  /** removed 행: 수정본에서 바로 앞 블록 (되돌릴 때 이 블록 뒤에 삽입). 없으면 문서 맨 앞 */
  prev?: { range: [number, number]; source: string };
}

export interface DiffResult {
  rows: DiffRow[];
  stats: { added: number; removed: number; modified: number };
}

interface Block {
  /** 비교용 키 (블록 원문) */
  key: string;
  /** 블록 종류. 같은 종류일 때만 단어 단위 diff 를 시도한다 */
  type: string;
  html: string;
  /** 블록 원문 (끝 공백 줄 제외) */
  source: string;
  /** 문서 내 줄 범위 [시작, 끝) */
  range?: [number, number];
}

const md = new MarkdownIt({ html: true, linkify: true, typographer: false });

function splitBlocks(source: string): Block[] {
  const env = {};
  const tokens = md.parse(source, env);
  const lines = source.split(/\r?\n/);
  const blocks: Block[] = [];

  let i = 0;
  while (i < tokens.length) {
    const start = i;
    const open = tokens[i];
    if (open.nesting === 1) {
      // 대응하는 닫는 토큰까지 하나의 블록
      let depth = 0;
      do {
        depth += tokens[i].nesting;
        i++;
      } while (depth > 0 && i < tokens.length);
    } else {
      i++;
    }
    const slice = tokens.slice(start, i);
    const html = renderSlice(slice, env);
    const source = open.map ? lines.slice(open.map[0], open.map[1]).join('\n').trimEnd() : '';
    blocks.push({
      key: open.map ? source : html,
      type: blockType(open),
      html,
      source,
      range: open.map ? [open.map[0], open.map[1]] : undefined,
    });
  }
  return blocks;
}

function renderSlice(slice: Token[], env: object): string {
  // 전체 문서의 env 를 그대로 넘겨 참조형 링크([text][ref]) 등이 블록 단위 렌더링에서도 해석되도록 한다
  return md.renderer.render(slice, md.options, env);
}

function blockType(token: Token): string {
  return `${token.type.replace(/_open$/, '')}:${token.tag}`;
}

// ---------------------------------------------------------------------------
// HTML 단어 단위 diff
// ---------------------------------------------------------------------------

const TOKEN_RE = /<[^>]*>|&[#a-zA-Z0-9]+;|[\p{L}\p{N}_]+|\s+|[\s\S]/gu;
/** 태그이지만 내용물로 취급할 것 (diff 시 ins/del 로 감싼다) */
const CONTENT_TAG_RE = /^<(img|input)\b/i;

function tokenizeHtml(html: string): string[] {
  return html.match(TOKEN_RE) ?? [];
}

function isTag(tok: string): boolean {
  return tok.startsWith('<') && tok.endsWith('>') && !CONTENT_TAG_RE.test(tok);
}

function isWord(tok: string): boolean {
  return !isTag(tok) && tok.trim().length > 0;
}

/** 태그는 그대로 두고 텍스트 덩어리만 감싼다 */
function wrapText(tokens: string[], wrapTag: 'ins' | 'del'): string {
  let out = '';
  let run = '';
  const flush = () => {
    if (!run) return;
    out += run.trim() ? `<${wrapTag}>${run}</${wrapTag}>` : run;
    run = '';
  };
  for (const tok of tokens) {
    if (isTag(tok)) {
      flush();
      out += tok;
    } else {
      run += tok;
    }
  }
  flush();
  return out;
}

/** 삭제/추가된 쪽의 태그는 버리고 텍스트만 남긴다 */
function textOnly(tokens: string[], wrapTag: 'ins' | 'del'): string {
  const text = tokens.filter((t) => !isTag(t)).join('');
  return text.trim() ? `<${wrapTag}>${text}</${wrapTag}>` : text;
}

interface HtmlDiff {
  left: string;
  right: string;
  inline: string;
  /** 단어 기준 유사도 (0 ~ 1) */
  similarity: number;
}

export function diffHtml(oldHtml: string, newHtml: string): HtmlDiff {
  const parts = diffArrays(tokenizeHtml(oldHtml), tokenizeHtml(newHtml));
  let left = '';
  let right = '';
  let inline = '';
  let same = 0;
  let total = 0;

  for (const part of parts) {
    const words = part.value.filter(isWord).length;
    if (part.added) {
      total += words;
      right += wrapText(part.value, 'ins');
      inline += wrapText(part.value, 'ins');
    } else if (part.removed) {
      total += words;
      left += wrapText(part.value, 'del');
      inline += textOnly(part.value, 'del');
    } else {
      same += words;
      total += words * 2;
      const html = part.value.join('');
      left += html;
      right += html;
      inline += html;
    }
  }
  return { left, right, inline, similarity: total === 0 ? 1 : (same * 2) / total };
}

// ---------------------------------------------------------------------------
// 블록 정렬
// ---------------------------------------------------------------------------

function canInlineDiff(a: Block, b: Block): boolean {
  return a.type === b.type;
}

const MIN_SIMILARITY = 0.35;

// ---------------------------------------------------------------------------
// 표: 행 단위 diff
// ---------------------------------------------------------------------------

const TR_RE = /<tr>[\s\S]*?<\/tr>/g;

function splitTable(html: string): { head: string[]; body: string[] } {
  const section = (tag: string) => html.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? '';
  return { head: section('thead').match(TR_RE) ?? [], body: section('tbody').match(TR_RE) ?? [] };
}

function attrEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const trClass = (tr: string, cls: string, data: Record<string, string> = {}) => {
  const attrs = Object.entries(data)
    .map(([k, v]) => ` ${k}="${attrEscape(v)}"`)
    .join('');
  return tr.replace(/^<tr>/, `<tr class="${cls}"${attrs}>`);
};

/**
 * 표를 행 단위로 정렬한다. 바뀐 행만 강조하고(tr-ins / tr-del / tr-mod), 수정된 행은 셀 안에서 단어 단위로 표시한다.
 * side-by-side 에서 좌우 행이 맞도록 반대쪽에는 빈 행(tr-empty)을 넣는다.
 * 렌더링 결과가 같은 행(이스케이프·패딩 차이만 있는 행)은 변경으로 보지 않는다.
 */
/**
 * 표 소스에서 본문 행에 해당하는 줄들. 머리글(1줄)과 구분선(1줄)을 건너뛴다.
 * markdown-it 의 본문 tr 순서는 소스 본문 줄 순서와 같으므로 인덱스로 짝지을 수 있다.
 */
function tableBodyLines(source?: string): string[] {
  if (!source) return [];
  const lines = source.split('\n');
  // 첫 줄: 머리글, 둘째 줄: |---|---| 구분선. 그 뒤가 본문 행
  return lines.slice(2).filter((l) => l.trim() !== '');
}

export function diffTable(
  oldHtml: string,
  newHtml: string,
  oldSource?: string,
  newSource?: string,
): { left: string; right: string; inline: string; changed: boolean } {
  const o = splitTable(oldHtml);
  const n = splitTable(newHtml);
  const oldLines = tableBodyLines(oldSource);
  const newLines = tableBodyLines(newSource);
  // 소스 줄 수와 렌더된 본문 행 수가 맞을 때만 행 단위 되돌리기 정보를 심는다 (안전장치)
  const mapOld = oldLines.length === o.body.length;
  const mapNew = newLines.length === n.body.length;
  const cols = Math.max(1, ((n.head[0] ?? o.head[0] ?? '').match(/<th\b/g) ?? []).length);
  const empty = `<tr class="tr-empty"><td colspan="${cols}"></td></tr>`;
  let changed = false;

  // 머리글
  let head = { left: n.head.join(''), right: n.head.join(''), inline: n.head.join('') };
  if (o.head.join('') !== n.head.join('')) {
    changed = true;
    const d = diffHtml(o.head.join(''), n.head.join(''));
    head = { left: trClass(d.left, 'tr-mod'), right: trClass(d.right, 'tr-mod'), inline: trClass(d.inline, 'tr-mod') };
  }

  const left: string[] = [];
  const right: string[] = [];
  const inline: string[] = [];

  // 본문 diff 를 순서대로 소비하며 각 tr 이 어느 소스 줄에서 왔는지 추적한다
  let oi = 0; // 원본 본문 줄 인덱스
  let ni = 0; // 수정본 본문 줄 인덱스
  /** 되돌릴 때 삭제된 행을 다시 넣을 위치: 바로 앞에 유지된(또는 수정된) 수정본 줄. 없으면 '' (본문 맨 앞) */
  let lastNewLine = '';

  const pushRemoved = (tr: string, oldLine?: string) => {
    const data: Record<string, string> =
      mapOld && oldLine !== undefined ? { 'data-revert': 'del', 'data-old-line': oldLine, 'data-after': lastNewLine } : {};
    left.push(trClass(tr, 'tr-del', data));
    right.push(empty);
    inline.push(trClass(tr, 'tr-del', data));
  };
  const pushAdded = (tr: string, newLine?: string) => {
    const data: Record<string, string> = mapNew && newLine !== undefined ? { 'data-revert': 'ins', 'data-new-line': newLine } : {};
    if (newLine !== undefined) lastNewLine = newLine;
    left.push(empty);
    right.push(trClass(tr, 'tr-ins', data));
    inline.push(trClass(tr, 'tr-ins', data));
  };

  let removedRun: Array<{ tr: string; line?: string }> = [];
  let addedRun: Array<{ tr: string; line?: string }> = [];
  const flush = () => {
    if (removedRun.length || addedRun.length) changed = true;
    const pairs = Math.min(removedRun.length, addedRun.length);
    for (let k = 0; k < pairs; k++) {
      const d = diffHtml(removedRun[k].tr, addedRun[k].tr);
      if (d.similarity >= MIN_SIMILARITY) {
        const data: Record<string, string> =
          mapOld && mapNew && removedRun[k].line !== undefined && addedRun[k].line !== undefined
            ? { 'data-revert': 'mod', 'data-old-line': removedRun[k].line!, 'data-new-line': addedRun[k].line! }
            : {};
        if (addedRun[k].line !== undefined) lastNewLine = addedRun[k].line!;
        left.push(trClass(d.left, 'tr-mod', data));
        right.push(trClass(d.right, 'tr-mod', data));
        inline.push(trClass(d.inline, 'tr-mod', data));
      } else {
        pushRemoved(removedRun[k].tr, removedRun[k].line);
        pushAdded(addedRun[k].tr, addedRun[k].line);
      }
    }
    removedRun.slice(pairs).forEach((r) => pushRemoved(r.tr, r.line));
    addedRun.slice(pairs).forEach((a) => pushAdded(a.tr, a.line));
    removedRun = [];
    addedRun = [];
  };

  for (const part of diffArrays(o.body, n.body)) {
    if (part.removed) {
      for (const tr of part.value) removedRun.push({ tr, line: mapOld ? oldLines[oi++] : undefined });
    } else if (part.added) {
      for (const tr of part.value) addedRun.push({ tr, line: mapNew ? newLines[ni++] : undefined });
    } else {
      flush();
      for (const tr of part.value) {
        const same = trClass(tr, 'tr-same');
        left.push(same);
        right.push(same);
        inline.push(same);
        if (mapNew) lastNewLine = newLines[ni];
        oi++;
        ni++;
      }
    }
  }
  flush();

  const table = (thead: string, rows: string[]) => `<table><thead>${thead}</thead><tbody>${rows.join('')}</tbody></table>`;
  return {
    left: table(head.left, left),
    right: table(head.right, right),
    inline: table(head.inline, inline),
    changed,
  };
}

/** 삭제된 블록들과 추가된 블록들 사이에서 같은 종류끼리 순서를 유지하며 최대한 짝을 짓는다 (LCS) */
function pairBlocks(removed: Block[], added: Block[]): Array<[number, number]> {
  const n = removed.length;
  const m = added.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = canInlineDiff(removed[i], added[j])
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (canInlineDiff(removed[i], added[j]) && dp[i][j] === dp[i + 1][j + 1] + 1) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      i++;
    } else {
      j++;
    }
  }
  return pairs;
}

/** 수정본 블록의 편집용 정보 */
const newInfo = (b: Block) => (b.range ? { newRange: b.range, newSource: b.source } : {});

function emitHunk(removed: Block[], added: Block[], rows: DiffRow[], stats: DiffResult['stats']): void {
  const removedRow = (b: Block): DiffRow => ({
    kind: 'removed',
    left: b.html,
    right: '',
    inline: b.html,
    oldSource: b.range ? b.source : undefined,
  });
  const addedRow = (b: Block): DiffRow => ({ kind: 'added', left: '', right: b.html, inline: b.html, ...newInfo(b) });

  let i = 0;
  let j = 0;
  const flushUntil = (pi: number, pj: number) => {
    for (; i < pi; i++) {
      rows.push(removedRow(removed[i]));
      stats.removed++;
    }
    for (; j < pj; j++) {
      rows.push(addedRow(added[j]));
      stats.added++;
    }
  };

  for (const [pi, pj] of pairBlocks(removed, added)) {
    flushUntil(pi, pj);
    const oldBlock = removed[pi];
    const newBlock = added[pj];
    const oldSource = oldBlock.range ? oldBlock.source : undefined;

    // 원문은 다르지만 렌더링 결과가 같으면(이스케이프, 리스트 기호, 표 패딩 등) 변경으로 보지 않는다
    if (oldBlock.html === newBlock.html) {
      rows.push({ kind: 'equal', left: newBlock.html, right: newBlock.html, inline: newBlock.html, ...newInfo(newBlock) });
    } else if (newBlock.type.startsWith('table')) {
      const t = diffTable(oldBlock.html, newBlock.html, oldBlock.source, newBlock.source);
      rows.push({ kind: t.changed ? 'modified' : 'equal', left: t.left, right: t.right, inline: t.inline, ...newInfo(newBlock), oldSource });
      if (t.changed) stats.modified++;
    } else {
      emitPair(oldBlock, newBlock);
    }
    i = pi + 1;
    j = pj + 1;
  }
  flushUntil(removed.length, added.length);

  function emitPair(oldBlock: Block, newBlock: Block) {
    const d = diffHtml(oldBlock.html, newBlock.html);
    if (d.similarity >= MIN_SIMILARITY) {
      rows.push({
        kind: 'modified',
        left: d.left,
        right: d.right,
        inline: d.inline,
        ...newInfo(newBlock),
        oldSource: oldBlock.range ? oldBlock.source : undefined,
      });
      stats.modified++;
    } else {
      rows.push(removedRow(oldBlock));
      rows.push(addedRow(newBlock));
      stats.removed++;
      stats.added++;
    }
  }
}

export function diffMarkdown(oldSource: string, newSource: string): DiffResult {
  const oldBlocks = splitBlocks(oldSource);
  const newBlocks = splitBlocks(newSource);
  const parts = diffArrays(oldBlocks, newBlocks, { comparator: (a, b) => a.key === b.key });

  const rows: DiffRow[] = [];
  const stats = { added: 0, removed: 0, modified: 0 };
  let pendingRemoved: Block[] = [];
  let pendingAdded: Block[] = [];

  const flush = () => {
    if (pendingRemoved.length || pendingAdded.length) {
      emitHunk(pendingRemoved, pendingAdded, rows, stats);
      pendingRemoved = [];
      pendingAdded = [];
    }
  };

  for (const part of parts) {
    if (part.removed) {
      pendingRemoved.push(...part.value);
    } else if (part.added) {
      pendingAdded.push(...part.value);
    } else {
      flush();
      // equal 파트는 newBlocks 쪽 값이 들어온다
      for (const b of part.value) {
        rows.push({ kind: 'equal', left: b.html, right: b.html, inline: b.html, ...newInfo(b) });
      }
    }
  }
  flush();

  // 삭제된 블록을 되돌릴 때 삽입할 위치(바로 앞의 수정본 블록)를 기록한다
  let prev: DiffRow['prev'];
  for (const row of rows) {
    if (row.kind === 'removed') row.prev = prev;
    else if (row.newRange && row.newSource !== undefined) prev = { range: row.newRange, source: row.newSource };
  }
  return { rows, stats };
}
