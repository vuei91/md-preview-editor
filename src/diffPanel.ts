import * as vscode from 'vscode';
import * as path from 'node:path';
import { diffMarkdown } from './markdownDiff';
import { BlockNotFoundError, BlockRef, currentBlockSource, insertBlockAfter, replaceBlock } from './blockEdit';
import { documentLines, replaceMinimal, setDocumentLines } from './documentEdit';
import { applyNormalizedEdit } from './preserveFormat';
import { buildWebviewHtml, dirOf, localResourceRoots } from './webviewHtml';

export interface DiffSide {
  label: string;
  /** 이 문서가 바뀌면 diff 를 다시 계산한다 */
  uri?: vscode.Uri;
  load(): Promise<string>;
}

/** 열린 문서(편집 중인 내용 포함)를 기준으로 읽는 DiffSide. git: 등 다른 스킴도 지원 */
export function documentSide(uri: vscode.Uri, label?: string): DiffSide {
  return {
    label: label ?? (uri.scheme === 'file' ? vscode.workspace.asRelativePath(uri) : path.basename(uri.path)),
    uri,
    load: async () => (await vscode.workspace.openTextDocument(uri)).getText(),
  };
}

export function staticSide(label: string, load: () => Promise<string>): DiffSide {
  return { label, load };
}

type FromWebview =
  | { type: 'ready' }
  | { type: 'setView'; view: string }
  | { type: 'openSource' }
  | { type: 'openEditor' }
  | { type: 'save' }
  /** 블록 편집: prevNorm/nextNorm 은 블록 편집기가 정규화한 편집 전/후 Markdown */
  | { type: 'editBlock'; block: BlockRef; prevNorm: string; nextNorm: string }
  /** 되돌리기: modified → 원본 내용으로 교체, added → 삭제, removed → prev 뒤에 원본 삽입 */
  | { type: 'revertBlock'; kind: 'modified' | 'added' | 'removed'; block?: BlockRef; oldSource?: string; prev?: BlockRef }
  /** diff 화면에서 적용한 변경(편집·되돌리기)을 하나씩 실행취소 / 다시실행 */
  | { type: 'undo' }
  | { type: 'redo' };

/** diff 화면에서 적용한 변경 하나: 적용 전후의 문서 전체 */
interface HistoryEntry {
  before: string;
  after: string;
}

/** 실행취소 기록은 최근 것만 남긴다 */
const HISTORY_LIMIT = 100;

