import Editor from '@toast-ui/editor';
import '@toast-ui/editor/dist/i18n/ko-kr';
import { closeHistory, undoDepth } from 'prosemirror-history';
import type { EditorView } from 'prosemirror-view';
import { MIN_COL, measureColumns, planWidths } from './tableWidths';
import { setupSearch } from './search';

interface WebviewState {
  /** 사용자가 드래그로 조절한 열 폭. 키는 표 머리글(열 이름을 | 로 이은 것) */
  columnWidths?: Record<string, number[]>;
}
declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): WebviewState | undefined;
  setState(state: WebviewState): void;
};
const vscode = acquireVsCodeApi();

type InitMessage = { type: 'init'; text: string; syncId: number; mode: 'wysiwyg' | 'markdown'; language: string };
type UpdateMessage = { type: 'update'; text: string; syncId: number };

let editor: Editor | undefined;
/** 마지막으로 확장과 동기화된 (에디터가 정규화한) Markdown */
let synced = '';
/** 마지막으로 받은 문서 동기화 ID. 확장은 이 값으로 webview 가 놓친 외부 변경이 있었는지 판단한다 */
let syncId = 0;
let timer: number | undefined;

const isDark = () =>
  document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');

function flushChange(): void {
  timer = undefined;
  if (!editor) return;
  const next = editor.getMarkdown();
  if (next === synced) return;
  vscode.postMessage({ type: 'edit', prev: synced, next, syncId });
  synced = next;
}

function onChange(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(flushChange, 250);
  scheduleLayout();
}

// ---------------------------------------------------------------------------
// 표 열 폭: 자동 맞춤 + 드래그 조절
//
// 편집기(ProseMirror) DOM 을 직접 고치면 편집기가 되돌리거나 문서가 꼬일 수 있으므로,
// 열 폭은 표 순서(nth-of-type)로 지정하는 <style> 규칙으로만 준다.
// ---------------------------------------------------------------------------

/** 표가 바로 아래 자식으로 들어가는 영역: WYSIWYG 편집 영역, 마크다운 모드의 미리보기 */
const TABLE_ROOTS = ['.toastui-editor-ww-container .ProseMirror', '.toastui-editor-md-preview .toastui-editor-contents'];

interface TablePlan {
  selector: string;
  key: string;
  widths: number[];
  /** 사용자가 드래그로 조절한 폭 */
  manual: boolean;
  /** 브라우저 기본 배치를 그대로 쓴다 (폭 규칙을 만들지 않는다). widths 는 드래그 시작용 현재 폭 */
  auto?: boolean;
}

const columnState: WebviewState = vscode.getState() ?? {};
const manualWidths: Record<string, number[]> = columnState.columnWidths ?? {};
const widthStyle = document.createElement('style');
document.head.appendChild(widthStyle);
let plans: TablePlan[] = [];
let layoutTimer: number | undefined;

function saveColumnWidths(): void {
  vscode.setState({ ...columnState, columnWidths: manualWidths });
}

function tableKey(table: HTMLTableElement): string {
  return Array.from(table.rows[0]?.cells ?? [])
    .map((c) => (c.textContent ?? '').trim())
    .join('|');
}

function scheduleLayout(delay = 300): void {
  window.clearTimeout(layoutTimer);
  layoutTimer = window.setTimeout(layoutTables, delay);
}

const naturalWidths = (table: HTMLTableElement) =>
  Array.from(table.rows[0]?.cells ?? []).map((c) => c.getBoundingClientRect().width);

