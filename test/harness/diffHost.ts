/**
 * 브라우저 테스트용 가짜 확장 호스트.
 * diffPanel.ts 와 같은 로직(실제 diff / 블록 편집 / 서식 보존 모듈)으로 webview 메시지를 처리한다.
 */
import { diffMarkdown } from '../../src/markdownDiff';
import { BlockNotFoundError, currentBlockSource, insertBlockAfter, replaceBlock } from '../../src/blockEdit';
import { applyNormalizedEdit } from '../../src/preserveFormat';

const OLD = `# 릴리즈 노트

이번 버전에서는 __로그인__ 화면을 개선했습니다.

## 변경 사항

* 비밀번호 찾기 링크 추가
* 오류 메시지 개선

## 알려진 문제

일부 브라우저에서 레이아웃이 깨집니다.
`;

let doc = `# 릴리즈 노트

이번 버전에서는 __로그인__과 *회원가입* 화면을 개선했습니다.

## 변경 사항

* 비밀번호 찾기 링크 추가
* 오류 메시지 개선
* 다크 모드 지원

> 다음 버전은 12월에 배포됩니다.
`;
let dirty = false;
// diffPanel.ts 와 같은 실행취소 기록
const undoStack: { before: string; after: string }[] = [];
const redoStack: { before: string; after: string }[] = [];
const firstChangedLine = (a: string, b: string) => {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return b.slice(0, i).split('\n').length - 1;
};

// ?fixture=<경로> 로 { old, new } JSON 을 받아 다른 문서로 테스트한다
const fixturePath = new URLSearchParams(location.search).get('fixture');
let OLD_TEXT = OLD;
if (fixturePath) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', fixturePath, false);
  xhr.send();
  const f = JSON.parse(xhr.responseText) as { old: string; new: string };
  OLD_TEXT = f.old;
  doc = f.new;
}

const w = window as unknown as Record<string, unknown>;
const sent: unknown[] = [];
w.__sent = sent;
w.__doc = () => doc;
w.__dirty = () => dirty;

const toWebview = (msg: unknown) => window.postMessage(msg, '*');

function render(focusLine?: number) {
  toWebview({
    type: 'render',
    ...diffMarkdown(OLD_TEXT, doc),
    leftLabel: 'release.md (HEAD)',
    rightLabel: 'release.md (작업 중)',
    view: 'inline',
    canOpenSource: true,
    editable: true,
    dirty,
    language: 'ko',
    history: { canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 },
    focusLine,
  });
}

type Msg = { type: string; [k: string]: any };

function handle(msg: Msg) {
  // 확장의 documentLines 와 같이 나눈다 (CRLF 픽스처)
  const lines = doc.split(/\r?\n/);
  try {
    if (msg.type === 'ready') return render();
    if (msg.type === 'save') {
      dirty = false;
      return render();
    }
    if (msg.type === 'undo' || msg.type === 'redo') {
      const [from, to] = msg.type === 'undo' ? [undoStack, redoStack] : [redoStack, undoStack];
      const entry = from.pop();
      if (!entry) return render();
      const target = msg.type === 'undo' ? entry.before : entry.after;
      const line = firstChangedLine(doc, target);
      doc = target;
      dirty = true;
      to.push(entry);
      return render(line);
    }
    let next: string[] | undefined;
    if (msg.type === 'editBlock') {
      next = replaceBlock(lines, msg.block, applyNormalizedEdit(currentBlockSource(lines, msg.block), msg.prevNorm, msg.nextNorm));
    } else if (msg.type === 'revertBlock') {
      if (msg.kind === 'added') next = replaceBlock(lines, msg.block, '');
      else if (msg.kind === 'modified') next = replaceBlock(lines, msg.block, msg.oldSource);
      else if (msg.kind === 'removed') next = insertBlockAfter(lines, msg.prev, msg.oldSource);
    }
    if (next) {
      const text = next.join('\n');
      if (text !== doc) {
        undoStack.push({ before: doc, after: text });
        redoStack.length = 0;
        doc = text;
        dirty = true;
      }
      render();
    }
  } catch (e) {
    toWebview({ type: 'editFailed', message: e instanceof BlockNotFoundError ? e.message : String(e) });
    render();
  }
}

w.acquireVsCodeApi = () => ({
  getState: () => undefined,
  setState: () => {},
  postMessage: (msg: Msg) => {
    sent.push(msg);
    setTimeout(() => handle(msg), 0);
  },
});
