import Editor from '@toast-ui/editor';
import '@toast-ui/editor/dist/i18n/ko-kr';
import { measureColumns, planWidths } from './tableWidths';
import { setupSearch } from './search';

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): State | undefined;
  setState(state: State): void;
};

type View = 'inline' | 'sideBySide';
interface State {
  view?: View;
  changesOnly?: boolean;
}
interface BlockRef {
  range: [number, number];
  source: string;
}
interface Row {
  kind: 'equal' | 'added' | 'removed' | 'modified';
  left: string;
  right: string;
  inline: string;
  newRange?: [number, number];
  newSource?: string;
  oldSource?: string;
  prev?: BlockRef;
}
interface RenderMessage {
  type: 'render';
  rows: Row[];
  stats: { added: number; removed: number; modified: number };
  leftLabel: string;
  rightLabel: string;
  view: View;
  canOpenSource: boolean;
  editable: boolean;
  dirty: boolean;
  language: string;
  /** diff 화면에서 적용한 변경의 실행취소 / 다시실행 가능 여부 */
  history?: { canUndo: boolean; canRedo: boolean };
  /** 실행취소/다시실행으로 바뀐 줄 (0부터). 그 블록으로 스크롤해 보여준다 */
  focusLine?: number;
}

const vscode = acquireVsCodeApi();
const state: State = vscode.getState() ?? {};
let last: RenderMessage | undefined;
let changeIndex = -1;

/** 열려 있는 블록 편집기. 열려 있는 동안 들어온 render 는 보류했다가 닫을 때 반영한다 */
let editing: { index: number; editor: Editor; initial: string; cell: HTMLElement; applying: boolean } | undefined;
let pendingRender: RenderMessage | undefined;

/**
 * 편집을 열 블록. 앞 블록을 적용하는 동안 클릭하면 render 가 온 뒤에 연다.
 * 적용하면 줄 위치와 행 번호가 바뀌므로 블록 원문과 커서 앞 글자 수로 기억한다.
 */
interface OpenRequest {
  index: number;
  source: string;
  /** 클릭한 곳. 모르면 undefined */
  caret?: Caret;
}
/**
 * 렌더링된 글과 편집기의 글은 공백·줄바꿈이 달라서 공백을 뺀 글자 수로 위치를 옮긴다.
 * 단어 끝(…화면|)과 다음 단어 앞(|개선)은 글자 수가 같으므로 바로 앞이 공백이었는지로 가른다.
 */
interface Caret {
  chars: number;
  afterSpace: boolean;
}
let queuedOpen: OpenRequest | undefined;
/** mousedown 에서 기록한 클릭. mouseup 에서 끌지 않았으면 편집을 연다 */
let pressed: (OpenRequest & { x: number; y: number }) | undefined;

/** 실행취소 아이콘 (왼쪽으로 돌아가는 화살표). 다시실행은 CSS 로 좌우를 뒤집어 쓴다 */
const HISTORY_ICON =
  '<svg class="history-icon" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M5.5 3 2.5 6l3 3M2.8 6h6.7a3.5 3.5 0 0 1 0 7H7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

const app = document.getElementById('app')!;
app.innerHTML = `
  <div class="top">
  <header class="toolbar">
    <div class="labels">
      <span class="label label-left" title=""></span>
      <span class="arrow">→</span>
      <span class="label label-right" title=""></span>
    </div>
    <div class="stats"></div>
    <div class="actions">
      <span class="history">
        <button id="undo" class="icon-button" title="실행취소 (Ctrl+Z)" aria-label="실행취소" disabled>${HISTORY_ICON}</button>
        <button id="redo" class="icon-button" title="다시실행 (Ctrl+Shift+Z / Ctrl+Y)" aria-label="다시실행" disabled>${HISTORY_ICON}</button>
      </span>
      <span class="dirty" hidden>● 저장 안 됨 <button id="save" title="저장 (Ctrl+S)">저장</button></span>
      <button id="prev" title="이전 변경 (Shift+F7)">▲</button>
      <span class="nav-count"></span>
      <button id="next" title="다음 변경 (F7)">▼</button>
      <span class="seg">
        <button data-view="inline">Inline</button>
        <button data-view="sideBySide">Side by side</button>
      </span>
      <label class="check"><input type="checkbox" id="changesOnly"> 변경만 보기</label>
      <button id="openEditor" title="편집 가능한 미리보기를 옆에 열기">편집기 열기</button>
      <button id="openSource" title="원문 열기">원문</button>
    </div>
  </header>
  <div class="col-labels"><div class="label-left"></div><div class="col-gap"></div><div class="label-right"></div></div>
  <div class="notice" hidden></div>
  </div>
  <div class="main">
    <div class="scroller"><main id="content"></main></div>
    <div class="overview-ruler" title="변경 위치 (클릭하거나 끌어서 이동)"><div class="ruler-marks"></div><div class="ruler-slider"></div></div>
  </div>`;

const content = document.getElementById('content')!;
/** 본문 스크롤 영역. 머리글은 고정이고 이 안만 스크롤한다 */
const scroller = app.querySelector<HTMLElement>('.scroller')!;
const ruler = app.querySelector<HTMLElement>('.overview-ruler')!;
const rulerMarks = ruler.querySelector<HTMLElement>('.ruler-marks')!;
const rulerSlider = ruler.querySelector<HTMLElement>('.ruler-slider')!;
const notice = app.querySelector<HTMLElement>('.notice')!;
const $ = <T extends HTMLElement>(sel: string) => app.querySelector<T>(sel)!;

const isDark = () =>
  document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

function currentView(): View {
  return state.view ?? last?.view ?? 'inline';
}

function showNotice(message: string): void {
  notice.textContent = message;
  notice.hidden = false;
  window.setTimeout(() => (notice.hidden = true), 6000);
}

// ---------------------------------------------------------------------------
// 렌더링
// ---------------------------------------------------------------------------

/** 되돌리기 화살표 아이콘. 글꼴과 상관없이 같은 모양·크기로 그리고, 색은 버튼 글자색(currentColor)을 따른다 */
const ARROW_ICON =
  '<svg class="arrow-icon" viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M2.5 8h10M8.5 3.5 13 8l-4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>' +
  '</svg>';