function layoutTables(): void {
  if (drag) return;
  const previous = plans;
  plans = [];
  // 브라우저 기본 배치를 시작점으로 쓰기 위해 지정한 폭을 잠시 푼다 (같은 작업 안이라 화면에는 그려지지 않는다)
  widthStyle.textContent = '';
  /** 브라우저 기본 배치에서의 표 높이. 자동 맞춤이 이보다 높으면 기본 배치를 쓴다 */
  const defaultHeight = new Map<string, number>();
  for (const rootSelector of TABLE_ROOTS) {
    const root = document.querySelector<HTMLElement>(rootSelector);
    // 숨겨진 쪽(WYSIWYG 모드의 마크다운 미리보기 등)은 잴 수 없으므로 모드가 바뀔 때 다시 잰다
    if (!root || root.offsetParent === null || root.clientWidth === 0) continue;
    const s = getComputedStyle(root);
    // 표 테두리(border-collapse)가 1px 더 그려지므로 여유를 둔다
    const available = root.clientWidth - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) - 2;
    root.querySelectorAll<HTMLTableElement>(':scope > table').forEach((table, k) => {
      const stats = measureColumns([table]);
      if (!stats) return;
      const selector = `${rootSelector} > table:nth-of-type(${k + 1})`;
      defaultHeight.set(selector, table.getBoundingClientRect().height);
      const key = tableKey(table);
      const manual = manualWidths[key]?.length === stats.cols ? [...manualWidths[key]] : undefined;
      let widths = manual ?? planWidths(stats, available, naturalWidths(table));
      // 셀에 글을 입력하는 동안 열이 조금씩 흔들리지 않도록, 변화가 작으면 이전 폭을 유지한다
      const old = previous.find((p) => p.selector === selector);
      if (!manual && old && !old.manual && !old.auto && old.widths.length === widths.length && widths.every((w, c) => Math.abs(w - old.widths[c]) < 12)) {
        widths = old.widths;
      }
      plans.push({ selector, key, widths, manual: !!manual });
    });
  }
  renderWidthRules();

  // 줄 수 추정은 근사치라서, 실제로 적용해 봤을 때 기본 배치보다 표가 높아지면 그 표는 기본 배치로 둔다
  const worse = plans.filter((p) => {
    if (p.manual) return false;
    const table = document.querySelector<HTMLTableElement>(p.selector);
    const base = defaultHeight.get(p.selector);
    return !!table && base !== undefined && table.getBoundingClientRect().height > base + 1;
  });
  if (worse.length > 0) {
    // 기본 배치로 둔 표도 드래그로 조절할 수 있도록 지금 폭을 기록해 둔다
    for (const p of worse) p.widths = [];
    widthStyle.textContent = '';
    for (const p of worse) {
      const table = document.querySelector<HTMLTableElement>(p.selector);
      if (table) p.widths = naturalWidths(table).map((w) => Math.round(w));
      p.auto = true;
    }
    renderWidthRules();
  }
}

function renderWidthRules(): void {
  widthStyle.textContent = plans
    .filter((p) => !p.auto && p.widths.length > 0)
    .map((p) => {
      const total = p.widths.reduce((a, b) => a + b, 0);
      return [
        `${p.selector} { table-layout: fixed; width: ${total}px; }`,
        // 계산한 폭은 여백·테두리를 포함한 값이므로 border-box 로 지정한다
        `${p.selector} tr > * { box-sizing: border-box; }`,
        ...p.widths.map((w, c) => `${p.selector} tr > :nth-child(${c + 1}) { width: ${w}px; }`),
      ].join('\n');
    })
    .join('\n');
}

/** 열 경계로 인정하는 거리(px) */
const EDGE = 6;
let hover: { plan: TablePlan; col: number } | undefined;
let drag: { plan: TablePlan; col: number; startX: number; startWidth: number } | undefined;

/** 마우스가 열 경계 위에 있으면 그 경계의 왼쪽 열 */
function edgeAt(e: MouseEvent): { plan: TablePlan; col: number } | undefined {
  const cell = (e.target as HTMLElement | null)?.closest?.('th, td') as HTMLTableCellElement | null;
  const table = cell?.closest('table');
  if (!cell || !table) return undefined;
  const plan = plans.find((p) => table.matches(p.selector));
  if (!plan) return undefined;
  const rect = cell.getBoundingClientRect();
  if (rect.right - e.clientX <= EDGE) return { plan, col: cell.cellIndex };
  if (e.clientX - rect.left <= EDGE && cell.cellIndex > 0) return { plan, col: cell.cellIndex - 1 };
  return undefined;
}

