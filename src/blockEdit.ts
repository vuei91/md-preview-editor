/**
 * diff 화면에서의 블록 단위 편집 / 되돌리기.
 * 문서를 줄 배열로 다루는 순수 함수들이라 vscode 에 의존하지 않는다.
 *
 * diff 를 계산한 뒤 문서가 바뀌었을 수 있으므로, 줄 번호만 믿지 않고
 * 블록 원문으로 위치를 다시 확인한다 (기록된 위치 → 문서 전체에서 유일하게 일치하는 위치 순).
 */

export interface BlockRef {
  range: [number, number];
  source: string;
}

export class BlockNotFoundError extends Error {
  constructor() {
    super('블록 위치를 찾을 수 없습니다. 문서가 그 사이 변경된 것 같습니다. diff 를 다시 계산했으니 다시 시도해 주세요.');
  }
}

/** 블록의 현재 줄 범위 [시작, 끝) */
export function locateBlock(lines: string[], block: BlockRef): [number, number] {
  const src = block.source.split('\n');
  const len = src.length;
  const matchAt = (s: number) =>
    s >= 0 &&
    s + len <= lines.length &&
    src.every((line, k) => (k === len - 1 ? lines[s + k].trimEnd() === line : lines[s + k] === line));

  if (matchAt(block.range[0])) return [block.range[0], block.range[0] + len];
  let found = -1;
  for (let s = 0; s + len <= lines.length; s++) {
    if (!matchAt(s)) continue;
    if (found >= 0) throw new BlockNotFoundError(); // 여러 곳에서 일치하면 어디인지 알 수 없다
    found = s;
  }
  if (found < 0) throw new BlockNotFoundError();
  return [found, found + len];
}

/** 블록을 새 내용으로 교체한다. 내용이 비어 있으면 블록과 그 뒤 빈 줄 하나를 지운다 */
export function replaceBlock(lines: string[], block: BlockRef, text: string): string[] {
  let [start, end] = locateBlock(lines, block);
  const body = text.replace(/\s+$/, '');
  if (!body) {
    if (end < lines.length - 1 && lines[end].trim() === '') end++;
    else if (start > 0 && lines[start - 1].trim() === '') start--;
    return [...lines.slice(0, start), ...lines.slice(end)];
  }
  return [...lines.slice(0, start), ...body.split('\n'), ...lines.slice(end)];
}

/** prev 블록 바로 뒤(없으면 문서 맨 앞)에 새 블록을 빈 줄로 구분해 삽입한다 */
export function insertBlockAfter(lines: string[], prev: BlockRef | undefined, text: string): string[] {
  const body = text.replace(/\s+$/, '').split('\n');
  if (!prev) {
    // 문서 맨 앞
    return [...body, '', ...lines];
  }
  const [, end] = locateBlock(lines, prev);
  return [...lines.slice(0, end), '', ...body, ...lines.slice(end)];
}

export function currentBlockSource(lines: string[], block: BlockRef): string {
  const [start, end] = locateBlock(lines, block);
  return lines.slice(start, end).join('\n');
}