/** 블록 되돌리기 화살표. 되돌릴 수 없는 블록이면 빈 문자열 */
function revertButton(row: Row, index: number): string {
  if (!last?.editable) return '';
  const canEdit = row.newRange && row.newSource !== undefined;
  const canRevert =
    (row.kind === 'modified' && canEdit && row.oldSource !== undefined) ||
    (row.kind === 'added' && canEdit) ||
    (row.kind === 'removed' && row.oldSource !== undefined);
  if (!canRevert) return '';
  // 수정된 표는 행 단위 화살표만 둔다. 되돌릴 행이 없으면(머리글만 바뀐 경우 등) 표 전체 화살표를 남긴다
  if (row.kind === 'modified' && /data-revert="/.test(row.inline + row.left + row.right)) return '';
  const title =
    row.kind === 'removed'
      ? '삭제된 블록을 다시 넣습니다 (수정 전으로 되돌리기)'
      : row.kind === 'added'
        ? '추가된 블록을 지웁니다 (수정 전으로 되돌리기)'
        : '이 블록을 수정 전 내용으로 되돌립니다';
  return `<button class="revert-arrow" data-act="revert" data-index="${index}" title="${title}" aria-label="수정 전으로 되돌리기">${ARROW_ICON}</button>`;
}

/** inline 보기: 화살표를 셀 오른쪽 가장자리에 둔다 (마우스를 올리면 보인다) */
function rowActions(row: Row, index: number): string {
  const button = revertButton(row, index);
  return button ? `<div class="row-actions">${button}</div>` : '';
}

/** 지금 화면에 그려져 있는 행들 (다시 그리기 전의 행을 찾을 때 쓴다) */
let renderedRows: Row[] = [];

/** 다시 그려도 보던 곳이 그대로 있도록 기억하는 기준: 화면 맨 위에 걸친 블록과 그 위치 */
interface ScrollAnchor {
  index: number;
  source?: string;
  offset: number;
}

const rowSource = (row: Row | undefined) => row?.newSource ?? row?.oldSource;

function captureScrollAnchor(): ScrollAnchor | undefined {
  const top = scroller.getBoundingClientRect().top;
  for (const el of Array.from(content.querySelectorAll<HTMLElement>('.row'))) {
    if (el.offsetParent === null) continue;
    const r = el.getBoundingClientRect();
    if (r.bottom <= top) continue;
    const index = Number(el.dataset.index);
    return { index, source: rowSource(renderedRows[index]), offset: r.top - top };
  }
  return undefined;
}

/**
 * 기준 블록이 다시 같은 높이에 오도록 스크롤을 맞춘다.
 * 위쪽 블록이 생기거나 없어져 행 번호가 밀리므로, 원문이 같은 행 중 가장 가까운 것을 찾는다
 */
function restoreScrollAnchor(anchor: ScrollAnchor | undefined): void {
  if (!anchor || !last) return;
  let index = anchor.index;
  if (anchor.source !== undefined) {
    let best = -1;
    last.rows.forEach((row, k) => {
      if (rowSource(row) === anchor.source && (best < 0 || Math.abs(k - anchor.index) < Math.abs(best - anchor.index))) best = k;
    });
    if (best >= 0) index = best;
  }
  const el = content.querySelector<HTMLElement>(`.row[data-index="${index}"]`);
  if (!el || el.offsetParent === null) return;
  const delta = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - anchor.offset;
  if (Math.abs(delta) >= 1) scroller.scrollTop += delta;
}

function render(): void {
  if (!last) return;
  const view = currentView();
  document.body.dataset.view = view;
  document.body.classList.toggle('changes-only', !!state.changesOnly);
  ($('#changesOnly') as HTMLInputElement).checked = !!state.changesOnly;
  app.querySelectorAll<HTMLButtonElement>('.seg button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  app.querySelectorAll('.label-left').forEach((e) => ((e.textContent = last!.leftLabel), e.setAttribute('title', last!.leftLabel)));
  app.querySelectorAll('.label-right').forEach((e) => ((e.textContent = last!.rightLabel), e.setAttribute('title', last!.rightLabel)));
  $('#openSource').hidden = !last.canOpenSource;
  $('#openEditor').hidden = !last.editable;
  $('.dirty').hidden = !last.dirty;
  updateHistoryButtons(last);

  const { added, removed, modified } = last.stats;
  $('.stats').innerHTML =
    added + removed + modified === 0
      ? '<span class="same">변경 사항 없음</span>'
      : [
          added && `<span class="s-add" title="추가된 블록">+${added}</span>`,
          removed && `<span class="s-del" title="삭제된 블록">−${removed}</span>`,
          modified && `<span class="s-mod" title="수정된 블록">~${modified}</span>`,
        ]
          .filter(Boolean)
          .join(' ') + ' 블록';

  const html: string[] = [];
  let prevKind: Row['kind'] = 'equal';
  last.rows.forEach((row, index) => {
    // 연속된 변경 블록 중 첫 번째에 표시해서 이전/다음 이동 단위로 쓴다
    const start = row.kind !== 'equal' && prevKind === 'equal' ? ' change-start' : '';
    prevKind = row.kind;
    const editable = !!(last!.editable && row.newRange);
    const editableCls = editable ? ' editable' : '';
    const editTitle = editable ? ' title="더블클릭하여 편집"' : '';
    if (view === 'inline') {
      html.push(
        `<div class="row row-${row.kind}${start}" data-index="${index}">` +
          `<div class="cell md inline${editableCls}"${editTitle} data-side="inline">${rowActions(row, index)}${row.inline}</div></div>`,
      );
    } else {
      const cell = (side: 'left' | 'right', body: string) =>
        `<div class="cell md ${side}${body ? '' : ' empty'}${side === 'right' ? editableCls : ''}"` +
        `${side === 'right' ? editTitle : ''} data-side="${side}">${body}</div>`;
      // 수정 전·후 사이의 가운데 열에 되돌리기 화살표를 둔다. 위치는 layoutGutters 가 맞춘다
      const gutter = `<div class="gutter">${revertButton(row, index)}</div>`;
      html.push(
        `<div class="row row-${row.kind}${start}" data-index="${index}">${cell('left', row.left)}${gutter}${cell('right', row.right)}</div>`,
      );
    }
  });
  if (last.rows.length === 0) html.push('<div class="empty-doc">두 문서 모두 비어 있습니다.</div>');
  // 실시간 갱신으로 다시 그려도 표의 가로 스크롤 위치를 유지한다
  const scrollByRow = new Map<string, number>();
  content.querySelectorAll<HTMLElement>('.row').forEach((row) => {
    const wrap = row.querySelector<HTMLElement>('.table-wrap');
    if (wrap?.scrollLeft) scrollByRow.set(row.dataset.index!, wrap.scrollLeft);
  });

  const anchor = captureScrollAnchor();
  content.innerHTML = html.join('');
  renderedRows = last.rows;
  wrapTables();
  markChangedLines();
  if (last.editable) addRowRevertArrows();
  changeIndex = -1;
  alignTables();
  scrollByRow.forEach((left, index) => {
    content.querySelectorAll<HTMLElement>(`.row[data-index="${index}"] .table-wrap`).forEach((w) => (w.scrollLeft = left));
  });
  restoreScrollAnchor(anchor);
  layoutGutters();
  updateRuler();
  updateNavCount();
}

/** 넓은 표는 표 자체가 아니라 감싼 div 에서 가로 스크롤한다 (좌우 열 폭을 맞추려면 표가 display: table 이어야 한다) */
function wrapTables(): void {
  content.querySelectorAll<HTMLTableElement>('.cell.md table').forEach((table) => {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    table.replaceWith(wrap);
    wrap.appendChild(table);
  });
}

/** 수정된 블록 안에서 바뀐 단어가 있는 줄(문단, 리스트 항목, 제목 …)을 표시해 연한 배경으로 칠한다. 표는 행 단위(tr-mod)로 칠한다 */
const LINE_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, pre, dt, dd';
function markChangedLines(): void {
  content.querySelectorAll<HTMLElement>('.row-modified ins, .row-modified del').forEach((el) => {
    if (el.closest('table')) return;
    el.closest(LINE_SELECTOR)?.classList.add('line-changed');
  });
  // side-by-side: 한쪽에만 추가(또는 삭제)가 있는 줄도 반대쪽의 같은 줄을 함께 칠한다.
  // 수정된 블록은 좌우 HTML 구조가 같으므로 줄 순서로 짝을 짓는다 (줄 수가 다르면 짝짓지 않는다)
  content.querySelectorAll<HTMLElement>('.row-modified').forEach((row) => {
    const lines = (side: string) =>
      Array.from(row.querySelectorAll<HTMLElement>(`.cell.${side} :is(${LINE_SELECTOR})`)).filter((e) => !e.closest('table'));
    const l = lines('left');
    const r = lines('right');
    if (l.length === 0 || l.length !== r.length) return;
    l.forEach((line, k) => {
      if (line.classList.contains('line-changed') || r[k].classList.contains('line-changed')) {
        line.classList.add('line-changed');
        r[k].classList.add('line-changed');
      }
    });
  });
}

/** 표 행 화살표 → 그 화살표가 되돌릴 표 행 */
const arrowTarget = new WeakMap<HTMLElement, HTMLElement>();

/**
 * 바뀐 표 행(tr-ins / tr-del / tr-mod)에 "수정 전으로 되돌리기" 화살표를 붙인다.
 * 표 행은 소스의 `| ... |` 한 줄과 1:1 로 대응하므로 줄 단위 되돌리기가 안전하다.
 * side-by-side 에서는 수정 전·후 사이의 가운데 열에, inline 에서는 셀 오른쪽 가장자리에 둔다.
 */
function addRowRevertArrows(): void {
  const rows = last?.rows ?? [];
  const sideBySide = currentView() === 'sideBySide';
  content.querySelectorAll<HTMLElement>('tr[data-revert]').forEach((tr) => {
    // side-by-side 는 좌우에 같은 행이 있으므로 하나만 쓴다: 원본(왼쪽) 행, 추가된 행(ins)은 왼쪽이 빈 행이므로 오른쪽 행.
    // inline 에서는 삭제 행(del)과 수정/추가 행이 각각 한 번씩만 나오므로 그대로 둔다
    if (sideBySide) {
      const inLeft = !!tr.closest('.cell.left');
      if (tr.dataset.revert === 'ins' ? inLeft : !inLeft) return;
    }
    const rowEl = tr.closest<HTMLElement>('.row');
    const index = Number(rowEl?.dataset.index);
    if (!rows[index]?.newRange || rows[index]?.newSource === undefined) return;

    const btn = document.createElement('button');
    btn.className = 'row-revert-arrow';
    btn.innerHTML = ARROW_ICON;
    // 행 종류(ins / del / mod)에 따라 화살표 색을 바꾼다
    btn.dataset.kind = tr.dataset.revert;
    btn.title = '이 행을 수정 전 내용으로 되돌립니다';
    btn.setAttribute('aria-label', '이 행을 수정 전으로 되돌리기');
    btn.dataset.rowRevert = String(index);
    // side-by-side 는 가운데 열에, inline 은 셀 오른쪽 가장자리(블록 화살표와 같은 세로줄)에 두고 layoutGutters 가 행 높이에 맞춘다.
    // 표 첫 열 안에 넣으면 글을 가리고 표가 가로 스크롤되면 같이 밀려난다
    const holder = rowEl!.querySelector<HTMLElement>(sideBySide ? ':scope > .gutter' : ':scope > .cell.inline');
    if (!holder) return;
    arrowTarget.set(btn, tr);
    holder.appendChild(btn);
  });
}

/** 블록 화살표를 맞출 곳: 블록의 첫 줄 (글이 없으면 첫 요소) */
function firstLineRect(cell: HTMLElement): DOMRect | undefined {
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.textContent?.trim() || n.parentElement?.closest('.row-actions, button')) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const rect = Array.from(range.getClientRects()).find((r) => r.height > 0);
    if (rect) return rect;
  }
  const first = Array.from(cell.children).find((e) => !e.matches('style, .row-actions'));
  return first?.getBoundingClientRect();
}