window.addEventListener(
  'mousemove',
  (e) => {
    if (drag) {
      e.preventDefault();
      drag.plan.widths[drag.col] = Math.max(MIN_COL, Math.round(drag.startWidth + e.clientX - drag.startX));
      renderWidthRules();
      return;
    }
    hover = edgeAt(e);
    document.body.classList.toggle('col-resize-hover', !!hover);
  },
  true,
);

// 경계를 잡으면 편집기가 커서를 옮기거나 셀을 선택하지 않도록 캡처 단계에서 가로챈다
window.addEventListener(
  'mousedown',
  (e) => {
    if (!hover || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.detail >= 2) {
      // 더블클릭: 이 표를 자동 폭으로 되돌린다
      delete manualWidths[hover.plan.key];
      saveColumnWidths();
      plans = plans.filter((p) => p !== hover!.plan);
      layoutTables();
      return;
    }
    // 드래그하는 열만 바뀌고 나머지 열은 지금 폭을 유지한다 (기본 배치였던 표도 지금 폭으로 고정한다)
    hover.plan.auto = false;
    drag = { plan: hover.plan, col: hover.col, startX: e.clientX, startWidth: hover.plan.widths[hover.col] };
    document.body.classList.add('col-resizing');
  },
  true,
);

window.addEventListener(
  'mouseup',
  (e) => {
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    drag.plan.manual = true;
    manualWidths[drag.plan.key] = [...drag.plan.widths];
    saveColumnWidths();
    drag = undefined;
    document.body.classList.remove('col-resizing');
  },
  true,
);

window.addEventListener('resize', () => scheduleLayout(100));

// ---------------------------------------------------------------------------
// 실행취소 / 다시실행
//
// - 편집기(ProseMirror)는 처음 불러온 내용과 외부 변경으로 다시 넣은 내용(setMarkdown)까지 실행취소 기록에 남겨,
//   Ctrl+Z 를 계속 누르면 문서가 통째로 비거나 예전 내용으로 돌아간다. 그래서 불러온 시점을 기준선으로 두고
//   그보다 앞으로는 되돌리지 않는다.
// - 편집기가 Ctrl+Z 를 처리한 뒤 키 이벤트가 VS Code 까지 올라가면 VS Code 도 문서를 한 번 더 되돌린다.
//   편집기보다 먼저(캡처 단계) 가로채 직접 실행하고 VS Code 로는 보내지 않는다.
// ---------------------------------------------------------------------------

/** 편집기 내부의 ProseMirror 뷰 (WYSIWYG, 마크다운) */
function editorViews(): EditorView[] {
  const e = editor as unknown as { wwEditor?: { view?: EditorView }; mdEditor?: { view?: EditorView } } | undefined;
  return [e?.wwEditor?.view, e?.mdEditor?.view].filter((v): v is EditorView => !!v);
}

/** 뷰별 실행취소 기준선 (이 깊이 아래로는 되돌리지 않는다) */
const undoBaseline = new WeakMap<EditorView, number>();

/** 지금 내용을 실행취소 기준선으로 삼는다. 이후 입력이 불러온 내용과 한 묶음이 되지 않도록 기록도 끊는다 */
function resetUndoBaseline(): void {
  for (const view of editorViews()) {
    view.dispatch(closeHistory(view.state.tr));
    undoBaseline.set(view, undoDepth(view.state));
  }
}

