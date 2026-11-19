// ---------------------------------------------------------------------------
// 에디터 안 검색 (Ctrl+F / Cmd+F)
//
// Toast UI Editor 에는 내장 검색이 없다. WYSIWYG 영역은 ProseMirror 가 DOM 을
// 관리하므로 <mark> 같은 노드를 직접 끼워 넣으면 곧 되돌려버린다. 그래서 DOM 을
// 전혀 건드리지 않는 CSS Custom Highlight API 로 Range 에 하이라이트를 입힌다.
// (지원하지 않는 환경을 위해 <mark> 래핑 방식으로 자동 대체한다.)
// ---------------------------------------------------------------------------

/** 기본 검색 대상 영역: WYSIWYG 편집 영역, 마크다운 모드의 미리보기 */
const DEFAULT_ROOTS = ['.toastui-editor-ww-container .ProseMirror', '.toastui-editor-md-preview .toastui-editor-contents'];

/** 검색 대상 영역 셀렉터. setupSearch 에서 바꿀 수 있다 */
let SEARCH_ROOTS = DEFAULT_ROOTS;

const HL_ALL = 'mpe-search';
const HL_ACTIVE = 'mpe-search-active';
const FALLBACK_HIT = 'mpe-search-hit';
const FALLBACK_ACTIVE = 'mpe-search-active-mark';

/** CSS Custom Highlight API 사용 가능 여부 */
const supportsHighlight = typeof (globalThis as any).Highlight === 'function' && !!(CSS as any).highlights;

let bar: HTMLDivElement | undefined;
let input: HTMLInputElement | undefined;
let countLabel: HTMLSpanElement | undefined;
let caseToggle: HTMLButtonElement | undefined;

/** 하이라이트 API 모드: 매치 Range 목록. 대체 모드: 빈 배열(아래 fallbackHits 사용) */
let ranges: Range[] = [];
let fallbackHits: HTMLElement[] = [];
let activeIndex = -1;
let caseSensitive = false;

function matchCount(): number {
  return supportsHighlight ? ranges.length : fallbackHits.length;
}

function visibleRoot(): HTMLElement | undefined {
  for (const selector of SEARCH_ROOTS) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el && el.offsetParent !== null && el.clientWidth > 0) return el;
  }
  return undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function collectTextNodes(root: HTMLElement): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest(`.${FALLBACK_HIT}`)) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const out: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) out.push(n as Text);
  return out;
}

// --- Custom Highlight API 모드 ------------------------------------------------

function clearHighlightApi(): void {
  (CSS as any).highlights?.delete(HL_ALL);
  (CSS as any).highlights?.delete(HL_ACTIVE);
  ranges = [];
}

function searchHighlightApi(query: string): void {
  clearHighlightApi();
  const root = visibleRoot();
  if (!root || !query) return;

  const flags = caseSensitive ? 'g' : 'gi';
  const re = new RegExp(escapeRegExp(query), flags);

  for (const textNode of collectTextNodes(root)) {
    const text = textNode.nodeValue ?? '';
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const range = document.createRange();
      range.setStart(textNode, m.index);
      range.setEnd(textNode, m.index + m[0].length);
      ranges.push(range);
      if (m[0].length === 0) re.lastIndex++;
    }
  }

  if (ranges.length > 0) {
    (CSS as any).highlights.set(HL_ALL, new (globalThis as any).Highlight(...ranges));
  }
}

function paintActiveApi(): void {
  (CSS as any).highlights?.delete(HL_ACTIVE);
  const range = ranges[activeIndex];
  if (!range) return;
  (CSS as any).highlights.set(HL_ACTIVE, new (globalThis as any).Highlight(range));
  scrollRangeIntoView(range);
}

function scrollRangeIntoView(range: Range): void {
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return;
  // 바가 가리지 않도록 위쪽에 약간 여유를 두고 화면 중앙 근처로 이동
  const target = window.scrollY + rect.top - window.innerHeight / 2 + rect.height / 2;
  // 편집 영역은 자체 스크롤 컨테이너일 수 있으므로 가장 가까운 스크롤 조상도 함께 맞춘다
  const anchor = range.startContainer.parentElement;
  anchor?.scrollIntoView({ block: 'center', inline: 'nearest' });
  if (document.scrollingElement) window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
}

// --- 대체 모드: <mark> 래핑 ----------------------------------------------------

function clearFallback(): void {
  for (const root of SEARCH_ROOTS) {
    const el = document.querySelector<HTMLElement>(root);
    if (!el) continue;
    el.querySelectorAll<HTMLElement>(`.${FALLBACK_HIT}`).forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark);
      parent.normalize();
    });
  }
  fallbackHits = [];
}

function searchFallback(query: string): void {
  clearFallback();
  const root = visibleRoot();
  if (!root || !query) return;

  const flags = caseSensitive ? 'g' : 'gi';
  const re = new RegExp(escapeRegExp(query), flags);

  for (const textNode of collectTextNodes(root)) {
    const text = textNode.nodeValue ?? '';
    re.lastIndex = 0;
    if (!re.test(text)) continue;
    re.lastIndex = 0;

    const frag = document.createDocumentFragment();
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      if (start > last) frag.appendChild(document.createTextNode(text.slice(last, start)));
      const mark = document.createElement('mark');
      mark.className = FALLBACK_HIT;
      mark.textContent = m[0];
      frag.appendChild(mark);
      last = end;
      fallbackHits.push(mark);
      if (m[0].length === 0) re.lastIndex++;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    textNode.parentNode?.replaceChild(frag, textNode);
  }
}