/**
 * 되돌리기 화살표(side-by-side 가운데 열, inline 셀 오른쪽 가장자리)를 가리키는 줄 높이에 맞춘다.
 * 블록 화살표는 블록의 첫 줄에, 표 행 화살표는 그 행의 가운데에 둔다.
 * 높이가 바뀔 때마다(표 맞춤, 편집기 열기/닫기, 이미지 로딩, 창 크기) 다시 부른다.
 */
function layoutGutters(): void {
  /** 숨겨져 있어(inline 은 마우스를 올려야 보인다) 크기를 잴 수 없을 때 쓰는 화살표 높이. diff.css 의 --arrow-size / --row-arrow-size */
  const arrowHeight = (btn: HTMLElement) => btn.offsetHeight || (btn.classList.contains('row-revert-arrow') ? 22 : 26);
  const place = (base: number, btn: HTMLElement, rect: DOMRect | undefined) => {
    btn.style.visibility = rect ? '' : 'hidden';
    if (!rect) return;
    const h = arrowHeight(btn);
    btn.style.top = `${Math.max(0, Math.round(rect.top - base + rect.height / 2 - h / 2))}px`;
  };
  const placeRowArrows = (holder: HTMLElement, base: number) =>
    holder.querySelectorAll<HTMLElement>(':scope > .row-revert-arrow').forEach((btn) => {
      const tr = arrowTarget.get(btn);
      // 편집기를 열어 표가 다시 그려지면 원래 행이 사라진다
      place(base, btn, tr?.isConnected && tr.offsetParent !== null ? tr.getBoundingClientRect() : undefined);
    });

  content.querySelectorAll<HTMLElement>('.row > .gutter').forEach((gutter) => {
    const base = gutter.getBoundingClientRect().top;
    placeRowArrows(gutter, base);
    const block = gutter.querySelector<HTMLElement>(':scope > .revert-arrow');
    if (block) {
      const row = gutter.parentElement!;
      const cell = row.querySelector<HTMLElement>(row.classList.contains('row-added') ? ':scope > .cell.right' : ':scope > .cell.left');
      place(base, block, cell ? firstLineRect(cell) : undefined);
    }
  });
  content.querySelectorAll<HTMLElement>('.row > .cell.inline:not(.editing)').forEach((cell) => {
    const base = cell.getBoundingClientRect().top;
    placeRowArrows(cell, base);
    const actions = cell.querySelector<HTMLElement>(':scope > .row-actions');
    if (actions) place(base, actions, firstLineRect(cell));
  });
}