window.addEventListener(
  'keydown',
  (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.altKey || !editor) return;
    // 한글 입력 상태에서도 같은 키로 동작하도록 자판 위치(e.code)로 본다
    const undo = e.code === 'KeyZ' && !e.shiftKey;
    const redo = (e.code === 'KeyZ' && e.shiftKey) || (e.code === 'KeyY' && !e.shiftKey);
    if (!undo && !redo) return;
    const target = e.target as HTMLElement | null;
    // 검색창 같은 입력란은 그 입력란의 기본 실행취소를 쓴다 (VS Code 로 보내면 문서가 되돌려진다)
    if (target?.closest?.('input, textarea')) {
      e.stopPropagation();
      return;
    }
    // 편집기 본문에 커서가 있을 때만. 코드 블록 편집 창 등 다른 ProseMirror 는 자체 처리에 맡긴다
    const view = editorViews().find((v) => target?.closest?.('.ProseMirror') === v.dom);
    if (!view) return;
    e.preventDefault();
    e.stopPropagation();
    if (undo && undoDepth(view.state) <= (undoBaseline.get(view) ?? 0)) return;
    editor.exec(undo ? 'undo' : 'redo');
  },
  true,
);

function create(msg: InitMessage): void {
  const el = document.getElementById('editor')!;
  editor = new Editor({
    el,
    height: '100%',
    initialEditType: msg.mode,
    previewStyle: 'vertical',
    initialValue: msg.text,
    usageStatistics: false,
    autofocus: false,
    language: msg.language.toLowerCase().startsWith('ko') ? 'ko-KR' : 'en-US',
    theme: isDark() ? 'dark' : undefined,
    events: { change: onChange },
  });
  // 모드가 바뀌면 보이는 영역(WYSIWYG ↔ 마크다운 미리보기)이 달라지므로 열 폭을 다시 잰다.
  // 바뀐 쪽 편집기에는 내용을 통째로 다시 넣으므로 실행취소 기준선도 다시 잡는다
  editor.on('changeMode', () => {
    resetUndoBaseline();
    scheduleLayout(50);
  });
  resetUndoBaseline();
  synced = editor.getMarkdown();
  syncId = msg.syncId;
  scheduleLayout(50);
  window.addEventListener('blur', () => timer !== undefined && flushChange());
}

/** 텍스트 에디터 등 외부에서 문서가 바뀐 경우 */
function applyExternal({ text, syncId: id }: UpdateMessage): void {
  if (!editor) return;
  // 아직 보내지 않은 편집은 먼저 보낸다. 이전 syncId 로 보내지므로 확장이 병합 후 다시 update 를 보내준다
  if (timer !== undefined) flushChange();
  syncId = id;

  // setMarkdown 은 스크롤을 초기화하므로 위치를 기억했다가 복원한다
  const scrolled = Array.from(document.querySelectorAll<HTMLElement>('#editor *'))
    .filter((e) => e.scrollTop > 0)
    .map((e) => [e, e.scrollTop] as const);
  editor.setMarkdown(text, false);
  // 외부 변경으로 바뀐 내용을 Ctrl+Z 로 통째로 되돌리지 않도록 (외부 변경은 그쪽 편집기에서 되돌린다)
  resetUndoBaseline();
  synced = editor.getMarkdown();
  window.clearTimeout(timer);
  timer = undefined;
  for (const [e, top] of scrolled) e.scrollTop = top;
  scheduleLayout();
}

window.addEventListener('message', (event: MessageEvent<InitMessage | UpdateMessage>) => {
  const msg = event.data;
  if (msg.type === 'init') create(msg);
  else if (msg.type === 'update') applyExternal(msg);
});

// VS Code 테마가 바뀌면 에디터 테마도 따라간다
new MutationObserver(() => {
  document.querySelector('.toastui-editor-defaultUI')?.classList.toggle('toastui-editor-dark', isDark());
}).observe(document.body, { attributes: true, attributeFilter: ['class'] });

setupSearch();

vscode.postMessage({ type: 'ready' });
