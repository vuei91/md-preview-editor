import * as vscode from 'vscode';
import { replaceMinimal } from './documentEdit';
import { applyNormalizedEdit } from './preserveFormat';
import { buildWebviewHtml, dirOf, localResourceRoots } from './webviewHtml';

type FromWebview =
  | { type: 'ready' }
  | { type: 'edit'; prev: string; next: string; syncId: number }
  | { type: 'command'; command: string };

/**
 * .md 파일을 Toast UI Editor(WYSIWYG) 기반의 "편집 가능한 미리보기"로 연다.
 * 실제 데이터는 VS Code 의 TextDocument 이므로 저장/되돌리기/더티 표시/텍스트 에디터와의 동기화가 그대로 동작한다.
 */
export class MarkdownEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'mdPreviewEditor.editor';

  /** 가장 최근에 활성화된 커스텀 에디터의 문서 */
  activeUri: vscode.Uri | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  static register(context: vscode.ExtensionContext, provider: MarkdownEditorProvider): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(MarkdownEditorProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: true,
    });
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const { extensionUri } = this.context;
    const baseDir = dirOf(document.uri);
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: localResourceRoots(extensionUri, baseDir),
    };
    panel.webview.html = buildWebviewHtml(panel.webview, extensionUri, {
      title: 'Markdown Preview Editor',
      script: 'editor.js',
      styles: ['toastui-editor.css', 'toastui-editor-dark.css', 'editor.css', 'search.css'],
      body: '<div id="editor"></div>',
      baseDir,
    });

    /** 이 패널이 직접 적용한 편집 결과. 그로 인한 변경 이벤트는 webview 로 되돌려 보내지 않는다 */
    let selfEditText: string | undefined;
    let editQueue: Promise<void> = Promise.resolve();
    /** webview 에 문서 전체를 보낼 때마다 증가. 이 패널 자신의 편집으로는 증가하지 않는다 */
    let syncId = 0;
    const toLf = (s: string) => s.replace(/\r\n/g, '\n');

    const postUpdate = () => {
      panel.webview.postMessage({ type: 'update', text: toLf(document.getText()), syncId: ++syncId });
    };

    const changeSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString() || e.contentChanges.length === 0) return;
      if (selfEditText !== undefined && document.getText() === selfEditText) return;
      selfEditText = undefined;
      postUpdate();
    });

    const messageSub = panel.webview.onDidReceiveMessage((msg: FromWebview) => {
      switch (msg.type) {
        case 'ready': {
          const config = vscode.workspace.getConfiguration('mdPreviewEditor');
          panel.webview.postMessage({
            type: 'init',
            text: toLf(document.getText()),
            syncId: ++syncId,
            mode: config.get<string>('editMode', 'wysiwyg'),
            language: vscode.env.language,
          });
          break;
        }
        case 'edit':
          // 편집은 순서대로 하나씩 적용한다 (앞선 편집이 반영된 문서를 기준으로 패치해야 하므로)
          editQueue = editQueue.then(async () => {
            const current = document.getText();
            let next = applyNormalizedEdit(current, msg.prev, msg.next);
            if (document.eol === vscode.EndOfLine.CRLF) next = next.replace(/\r?\n/g, '\r\n');
            if (next !== current) {
              selfEditText = next;
              await replaceMinimal(document, next);
            }
            // webview 가 모르는 외부 변경 위에 병합됐다면 병합 결과를 다시 보내 화면을 맞춘다
            if (msg.syncId !== syncId) postUpdate();
          }).catch((err) => {
            vscode.window.showErrorMessage(`편집 내용을 반영하지 못했습니다: ${(err as Error).message}`);
          });
          break;
        case 'command':
          vscode.commands.executeCommand(msg.command, document.uri);
          break;
      }
    });

    const viewStateSub = panel.onDidChangeViewState(() => {
      if (panel.active) this.activeUri = document.uri;
    });
    if (panel.active) this.activeUri = document.uri;

    panel.onDidDispose(() => {
      changeSub.dispose();
      messageSub.dispose();
      viewStateSub.dispose();
      if (this.activeUri?.toString() === document.uri.toString()) this.activeUri = undefined;
    });
  }
}