/** 표 행 하나를 수정 전 소스 줄로 되돌린다. 블록 전체 소스를 줄 단위로 재구성해 editBlock 으로 적용한다 */
function revertTableRow(tr: HTMLElement, index: number): void {
  const row = last?.rows[index];
  if (!row || !row.newRange || row.newSource === undefined) return;
  const kind = tr.dataset.revert;
  const oldLine = tr.dataset.oldLine;
  const newLine = tr.dataset.newLine;

  const lines = row.newSource.split('\n');
  // 본문은 머리글(0)·구분선(1) 다음부터
  const headerEnd = 2;
  const body = lines.slice(headerEnd);
  let newBody: string[];

  if (kind === 'ins' && newLine !== undefined) {
    // 추가된 행 제거
    const at = body.indexOf(newLine);
    if (at < 0) return;
    newBody = [...body.slice(0, at), ...body.slice(at + 1)];
  } else if (kind === 'mod' && newLine !== undefined && oldLine !== undefined) {
    // 수정된 행을 원본 줄로 교체
    const at = body.indexOf(newLine);
    if (at < 0) return;
    newBody = [...body.slice(0, at), oldLine, ...body.slice(at + 1)];
  } else if (kind === 'del' && oldLine !== undefined) {
    // 삭제된 행을 다시 넣는다. data-after(앞의 수정본 줄) 다음에 삽입, 없으면 본문 맨 앞
    const after = tr.dataset.after ?? '';
    const at = after === '' ? -1 : body.indexOf(after);
    newBody = at < 0 ? [oldLine, ...body] : [...body.slice(0, at + 1), oldLine, ...body.slice(at + 1)];
  } else {
    return;
  }

  const nextSource = [...lines.slice(0, headerEnd), ...newBody].join('\n');
  if (nextSource === row.newSource) return;
  vscode.postMessage({
    type: 'editBlock',
    block: { range: row.newRange, source: row.newSource },
    prevNorm: row.newSource,
    nextNorm: nextSource,
  });
}

/** side-by-side 에서 짝이 되는 반대쪽 표 스크롤 영역 */
const scrollPartner = new WeakMap<HTMLElement, HTMLElement>();

function firstRowCells(table: HTMLTableElement): HTMLElement[] {
  const tr = table.querySelector('tr');
  return tr ? Array.from(tr.children as HTMLCollectionOf<HTMLElement>) : [];
}

/** 열 폭을 정해서 표에 적용한다 (table-layout: fixed 는 첫 행의 폭을 쓴다) */
function applyWidths(table: HTMLTableElement, widths: number[]): void {
  table.style.tableLayout = 'fixed';
  table.style.width = `${widths.reduce((a, b) => a + b, 0)}px`;
  firstRowCells(table).forEach((c, k) => (c.style.width = `${widths[k]}px`));
}

function resetTable(table: HTMLTableElement): void {
  table.style.tableLayout = '';
  table.style.width = '';
  firstRowCells(table).forEach((c) => (c.style.width = ''));
  table.querySelectorAll<HTMLTableRowElement>('tr').forEach((tr) => (tr.style.height = ''));
}

/** 표 하나(또는 좌우 짝)의 열 폭을 내용에 맞게 정한다. 열 수가 다르면 각자 정한다 */
/**
 * 열 폭을 정한다. 줄 수 추정은 근사치라서, 실제로 적용해 봤을 때 기준 배치보다 표가 높아지면 기준 배치를 쓴다.
 * 기준: 표 하나면 브라우저 기본 배치, 좌우 짝이면 양쪽 기본 폭의 평균(좌우 열 위치를 맞추기 위해).
 */
function fitColumns(tables: HTMLTableElement[], available: number): void {
  // 브라우저 기본 배치(맞춤을 푼 상태)의 열 폭을 시작점으로 쓴다
  const natural = tables.map((t) => firstRowCells(t).map((c) => c.getBoundingClientRect().width));
  const height = (ts: HTMLTableElement[]) => ts.reduce((a, t) => a + t.getBoundingClientRect().height, 0);
  const together = tables.length > 1 ? measureColumns(tables) : undefined;
  if (together) {
    const baseline = natural[0].map((_, c) => Math.round(natural.reduce((a, ws) => a + ws[c], 0) / natural.length));
    tables.forEach((t) => applyWidths(t, baseline));
    const baseHeight = height(tables);
    const widths = planWidths(together, available, baseline);
    tables.forEach((t) => applyWidths(t, widths));
    if (height(tables) > baseHeight + 1) tables.forEach((t) => applyWidths(t, baseline));
    return;
  }
  tables.forEach((t, k) => {
    const stats = measureColumns([t]);
    if (!stats) return;
    const baseHeight = height([t]);
    applyWidths(t, planWidths(stats, available, natural[k]));
    if (height([t]) > baseHeight + 1) resetTable(t);
  });
}

/** 표 테두리(border-collapse)가 1px 더 그려지므로 여유를 둔다 */
const contentWidth = (wrap: HTMLElement) => wrap.clientWidth - 2;

/**
 * 표 열 폭을 내용에 맞게 정한다. 짧은 열은 한 줄 폭 그대로, 긴 열은 글 양에 비례해 넓게.
 * side-by-side 에서는 추가로
 * 1) 좌우 표의 열 폭을 같게 해서 같은 열이 같은 가로 위치에 오도록 하고 (가로 스크롤 동기화의 전제)
 * 2) 행 높이를 같게 한다. 표 diff 는 좌우 행 수가 항상 같다(삭제 행 ↔ 빈 행, 빈 행 ↔ 추가 행).
 */
function alignTables(): void {
  if (currentView() !== 'sideBySide') {
    content.querySelectorAll<HTMLElement>('.table-wrap').forEach((wrap) => {
      const table = wrap.querySelector('table')!;
      resetTable(table);
      fitColumns([table], contentWidth(wrap));
    });
    return;
  }
  content.querySelectorAll<HTMLElement>('.row').forEach((row) => {
    const lw = row.querySelector<HTMLElement>('.cell.left .table-wrap');
    const rw = row.querySelector<HTMLElement>('.cell.right .table-wrap');
    if (!lw || !rw) {
      // 추가/삭제된 표: 한쪽에만 있다
      for (const wrap of [lw, rw]) {
        if (!wrap) continue;
        const table = wrap.querySelector('table')!;
        resetTable(table);
        fitColumns([table], contentWidth(wrap));
      }
      return;
    }
    scrollPartner.set(lw, rw);
    scrollPartner.set(rw, lw);
    const left = lw.querySelector('table')!;
    const right = rw.querySelector('table')!;
    // 맞춤을 푸는 동안 표가 줄어 스크롤 위치가 잘리므로 미리 기억해 둔다
    const scrollLeft = lw.scrollLeft;

    resetTable(left);
    resetTable(right);
    fitColumns([left, right], Math.min(contentWidth(lw), contentWidth(rw)));

    const l = Array.from(left.querySelectorAll<HTMLTableRowElement>('tr'));
    const r = Array.from(right.querySelectorAll<HTMLTableRowElement>('tr'));
    if (l.length === r.length) {
      // 수정된 행은 한쪽에만 ins/del 이 있어도(삭제만, 추가만) 좌우 같은 셀을 함께 강조한다
      l.forEach((tr, k) => {
        if (!tr.classList.contains('tr-mod')) return;
        const a = Array.from(tr.children);
        const b = Array.from(r[k].children);
        a.forEach((cell, c) => {
          if (cell.querySelector('ins, del') || b[c]?.querySelector('ins, del')) {
            cell.classList.add('cell-changed');
            b[c]?.classList.add('cell-changed');
          }
        });
      });
      const heights = l.map((tr, k) => Math.max(tr.getBoundingClientRect().height, r[k].getBoundingClientRect().height));
      l.forEach((tr, k) => {
        tr.style.height = `${heights[k]}px`;
        r[k].style.height = `${heights[k]}px`;
      });
    }
    lw.scrollLeft = scrollLeft;
    rw.scrollLeft = scrollLeft;
  });
}

