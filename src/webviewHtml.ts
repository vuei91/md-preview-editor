import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

export interface WebviewPageOptions {
  title: string;
  script: string;
  styles: string[];
  body: string;
  /** 문서 내 상대경로 이미지가 해석될 기준 폴더 */
  baseDir?: vscode.Uri;
}

export function localResourceRoots(extensionUri: vscode.Uri, ...extra: Array<vscode.Uri | undefined>): vscode.Uri[] {
  const roots = [vscode.Uri.joinPath(extensionUri, 'dist')];
  for (const folder of vscode.workspace.workspaceFolders ?? []) roots.push(folder.uri);
  for (const uri of extra) if (uri) roots.push(uri);
  return roots;
}

export function dirOf(uri: vscode.Uri): vscode.Uri | undefined {
  return uri.scheme === 'file' ? vscode.Uri.joinPath(uri, '..') : undefined;
}

export function buildWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, opts: WebviewPageOptions): string {
  const nonce = randomBytes(16).toString('base64');
  const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', name));
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: http: data: blob:`,
    `media-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  const base = opts.baseDir ? `<base href="${webview.asWebviewUri(opts.baseDir).toString().replace(/\/?$/, '/')}">` : '';

  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${base}
  ${opts.styles.map((s) => `<link rel="stylesheet" href="${asset(s)}">`).join('\n  ')}
  <title>${opts.title}</title>
</head>
<body>
  ${opts.body}
  <script nonce="${nonce}" src="${asset(opts.script)}"></script>
</body>
</html>`;
}