/** 두 글이 처음 달라지는 줄 (0부터). 같으면 undefined */
function firstChangedLine(a: string, b: string): number | undefined {
  if (a === b) return undefined;
  let i = 0;
  while (i < a.length && i < b.length && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return b.slice(0, i).split('\n').length - 1;
}

/** 편집 가능한 스킴 (git:, 리비전 등은 읽기 전용) */
const EDITABLE_SCHEMES = new Set(['file', 'untitled', 'vscode-remote']);

export class DiffPanel {
  static readonly viewType = 'mdPreviewEditor.diff';
  private static readonly VIEW_KEY = 'mdPreviewEditor.diff.view';

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly editable: boolean;
  private timer: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();
  /**
   * diff 화면은 텍스트 편집기가 아니라서 Ctrl+Z 가 문서의 실행취소로 가지 않는다.
   * 그래서 이 화면에서 적용한 변경만 따로 기록해 두고 되돌린다 (문서 자체의 실행취소 기록에도 그대로 남는다)
   */
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];

  static open(context: vscode.ExtensionContext, original: DiffSide, modified: DiffSide, title?: string): DiffPanel {
    return new DiffPanel(context, original, modified, title);
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly original: DiffSide,
    private readonly modified: DiffSide,
    title?: string,
  ) {
    this.editable = !!modified.uri && EDITABLE_SCHEMES.has(modified.uri.scheme);
    const baseDir = (modified.uri && dirOf(modified.uri)) ?? (original.uri && dirOf(original.uri));
    const panel = vscode.window.createWebviewPanel(
      DiffPanel.viewType,
      title ?? `${path.basename(modified.label)} (미리보기 Diff)`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: localResourceRoots(context.extensionUri, baseDir),
      },
    );
    panel.webview.html = buildWebviewHtml(panel.webview, context.extensionUri, {
      title: 'Markdown Diff',
      script: 'diff.js',
      styles: ['toastui-editor.css', 'toastui-editor-dark.css', 'diff.css', 'search.css'],
      body: '<div id="app"></div>',
      baseDir,
    });
    this.panel = panel;

    const watched = [original.uri, modified.uri].filter((u): u is vscode.Uri => !!u).map((u) => u.toString());
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (watched.includes(e.document.uri.toString())) this.scheduleRender();
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (watched.includes(doc.uri.toString())) this.scheduleRender();
      }),
      // 편집 → 저장처럼 순서가 중요한 메시지가 있으므로 하나씩 처리한다
      panel.webview.onDidReceiveMessage((msg: FromWebview) => {
        this.queue = this.queue.then(() => this.onMessage(msg)).catch((e) => console.error(e));
      }),
    );
    panel.onDidDispose(() => this.dispose());
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case 'ready':
        return this.render();
      case 'setView':
        await this.context.globalState.update(DiffPanel.VIEW_KEY, msg.view);
        return;
      case 'openSource':
        if (this.modified.uri) await vscode.commands.executeCommand('vscode.open', this.modified.uri);
        return;
      case 'openEditor':
        if (this.modified.uri) {
          await vscode.commands.executeCommand('vscode.openWith', this.modified.uri, 'mdPreviewEditor.editor', vscode.ViewColumn.Beside);
        }
        return;
      case 'save':
        if (this.editable) await (await this.modifiedDocument()).save();
        return this.render();
      case 'editBlock':
      case 'revertBlock':
        return this.applyBlockChange(msg);
      case 'undo':
      case 'redo':
        return this.stepHistory(msg.type);
    }
  }

  /**
   * 기록된 변경 하나를 실행취소(적용 전 내용으로) 또는 다시실행(적용 후 내용으로) 한다.
   * 그 사이 다른 곳에서 문서가 바뀌었으면 덮어쓰지 않고 기록을 비운다.
   */
  private async stepHistory(kind: 'undo' | 'redo'): Promise<void> {
    if (!this.editable) return;
    const [from, to] = kind === 'undo' ? [this.undoStack, this.redoStack] : [this.redoStack, this.undoStack];
    const entry = from.pop();
    let focusLine: number | undefined;
    try {
      if (!entry) return;
      const doc = await this.modifiedDocument();
      const current = doc.getText();
      const expected = kind === 'undo' ? entry.after : entry.before;
      if (current !== expected) {
        this.undoStack = [];
        this.redoStack = [];
        this.panel.webview.postMessage({
          type: 'notice',
          message: '다른 곳에서 문서가 바뀌어 diff 화면에서는 되돌릴 수 없습니다. 원문에서 실행취소(Ctrl+Z)해 주세요.',
        });
        return;
      }
      const target = kind === 'undo' ? entry.before : entry.after;
      if (await replaceMinimal(doc, target)) {
        to.push(entry);
        focusLine = firstChangedLine(current, target);
      } else {
        from.push(entry);
      }
    } catch (e) {
      if (entry) from.push(entry);
      this.panel.webview.postMessage({ type: 'notice', message: `실행취소하지 못했습니다: ${(e as Error).message}` });
    } finally {
      clearTimeout(this.timer);
      await this.render(focusLine);
    }
  }

  private recordChange(before: string, after: string): void {
    if (before === after) return;
    this.undoStack.push({ before, after });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
  }

  private modifiedDocument(): Thenable<vscode.TextDocument> {
    return vscode.workspace.openTextDocument(this.modified.uri!);
  }

  private async applyBlockChange(msg: Extract<FromWebview, { type: 'editBlock' | 'revertBlock' }>): Promise<void> {
    if (!this.editable) return;
    try {
      const doc = await this.modifiedDocument();
      const before = doc.getText();
      const lines = documentLines(doc);
      let next: string[];

      if (msg.type === 'editBlock') {
        // 블록 안에서도 실제로 바뀐 줄만 반영해 원래 서식을 유지한다
        const current = currentBlockSource(lines, msg.block);
        next = replaceBlock(lines, msg.block, applyNormalizedEdit(current, msg.prevNorm, msg.nextNorm));
      } else if (msg.kind === 'added' && msg.block) {
        next = replaceBlock(lines, msg.block, '');
      } else if (msg.kind === 'modified' && msg.block && msg.oldSource !== undefined) {
        next = replaceBlock(lines, msg.block, msg.oldSource);
      } else if (msg.kind === 'removed' && msg.oldSource !== undefined) {
        next = insertBlockAfter(lines, msg.prev, msg.oldSource);
      } else {
        return;
      }
      if (await setDocumentLines(doc, next)) this.recordChange(before, doc.getText());
    } catch (e) {
      const message = e instanceof BlockNotFoundError ? e.message : `변경을 반영하지 못했습니다: ${(e as Error).message}`;
      this.panel.webview.postMessage({ type: 'editFailed', message });
    } finally {
      // 변경이 없더라도 webview 의 편집 상태를 정리하도록 즉시 다시 그린다
      clearTimeout(this.timer);
      await this.render();
    }
  }

  private scheduleRender(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.render(), 300);
  }

  /** focusLine: 실행취소/다시실행으로 바뀐 줄. webview 가 그 블록으로 스크롤해 보여준다 */
  private async render(focusLine?: number): Promise<void> {
    try {
      const modifiedDoc = this.editable ? await this.modifiedDocument() : undefined;
      const [oldText, newText] = await Promise.all([
        this.original.load(),
        modifiedDoc ? modifiedDoc.getText() : this.modified.load(),
      ]);
      const result = diffMarkdown(oldText, newText);
      const defaultView = vscode.workspace.getConfiguration('mdPreviewEditor').get<string>('diff.defaultView', 'inline');
      this.panel.webview.postMessage({
        type: 'render',
        ...result,
        leftLabel: this.original.label,
        rightLabel: this.modified.label,
        view: this.context.globalState.get<string>(DiffPanel.VIEW_KEY, defaultView),
        canOpenSource: !!this.modified.uri,
        editable: this.editable,
        dirty: modifiedDoc?.isDirty ?? false,
        language: vscode.env.language,
        history: { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 },
        focusLine,
      });
    } catch (e) {
      this.panel.webview.postMessage({ type: 'error', message: (e as Error).message });
    }
  }

  private dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
    void this.warnIfUnsaved();
  }

  /** diff 화면에서만 편집하고 저장하지 않은 채 닫으면, 다른 탭에 열려 있지 않은 경우 저장 여부를 묻는다 */
  private async warnIfUnsaved(): Promise<void> {
    if (!this.editable) return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === this.modified.uri!.toString());
    if (!doc?.isDirty) return;
    const uri = doc.uri.toString();
    const openInTab = vscode.window.tabGroups.all.some((g) =>
      g.tabs.some((t) => {
        const input = t.input;
        return (
          ((input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) && input.uri.toString() === uri) ||
          (input instanceof vscode.TabInputTextDiff && input.modified.toString() === uri)
        );
      }),
    );
    if (openInTab) return;
    const choice = await vscode.window.showWarningMessage(
      `${path.basename(doc.uri.path)} 에 저장하지 않은 변경 사항이 있습니다.`,
      '저장',
      '파일 열기',
    );
    if (choice === '저장') await doc.save();
    else if (choice === '파일 열기') await vscode.window.showTextDocument(doc);
  }
}