/**
 * 한쪽 표를 가로 스크롤하면 반대쪽도 같이 움직인다.
 * 반대쪽에 값을 넣으면 그쪽에서도 scroll 이벤트가 오므로, 넣은 값 그대로면 무시해서 되먹임을 막는다.
 */
const driven = new WeakMap<HTMLElement, number>();
content.addEventListener(
  'scroll',
  (e) => {
    const el = e.target as HTMLElement;
    if (!el.classList?.contains('table-wrap')) return;
    if (driven.get(el) === el.scrollLeft) {
      driven.delete(el);
      return;
    }
    const partner = scrollPartner.get(el);
    if (!partner || partner.scrollLeft === el.scrollLeft) return;
    partner.scrollLeft = el.scrollLeft;
    driven.set(partner, partner.scrollLeft);
  },
  true,
);

let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    alignTables();
    scheduleLayout();
  }, 100);
  scheduleLayout();
});

// ---------------------------------------------------------------------------
// 오른쪽 overview ruler: 문서 전체에서 바뀐 곳의 위치를 스크롤바 옆에 표시한다
// ---------------------------------------------------------------------------

type MarkKind = 'add' | 'del' | 'mod';

/** 표시할 변경: 추가/삭제된 블록은 블록 전체, 수정된 블록은 바뀐 줄·표 행만 (없으면 블록 전체) */
function rulerTargets(): { el: HTMLElement; kind: MarkKind }[] {
  const out: { el: HTMLElement; kind: MarkKind }[] = [];
  content.querySelectorAll<HTMLElement>('.row-added, .row-removed, .row-modified').forEach((row) => {
    if (row.offsetParent === null) return;
    if (!row.classList.contains('row-modified')) {
      out.push({ el: row, kind: row.classList.contains('row-added') ? 'add' : 'del' });
      return;
    }
    const parts = Array.from(row.querySelectorAll<HTMLElement>('.line-changed, tr.tr-ins, tr.tr-del, tr.tr-mod')).filter(
      (e) => e.offsetParent !== null,
    );
    if (parts.length === 0) out.push({ el: row, kind: 'mod' });
    parts.forEach((el) => out.push({ el, kind: el.matches('.tr-ins') ? 'add' : el.matches('.tr-del') ? 'del' : 'mod' }));
  });
  return out;
}

function updateRuler(): void {
  // 좌우 열 제목을 본문 열과 맞추려고, 본문 오른쪽의 스크롤바 + 표시줄 폭을 알려 준다
  app.style.setProperty('--scroll-gutter', `${scroller.offsetWidth - scroller.clientWidth + ruler.offsetWidth}px`);
  const height = ruler.clientHeight;
  const docHeight = scroller.scrollHeight;
  const base = scroller.getBoundingClientRect().top - scroller.scrollTop;
  const marks = rulerTargets().map(({ el, kind }) => {
    const r = el.getBoundingClientRect();
    const top = ((r.top - base) / docHeight) * height;
    const h = Math.max(2, (r.height / docHeight) * height);
    return `<div class="mark mark-${kind}" style="top:${top.toFixed(1)}px;height:${h.toFixed(1)}px"></div>`;
  });
  rulerMarks.innerHTML = marks.join('');
  updateRulerSlider();
}

/** 지금 보이는 영역 */
function updateRulerSlider(): void {
  const height = ruler.clientHeight;
  const docHeight = scroller.scrollHeight;
  const view = scroller.clientHeight;
  rulerSlider.hidden = docHeight <= view + 1;
  rulerSlider.style.top = `${((scroller.scrollTop / docHeight) * height).toFixed(1)}px`;
  rulerSlider.style.height = `${Math.max(8, (view / docHeight) * height).toFixed(1)}px`;
}

/** ruler 의 y 위치에 해당하는 곳이 화면 가운데에 오도록 스크롤한다 */
function scrollToRuler(clientY: number): void {
  const r = ruler.getBoundingClientRect();
  const ratio = Math.min(1, Math.max(0, (clientY - r.top) / r.height));
  scroller.scrollTo({ top: ratio * scroller.scrollHeight - scroller.clientHeight / 2 });
}

let rulerDragging = false;
ruler.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  // 기본 동작을 막으면 mousedown 이 오지 않아 편집 중인 블록이 그대로 열려 있다 (스크롤만 한다)
  e.preventDefault();
  rulerDragging = true;
  ruler.setPointerCapture(e.pointerId);
  scrollToRuler(e.clientY);
});
ruler.addEventListener('pointermove', (e) => {
  if (rulerDragging) scrollToRuler(e.clientY);
});
const stopRulerDrag = () => (rulerDragging = false);
ruler.addEventListener('pointerup', stopRulerDrag);
ruler.addEventListener('pointercancel', stopRulerDrag);
scroller.addEventListener('scroll', updateRulerSlider, { passive: true });

/** 높이가 바뀌면(편집기 열기/닫기, 이미지 로딩, 창 크기) 가운데 화살표와 ruler 를 다시 맞춘다 */
let layoutFrame = 0;
function scheduleLayout(): void {
  if (layoutFrame) return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = 0;
    layoutGutters();
    updateRuler();
  });
}
// 본문 높이(편집기, 이미지 로딩)와 보이는 영역 크기(머리글 줄바꿈, 알림 표시)가 바뀔 때
const layoutObserver = new ResizeObserver(scheduleLayout);
layoutObserver.observe(content);
layoutObserver.observe(scroller);

function updateHistoryButtons(msg: RenderMessage): void {
  $('.history').hidden = !msg.editable;
  ($('#undo') as HTMLButtonElement).disabled = !msg.history?.canUndo;
  ($('#redo') as HTMLButtonElement).disabled = !msg.history?.canRedo;
}

/** 실행취소/다시실행 요청. 편집 중인 블록이 있으면 확장이 앞의 메시지부터 차례로 처리한다 */
function stepHistory(kind: 'undo' | 'redo'): void {
  if (!last?.editable) return;
  vscode.postMessage({ type: kind });
}

/** 본문 스크롤 영역에서 el 이 (일부라도) 보이는지 */
function isInView(el: HTMLElement): boolean {
  const view = scroller.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return r.bottom > view.top && r.top < view.bottom;
}

/**
 * 실행취소/다시실행으로 바뀐 블록을 깜빡여 보여준다.
 * 화면을 함부로 옮기지 않도록, 그 블록이 화면 밖에 있을 때만 (애니메이션 없이) 가운데로 스크롤한다
 */
function focusChangedLine(line: number): void {
  const rows = last?.rows ?? [];
  let index = rows.findIndex((r) => r.newRange && r.newRange[0] <= line && line < r.newRange[1]);
  if (index < 0) {
    index = rows.findIndex((r) => r.newRange && r.newRange[0] >= line);
    // 다시 삭제된 블록은 수정본에 줄이 없어서 바로 뒤 블록이 걸린다. 그 앞의 삭제 블록을 가리킨다
    if (index > 0 && rows[index - 1].kind === 'removed') index--;
  }
  if (index < 0) index = rows.length - 1;
  const el = content.querySelector<HTMLElement>(`.row[data-index="${index}"]`);
  if (!el || el.offsetParent === null) return;
  if (!isInView(el)) el.scrollIntoView({ block: 'center' });
  flash(el);
}