function paintActiveFallback(): void {
  fallbackHits.forEach((el, i) => el.classList.toggle(FALLBACK_ACTIVE, i === activeIndex));
  const mark = fallbackHits[activeIndex];
  mark?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// --- 공통 ---------------------------------------------------------------------

function clearAll(): void {
  if (supportsHighlight) clearHighlightApi();
  else clearFallback();
  activeIndex = -1;
}

function updateCount(): void {
  if (!countLabel) return;
  const total = matchCount();
  countLabel.textContent = total === 0 ? '0/0' : `${activeIndex + 1}/${total}`;
  input?.classList.toggle('mpe-search-nohit', !!input.value && total === 0);
}

function setActive(index: number): void {
  const total = matchCount();
  if (total === 0) {
    activeIndex = -1;
    updateCount();
    return;
  }
  activeIndex = ((index % total) + total) % total;
  if (supportsHighlight) paintActiveApi();
  else paintActiveFallback();
  updateCount();
}

/** 현재 입력어로 다시 검색한다. keepIndex 면 가능한 한 현재 위치를 유지 */
function runSearch(keepIndex = false): void {
  const prev = activeIndex;
  const query = input?.value ?? '';
  if (supportsHighlight) searchHighlightApi(query);
  else searchFallback(query);
  const total = matchCount();
  if (total === 0) {
    activeIndex = -1;
    updateCount();
    return;
  }
  setActive(keepIndex && prev >= 0 ? Math.min(prev, total - 1) : 0);
}

function openBar(): void {
  if (!bar) buildBar();
  bar!.classList.add('mpe-search-open');
  const selection = window.getSelection()?.toString().trim();
  if (selection && selection.length <= 100) input!.value = selection;
  input!.focus();
  input!.select();
  runSearch();
}

function closeBar(): void {
  if (!bar) return;
  bar.classList.remove('mpe-search-open');
  clearAll();
}

function buildBar(): void {
  bar = document.createElement('div');
  bar.className = 'mpe-search-bar';

  input = document.createElement('input');
  input.type = 'text';
  input.className = 'mpe-search-input';
  input.placeholder = '검색';
  input.spellcheck = false;

  countLabel = document.createElement('span');
  countLabel.className = 'mpe-search-count';
  countLabel.textContent = '0/0';

  caseToggle = document.createElement('button');
  caseToggle.className = 'mpe-search-btn mpe-search-case';
  caseToggle.title = '대소문자 구분';
  caseToggle.textContent = 'Aa';

  const prevBtn = document.createElement('button');
  prevBtn.className = 'mpe-search-btn';
  prevBtn.title = '이전 (Shift+Enter)';
  prevBtn.textContent = '\u2191';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'mpe-search-btn';
  nextBtn.title = '다음 (Enter)';
  nextBtn.textContent = '\u2193';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'mpe-search-btn';
  closeBtn.title = '닫기 (Esc)';
  closeBtn.textContent = '\u2715';

  bar.append(input, countLabel, caseToggle, prevBtn, nextBtn, closeBtn);
  document.body.appendChild(bar);

  let debounce: number | undefined;
  input.addEventListener('input', () => {
    window.clearTimeout(debounce);
    debounce = window.setTimeout(() => runSearch(), 120);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (matchCount() === 0) return;
      setActive(activeIndex + (e.shiftKey ? -1 : 1));
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeBar();
    }
  });

  caseToggle.addEventListener('mousedown', (e) => e.preventDefault());
  caseToggle.addEventListener('click', () => {
    caseSensitive = !caseSensitive;
    caseToggle!.classList.toggle('mpe-search-btn-on', caseSensitive);
    runSearch(true);
  });

  const nav = (delta: number) => (e: MouseEvent) => {
    e.preventDefault();
    if (matchCount() > 0) setActive(activeIndex + delta);
    input!.focus();
  };
  prevBtn.addEventListener('mousedown', (e) => e.preventDefault());
  prevBtn.addEventListener('click', nav(-1));
  nextBtn.addEventListener('mousedown', (e) => e.preventDefault());
  nextBtn.addEventListener('click', nav(1));
  closeBtn.addEventListener('mousedown', (e) => e.preventDefault());
  closeBtn.addEventListener('click', () => closeBar());
}

/**
 * 검색 기능을 켠다. Ctrl+F / Cmd+F 로 검색 바가 열린다.
 * @param roots 검색 대상 영역 셀렉터. 기본값은 편집기(WYSIWYG/미리보기) 영역.
 */
export function setupSearch(roots: string[] = DEFAULT_ROOTS): void {
  SEARCH_ROOTS = roots;
  window.addEventListener(
    'keydown',
    (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        openBar();
      }
    },
    true,
  );
}
