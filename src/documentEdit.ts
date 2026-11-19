import * as vscode from 'vscode';

/** 앞뒤 공통 부분을 제외한 구간만 교체해 undo 단위와 다른 에디터의 커서 위치를 보존한다 */
export function replaceMinimal(document: vscode.TextDocument, next: string): Thenable<boolean> {
  const old = document.getText();
  if (old === next) return Promise.resolve(true);
  let start = 0;
  const max = Math.min(old.length, next.length);
  while (start < max && old.charCodeAt(start) === next.charCodeAt(start)) start++;
  let endOld = old.length;
  let endNew = next.length;
  while (endOld > start && endNew > start && old.charCodeAt(endOld - 1) === next.charCodeAt(endNew - 1)) {
    endOld--;
    endNew--;
  }
  const edit = new vscode.WorkspaceEdit();
  edit.replace(
    document.uri,
    new vscode.Range(document.positionAt(start), document.positionAt(endOld)),
    next.slice(start, endNew),
  );
  return vscode.workspace.applyEdit(edit);
}

export function documentLines(document: vscode.TextDocument): string[] {
  return document.getText().split(/\r?\n/);
}

/** 줄 배열로 문서 전체를 갱신한다 (문서의 줄바꿈 형식 유지) */
export function setDocumentLines(document: vscode.TextDocument, lines: string[]): Thenable<boolean> {
  const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
  return replaceMinimal(document, lines.join(eol));
}