function onRenderMessage(msg: RenderMessage): void {
  if (editing && !editing.applying) {
    // 편집 중에는 화면을 갈아엎지 않는다. 저장 표시만 갱신
    pendingRender = msg;
    $('.dirty').hidden = !msg.dirty;
    updateHistoryButtons(msg);
    return;
  }
  closeEditor();
  last = msg;
  pendingRender = undefined;
  render();
  if (msg.focusLine !== undefined) focusChangedLine(msg.focusLine);
  if (queuedOpen) {
    const req = queuedOpen;
    queuedOpen = undefined;
    openEditor(req);
  }
}

// ---------------------------------------------------------------------------
// 블록 편집
// ---------------------------------------------------------------------------

function isEditorDirty(): boolean {
  return !!editing && editing.editor.getMarkdown() !== editing.initial;
}

function closeEditor(): void {
  if (!editing) return;
  editing.editor.destroy();
  editing = undefined;
  document.body.classList.remove('block-editing');
}

const nonSpace = (text: string) => text.replace(/\s/g, '').length;
/** 편집기를 연 뒤 커서를 옮기기까지 기다리는 시간(ms). openEditor 참고 */
const CARET_DELAY = 40;

/** (x, y) 의 위치. 공백, 삭제 표시(del), 버튼 글자는 세지 않는다 */
function caretAt(cell: HTMLElement, x: number, y: number): Caret | undefined {
  const caret = document.caretRangeFromPoint?.(x, y);
  if (!caret || !cell.contains(caret.startContainer)) return undefined;
  const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let chars = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const skip = !!n.parentElement?.closest('del, .row-actions, button');
    const text = n.textContent ?? '';
    if (n === caret.startContainer) {
      if (skip) return { chars, afterSpace: true };
      const before = text.slice(0, caret.startOffset);
      return { chars: chars + nonSpace(before), afterSpace: before === '' || /\s$/.test(before) };
    }
    if (!skip) chars += nonSpace(text);
  }
  return undefined;
}

/**
 * 편집기에서 같은 위치에 커서를 놓는다: chars 번째 글자 바로 뒤, 앞이 공백이었으면 그 다음 글자 바로 앞.
 * DOM 선택 영역을 옮기면 ProseMirror 가 selectionchange 로 읽어 간다 (내부 API 를 쓰지 않는다).
 */
function placeCaret(root: HTMLElement, { chars, afterSpace }: Caret): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let target: [Text, number] | undefined;
  let lastText: Text | undefined;
  let seen = 0;
  for (let n = walker.nextNode() as Text | null; n && !target; n = walker.nextNode() as Text | null) {
    if (n.parentElement?.closest('[contenteditable="false"]')) continue;
    lastText = n;
    for (let i = 0; i < n.data.length && !target; i++) {
      if (/\s/.test(n.data[i])) continue;
      if (afterSpace && seen === chars) target = [n, i];
      else if (!afterSpace && ++seen === chars) target = [n, i + 1];
      else if (afterSpace) seen++;
    }
  }
  if (!target && lastText) target = [lastText, lastText.length];
  if (!target) return;
  const range = document.createRange();
  range.setStart(...target);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
  const r = range.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  if (r.top < view.top || r.bottom > view.bottom || r.left < view.left || r.right > view.right) {
    target[0].parentElement?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }
}

/** 렌더링된 표의 배치: 열 폭과 머리글·본문 행 높이 */
interface TableLayout {
  widths: number[];
  head: number[];
  /**
   * 본문 행 높이와, 그 행 앞뒤에 있던 원문에 없는 행의 높이:
   * side-by-side 의 빈 행(반대쪽에서 삭제된 행 자리), inline 의 삭제된 행.
   * 편집기 표에는 없는 행이라 그대로 두면 아래 행이 올라가므로, 그 높이만큼 행 안에 여백을 줘서 줄을 맞춘다
   */
  body: { height: number; before: number; after: number }[];
}

function tableLayout(table: HTMLTableElement): TableLayout {
  const height = (r: HTMLTableRowElement) => Math.floor(r.getBoundingClientRect().height);
  const body: TableLayout['body'] = [];
  let spacer = 0;
  for (const tr of Array.from(table.tBodies[0]?.rows ?? [])) {
    if (tr.matches('.tr-empty, .tr-del')) {
      spacer += height(tr);
      continue;
    }
    body.push({ height: height(tr), before: spacer, after: 0 });
    spacer = 0;
  }
  if (spacer && body.length) body[body.length - 1].after = spacer;
  return {
    // 소수점을 버리면 경계에 걸린 글자가 한 줄 더 내려가므로 그대로 쓴다
    widths: firstRowCells(table).map((c) => c.getBoundingClientRect().width),
    head: Array.from(table.tHead?.rows ?? []).map(height),
    body,
  };
}

/** 빈 행 자리 여백: 렌더링된 빈 행과 같은 빗금 */
const SPACER_STRIPES = 'repeating-linear-gradient(-45deg, transparent 0 6px, rgba(128, 128, 128, 0.08) 6px 12px)';
/** diff.css 의 표 셀 위아래 여백 */
const CELL_PAD = 4;

/**
 * 렌더링된 표의 열 폭과 행 높이를 편집기 표에도 준다.
 * 안 주면 편집기가 표를 새로 배치해서 클릭한 곳이 다른 자리로 밀린다.
 * 행 높이는 최소 높이로 작용하므로 글을 더 쓰면 행이 늘어난다.
 */
function tableLayoutRules(layouts: TableLayout[]): string {
  return layouts
    .map(({ widths, head, body }, k) => {
      const table = `.cell.editing .toastui-editor-ww-container .ProseMirror > table:nth-of-type(${k + 1})`;
      const bodyRules = body.map(({ height, before, after }, r) => {
        const tr = `${table} > tbody > tr:nth-child(${r + 1})`;
        const rules = [`${tr} { height: ${height + before + after}px; }`];
        if (before || after) {
          const images = [before && SPACER_STRIPES, after && SPACER_STRIPES].filter(Boolean).join(', ');
          const sizes = [before && `100% ${before}px`, after && `100% ${after}px`].filter(Boolean).join(', ');
          const positions = [before && 'top', after && 'bottom'].filter(Boolean).join(', ');
          rules.push(
            `${tr} > td { padding-top: ${CELL_PAD + before}px; padding-bottom: ${CELL_PAD + after}px; ` +
              `background-image: ${images}; background-size: ${sizes}; background-position: ${positions}; background-repeat: no-repeat; }`,
          );
        }
        return rules.join('\n');
      });
      return [
        `${table} { table-layout: fixed; width: ${widths.reduce((a, b) => a + b, 0)}px; }`,
        ...widths.map((w, c) => `${table} tr > :nth-child(${c + 1}) { width: ${w}px; }`),
        ...head.map((h, r) => `${table} > thead > tr:nth-child(${r + 1}) { height: ${h}px; }`),
        ...bodyRules,
      ].join('\n');
    })
    .join('\n');
}

