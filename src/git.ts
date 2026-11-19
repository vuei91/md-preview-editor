import { execFile } from 'node:child_process';
import * as path from 'node:path';

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr.trim() || err.message));
      else resolve(stdout);
    });
  });
}

/** 지정한 리비전의 파일 내용을 가져온다. 해당 리비전에 파일이 없으면 빈 문자열 */
export async function showFileAtRevision(fsPath: string, revision: string): Promise<string> {
  const cwd = path.dirname(fsPath);
  // `<rev>:./<name>` 는 cwd 기준 상대 경로로 해석된다
  const spec = `${revision}:./${path.basename(fsPath)}`;
  try {
    return await git(['show', spec], cwd);
  } catch (e) {
    const msg = (e as Error).message;
    if (/does not exist|exists on disk, but not in/i.test(msg)) return '';
    throw e;
  }
}

/** 최근 커밋 목록 (리비전 선택용) */
export async function recentCommits(fsPath: string, count = 30): Promise<Array<{ hash: string; subject: string; date: string }>> {
  const out = await git(
    ['log', `-n${count}`, '--format=%h%x1f%s%x1f%ar', '--', path.basename(fsPath)],
    path.dirname(fsPath),
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, date] = line.split('\x1f');
      return { hash, subject, date };
    });
}
