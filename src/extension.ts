import * as vscode from 'vscode';
import * as path from 'node:path';
import { MarkdownEditorProvider } from './editorProvider';
import { DiffPanel, documentSide, staticSide } from './diffPanel';
import { recentCommits, showFileAtRevision } from './git';

const MD_EXT = /\.(md|markdown)$/i;

export function activate(context: vscode.ExtensionContext): void {
  const provider = new MarkdownEditorProvider(context);

  /** 명령 인자 → 활성 탭 → 활성 텍스트 에디터 순으로 대상 문서를 찾는다 */
  const resolveUri = (arg?: unknown): vscode.Uri | undefined => {
    if (arg instanceof vscode.Uri) return arg;
    const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom) return input.uri;
    if (input instanceof vscode.TabInputTextDiff) return input.modified;
    return provider.activeUri ?? vscode.window.activeTextEditor?.document.uri;
  };

  const requireMarkdown = (arg?: unknown): vscode.Uri | undefined => {
    const uri = resolveUri(arg);
    if (!uri || !MD_EXT.test(uri.path)) {
      vscode.window.showWarningMessage('Markdown(.md) 파일을 먼저 열어 주세요.');
      return undefined;
    }
    return uri;
  };

  const openDiffWithRevision = async (uri: vscode.Uri, revision: string) => {
    if (uri.scheme !== 'file') {
      vscode.window.showWarningMessage('로컬 파일만 Git 리비전과 비교할 수 있습니다.');
      return;
    }
    try {
      // 미리 한 번 읽어 git 오류(저장소 아님 등)를 바로 알린다
      const text = await showFileAtRevision(uri.fsPath, revision);
      const name = path.basename(uri.fsPath);
      DiffPanel.open(
        context,
        staticSide(`${name} (${revision})`, async () => text),
        documentSide(uri, `${name} (작업 중)`),
        `${name} ↔ ${revision} (미리보기 Diff)`,
      );
    } catch (e) {
      vscode.window.showErrorMessage(`Git에서 파일을 읽지 못했습니다: ${(e as Error).message}`);
    }
  };

  context.subscriptions.push(
    MarkdownEditorProvider.register(context, provider),

    vscode.commands.registerCommand('mdPreviewEditor.open', (arg?: unknown) => {
      const uri = requireMarkdown(arg);
      if (uri) vscode.commands.executeCommand('vscode.openWith', uri, MarkdownEditorProvider.viewType);
    }),

    vscode.commands.registerCommand('mdPreviewEditor.openToSide', (arg?: unknown) => {
      const uri = requireMarkdown(arg);
      if (uri) {
        vscode.commands.executeCommand('vscode.openWith', uri, MarkdownEditorProvider.viewType, vscode.ViewColumn.Beside);
      }
    }),

    vscode.commands.registerCommand('mdPreviewEditor.openAsText', (arg?: unknown) => {
      const uri = requireMarkdown(arg);
      if (uri) vscode.commands.executeCommand('vscode.openWith', uri, 'default');
    }),

    vscode.commands.registerCommand('mdPreviewEditor.diffWithHead', (arg?: unknown) => {
      const uri = requireMarkdown(arg);
      if (uri) return openDiffWithRevision(uri, 'HEAD');
    }),

    vscode.commands.registerCommand('mdPreviewEditor.diffWithRevision', async (arg?: unknown) => {
      const uri = requireMarkdown(arg);
      if (!uri || uri.scheme !== 'file') return;

      type Item = vscode.QuickPickItem & { revision?: string };
      let items: Item[] = [];
      try {
        items = (await recentCommits(uri.fsPath)).map((c) => ({
          label: c.hash,
          description: c.subject,
          detail: c.date,
          revision: c.hash,
        }));
      } catch {
        // 저장소가 아니면 직접 입력만 가능
      }
      const custom: Item = { label: '$(edit) 리비전 직접 입력...', alwaysShow: true };
      const picked = await vscode.window.showQuickPick<Item>([custom, ...items], {
        placeHolder: '비교할 커밋을 선택하세요 (이 파일을 변경한 최근 커밋)',
        matchOnDescription: true,
      });
      if (!picked) return;
      const revision =
        picked.revision ??
        (await vscode.window.showInputBox({ prompt: '브랜치, 태그 또는 커밋 해시', value: 'HEAD~1' }));
      if (revision) await openDiffWithRevision(uri, revision.trim());
    }),

    vscode.commands.registerCommand('mdPreviewEditor.diffWithFile', async (arg?: unknown) => {
      const uri = requireMarkdown(arg);
      if (!uri) return;
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        defaultUri: uri,
        openLabel: '이 파일과 비교',
        filters: { Markdown: ['md', 'markdown'] },
      });
      if (picked?.[0]) DiffPanel.open(context, documentSide(picked[0]), documentSide(uri));
    }),

    vscode.commands.registerCommand('mdPreviewEditor.diffSelected', (arg?: unknown, all?: unknown) => {
      const uris = Array.isArray(all) ? all.filter((u): u is vscode.Uri => u instanceof vscode.Uri) : [];
      if (uris.length !== 2) {
        vscode.window.showWarningMessage('비교할 Markdown 파일을 정확히 2개 선택해 주세요.');
        return;
      }
      DiffPanel.open(context, documentSide(uris[0]), documentSide(uris[1]));
    }),

    vscode.commands.registerCommand('mdPreviewEditor.diffFromDiffEditor', () => {
      const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
      if (!(tab?.input instanceof vscode.TabInputTextDiff)) {
        vscode.window.showWarningMessage('Diff 에디터에서 실행해 주세요.');
        return;
      }
      const { original, modified } = tab.input;
      const name = path.basename(modified.path);
      DiffPanel.open(
        context,
        documentSide(original, `${name} (원본)`),
        documentSide(modified, `${name} (수정본)`),
        `${tab.label} (미리보기 Diff)`,
      );
    }),
  );
}

export function deactivate(): void {}