/** 요청한 블록의 현재 행. 행 번호가 바뀌었으면 원문이 같은 행 중 가장 가까운 것 */
function findRow(req: OpenRequest): number | undefined {
  const rows = last?.rows ?? [];
  if (rows[req.index]?.newSource === req.source) return req.index;
  let best: number | undefined;
  rows.forEach((row, k) => {
    if (row.newSource === req.source && (best === undefined || Math.abs(k - req.index) < Math.abs(best - req.index))) best = k;
  });
  return best;
}

function openEditor(req: OpenRequest): void {
  if (!last?.editable) return;
  commitEdit();
  if (editing) {
    queuedOpen = req;
    return;
  }
  const index = findRow(req);
  if (index === undefined) return;
  const row = last.rows[index];
  if (!row.newRange || row.newSource === undefined) return;

  const rowEl = content.querySelector<HTMLElement>(`.row[data-index="${index}"]`);
  const cell = rowEl?.querySelector<HTMLElement>(currentView() === 'inline' ? '.cell.inline' : '.cell.right');
  if (!cell) return;
  const layouts = Array.from(cell.querySelectorAll('table')).map(tableLayout);

  // .md 본문 스타일이 편집기 내부에 섞이지 않도록 뗀다
  cell.classList.remove('md');
  cell.classList.add('editing');
  cell.innerHTML = `
    <style>${tableLayoutRules(layouts)}</style>
    <div class="block-editor"></div>
    <div class="block-editor-hint">바깥을 클릭하면 적용 · Esc 취소 · Ctrl+클릭으로 링크 열기</div>`;
  const editor = new Editor({
    el: cell.querySelector<HTMLElement>('.block-editor')!,
    initialValue: row.newSource,
    initialEditType: 'wysiwyg',
    previewStyle: 'tab',
    height: 'auto',
    minHeight: '24px',
    usageStatistics: false,
    autofocus: true,
    hideModeSwitch: true,
    toolbarItems: [],
    language: last.language.toLowerCase().startsWith('ko') ? 'ko-KR' : 'en-US',
    theme: isDark() ? 'dark' : undefined,
  });
  editing = { index, editor, initial: editor.getMarkdown(), cell, applying: false };
  // 편집하는 동안에는 되돌리기 화살표를 숨긴다 (편집과 되돌리기가 섞이지 않도록)
  document.body.classList.add('block-editing');
  const { caret } = req;
  if (caret) {
    // Toast 의 autofocus 는 setTimeout(0) 뒤에 포커스를 주고, ProseMirror 는 포커스 20ms 뒤에
    // 자기 선택 영역(맨 앞)을 DOM 에 다시 쓴다. 그보다 먼저 옮기면 커서가 맨 앞으로 되돌아간다
    window.setTimeout(() => {
      const root = cell.querySelector<HTMLElement>('.toastui-editor-ww-container .ProseMirror');
      if (root && editing?.editor === editor) placeCaret(root, caret);
    }, CARET_DELAY);
  }
}

/** 편집을 마친다. 바뀐 게 있으면 적용하고, 없으면 그냥 닫는다 */
function commitEdit(): void {
  if (!editing || editing.applying) return;
  if (isEditorDirty()) applyEdit();
  else cancelEdit();
}

function applyEdit(): void {
  if (!editing || editing.applying || !last) return;
  const row = last.rows[editing.index];
  const next = editing.editor.getMarkdown();
  if (next === editing.initial || !row.newRange || row.newSource === undefined) {
    cancelEdit();
    return;
  }
  editing.applying = true;
  editing.cell.classList.add('applying');
  vscode.postMessage({
    type: 'editBlock',
    block: { range: row.newRange, source: row.newSource },
    prevNorm: editing.initial,
    nextNorm: next,
  });
  // 확장이 문서를 고친 뒤 render 를 보내면 편집기가 닫힌다
}

function cancelEdit(): void {
  closeEditor();
  if (pendingRender) {
    last = pendingRender;
    pendingRender = undefined;
  }
  render();
}

function revert(index: number): void {
  const row = last?.rows[index];
  if (!row || row.kind === 'equal') return;
  vscode.postMessage({
    type: 'revertBlock',
    kind: row.kind,
    block: row.newRange && row.newSource !== undefined ? { range: row.newRange, source: row.newSource } : undefined,
    oldSource: row.oldSource,
    prev: row.prev,
  });
}

// ---------------------------------------------------------------------------
// 탐색 / 이벤트
// ---------------------------------------------------------------------------

function flash(el: HTMLElement): void {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

/** 표 셀이면 열 번호, 아니면 -1 */
function columnOf(el: HTMLElement): number {
  const cell = el.closest('td, th');
  return cell ? Array.prototype.indexOf.call(cell.parentElement!.children, cell) : -1;
}

/**
 * 이동 대상: 추가/삭제된 블록, 수정된 블록 안의 추가/삭제된 표 행, 수정된 표 행의 바뀐 셀, 바뀐 단어.
 * 수정된 표 행은 행 대신 바뀐 셀을 가리켜서, 넓은 표에서도 그 셀이 보이도록 가로로 스크롤한다.
 * 같은 줄 높이에 있는 것(같은 줄의 del+ins, side-by-side 의 좌우 짝)은 하나로 합치되, 같은 행의 다른 열은 따로 센다.
 */
function changeTargets(): HTMLElement[] {
  const candidates = Array.from(
    content.querySelectorAll<HTMLElement>(
      '.row-added, .row-removed, .row-modified tr.tr-ins, .row-modified tr.tr-del, .row-modified tr.tr-mod > :is(td, th):has(ins, del), .row-modified ins, .row-modified del',
    ),
  ).filter((el) => el.offsetParent !== null && !(el.matches('ins, del') && el.closest('tr.tr-mod, tr.tr-ins, tr.tr-del')));

  const withPos = candidates
    .map((el) => ({ el, top: el.getBoundingClientRect().top, col: columnOf(el) }))
    .sort((a, b) => a.top - b.top || a.col - b.col);
  const result: HTMLElement[] = [];
  let groupTop = -Infinity;
  let groupCols = new Set<number>();
  for (const { el, top, col } of withPos) {
    if (top - groupTop > 10) {
      groupTop = top;
      groupCols = new Set();
    } else if (col < 0 || groupCols.has(col)) {
      continue;
    }
    groupCols.add(col);
    result.push(el);
  }
  return result;
}

function updateNavCount(targets = changeTargets()): void {
  $('.nav-count').textContent =
    targets.length === 0 ? '' : changeIndex >= 0 ? `${changeIndex + 1}/${targets.length}` : `${targets.length}곳`;
}

function goToChange(delta: number): void {
  const targets = changeTargets();
  if (targets.length === 0) return;
  changeIndex = changeIndex < 0 && delta < 0 ? targets.length - 1 : (changeIndex + delta + targets.length) % targets.length;
  content.querySelectorAll('.current-change').forEach((e) => e.classList.remove('current-change'));
  const target = targets[changeIndex];
  target.classList.add('current-change');
  // 넓은 표 안의 바뀐 셀은 가운데로, 추가/삭제된 행은 첫 열부터 보이도록 가로 스크롤한다
  // (반대쪽 표는 scroll 동기화로 따라온다)
  target.scrollIntoView({ block: 'center', inline: target.matches('tr') ? 'start' : 'center', behavior: 'smooth' });
  flash(target);
  updateNavCount(targets);
}

app.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  // 표 행 되돌리기: 셀 안에 있을 수 있으므로 블록 편집이 열리지 않도록 전파를 멈춘다
  if (btn.dataset.rowRevert !== undefined) {
    e.preventDefault();
    e.stopPropagation();
    const tr = arrowTarget.get(btn) ?? btn.closest<HTMLElement>('tr[data-revert]');
    if (tr) revertTableRow(tr, Number(btn.dataset.rowRevert));
    return;
  }
  const index = Number(btn.dataset.index);
  if (btn.dataset.view) {
    state.view = btn.dataset.view as View;
    vscode.setState(state);
    vscode.postMessage({ type: 'setView', view: state.view });
    // 편집을 적용하는 중이면 적용 뒤에 오는 render 가 새 보기로 그린다
    if (!editing) render();
  } else if (btn.dataset.act === 'revert') revert(index);
  else if (btn.id === 'prev') goToChange(-1);
  else if (btn.id === 'next') goToChange(1);
  else if (btn.id === 'save') vscode.postMessage({ type: 'save' });
  else if (btn.id === 'undo') stepHistory('undo');
  else if (btn.id === 'redo') stepHistory('redo');
  else if (btn.id === 'openEditor') vscode.postMessage({ type: 'openEditor' });
  else if (btn.id === 'openSource') vscode.postMessage({ type: 'openSource' });
});

/** 끌어서 글자를 고르는 것과 클릭을 가르는 거리(px) */
const DRAG = 4;

// 편집 중인 블록 바깥을 누르면 적용한다. 블록을 더블클릭하면 그 블록을 연다 (한 번 클릭은 글 선택만 한다)
document.addEventListener(
  'mousedown',
  (e) => {
    const target = e.target as HTMLElement;
    pressed = undefined;
    if (editing?.cell.contains(target)) return;
    // 편집을 닫으면 화면을 다시 그리므로, 누른 블록과 위치를 먼저 기록한다
    const cell = target.closest<HTMLElement>('.cell.editable');
    const index = Number(cell?.closest<HTMLElement>('.row')?.dataset.index);
    const source = last?.rows[index]?.newSource;
    const isClick =
      e.button === 0 &&
      !target.closest('button, input, .row-actions') &&
      !(target.closest('a') && (e.ctrlKey || e.metaKey)) &&
      // 표를 감싼 영역의 가로 스크롤바를 누른 경우
      !(target.classList.contains('table-wrap') && e.offsetY > target.clientHeight);
    if (cell && source !== undefined && isClick) {
      pressed = { index, source, caret: caretAt(cell, e.clientX, e.clientY), x: e.clientX, y: e.clientY };
    }
    commitEdit();
  },
  true,
);

/**
 * 더블클릭으로 편집을 연다. 한 번 클릭으로 열면 실수로 편집 모드에 들어가
 * Ctrl+Z 같은 단축키가 블록 편집기로 가 버리기 때문이다.
 * 위치는 두 번째 mousedown 에서 기록한 것을 쓴다 (더블클릭은 단어를 선택하므로 선택은 푼다)
 */
document.addEventListener('dblclick', (e) => {
  const req = pressed;
  pressed = undefined;
  if (!req || Math.hypot(e.clientX - req.x, e.clientY - req.y) > DRAG) return;
  window.getSelection()?.removeAllRanges();
  openEditor(req);
});

// 고칠 수 있는 곳의 링크는 클릭해도 열지 않고 Ctrl+클릭하면 연다 (VS Code 편집기와 같다).
// VS Code 가 webview 의 링크 클릭을 window 에서 받아 열므로 그 전에 막는다
document.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest('a');
  if (!link || e.ctrlKey || e.metaKey || !link.closest('.cell.editable, .cell.editing')) return;
  e.preventDefault();
  e.stopPropagation();
});

// 다른 창으로 나가면 고친 내용을 잃지 않도록 적용한다
window.addEventListener('blur', () => {
  if (isEditorDirty()) commitEdit();
});

$('#changesOnly').addEventListener('change', (e) => {
  state.changesOnly = (e.target as HTMLInputElement).checked;
  vscode.setState(state);
  // 행 표시가 바뀌므로 높이 맞춤과 변경 위치도 다시 계산된다. 적용 중이면 적용 뒤의 render 가 그린다
  if (!editing) render();
});

window.addEventListener(
  'keydown',
  (e) => {
    const mod = e.ctrlKey || e.metaKey;
    // 한글 입력 상태에서도 같은 키로 동작하도록 e.key 대신 자판 위치(e.code)로 본다
    const undoKey = mod && !e.altKey && !e.shiftKey && e.code === 'KeyZ';
    const redoKey = mod && !e.altKey && ((e.shiftKey && e.code === 'KeyZ') || (!e.shiftKey && e.code === 'KeyY'));
    if ((undoKey || redoKey) && last?.editable) {
      // 검색창 같은 입력란에서는 그 입력란의 실행취소를 쓴다
      if (!editing && (e.target as HTMLElement).closest?.('input, textarea')) return;
      // 블록 편집기에서 고친 게 있으면 편집기 안에서 실행취소한다
      if (editing && !editing.applying && isEditorDirty()) return;
      e.preventDefault();
      e.stopPropagation();
      // 편집기를 열었지만 아무것도 고치지 않았으면 닫고 diff 화면에서 적용한 변경을 실행취소한다
      if (editing && !editing.applying) cancelEdit();
      stepHistory(undoKey ? 'undo' : 'redo');
      return;
    }
    if (editing && mod && e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      applyEdit();
    } else if (editing && !editing.applying && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelEdit();
    } else if (mod && e.key.toLowerCase() === 's') {
      e.preventDefault();
      // 편집 중인 블록이 있으면 먼저 적용하고 저장
      if (editing && isEditorDirty()) applyEdit();
      vscode.postMessage({ type: 'save' });
    } else if (!editing && e.key === 'F7') {
      e.preventDefault();
      goToChange(e.shiftKey ? -1 : 1);
    }
  },
  true,
);

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type === 'render') onRenderMessage(msg as RenderMessage);
  else if (msg.type === 'editFailed') {
    // 실패한 편집기를 그대로 두고 다시 고칠 수 있게 하므로, 기다리던 다음 블록은 열지 않는다
    queuedOpen = undefined;
    if (editing) {
      editing.applying = false;
      editing.cell.classList.remove('applying');
    }
    showNotice(msg.message);
  } else if (msg.type === 'notice') {
    showNotice(msg.message);
  } else if (msg.type === 'error') {
    content.innerHTML = `<div class="error">${escapeHtml(msg.message)}</div>`;
  }
});

// diff 화면 전체(렌더된 좌/우·inline 셀 포함)를 검색 대상으로 한다
setupSearch(['#content']);

vscode.postMessage({ type: 'ready' });
