/**
 * 표 열 폭 자동 계산 (편집기 / diff 화면 공용).
 *
 * 브라우저 기본(auto) 표 레이아웃은 넓은 표에서 열 폭을 내용 비율대로 대충 나눠서,
 * 짧은 열은 남고 긴 설명 열은 좁아져 행이 길게 늘어나기 쉽다.
 *
 * 행 높이는 그 행에서 줄 수가 가장 많은 셀이 정한다. 그래서 셀 글자를 직접 재서
 * 셀마다 폭에 따른 줄 수를 추정하고, 표 전체 높이(행마다 가장 많은 줄 수의 합)가
 * 가장 작아지도록 폭을 조금씩 나눠 준다(매번 높이를 가장 많이 줄이는 열에 준다).
 * 단, 가장 긴 단어가 잘리지 않는 폭보다 좁히지 않는다.
 * 그러고도 폭이 남으면 열 폭 비율대로 나눠 표가 사용 가능한 폭을 꽉 채우게 한다.
 */

/** 어떤 열이든 최소 폭 */
export const MIN_COL = 48;
/** 글이 있는 열은 (한 줄 폭이 이보다 넓다면) 이 폭보다 좁히지 않는다 */
const SOFT_MIN = 64;
/** 셀보다 긴 단어를 잘라야 할 때의 벌점 (줄 수 단위). 가능하면 단어를 자르지 않는 폭을 고르게 한다 */
const BREAK_PENALTY = 0.4;

/** 한 줄(문단 또는 줄바꿈 단위)을 줄바꿈할 수 있는 곳(공백, 하이픈·슬래시 뒤)으로 나눈 조각들 */
interface Line {
  /** 조각별 글자 폭 */
  words: number[];
  /** 조각 앞에 붙는 폭 (공백이면 공백 폭, 하이픈 뒤 조각이면 0) */
  glue: number[];
  /** 줄 전체 폭 */
  width: number;
}

interface Cell {
  lines: Line[];
  /** 여백 + 테두리 */
  pad: number;
}

export interface ColumnStats {
  cols: number;
  /** 열별 최소 폭 (여백 포함) */
  lo: number[];
  /** 열별 한 줄로 다 보이는 폭 (가장 긴 줄, 여백 포함) */
  hi: number[];
  /** rows[r][c] = 그 셀 */
  rows: Cell[][];
}

/**
 * 셀의 줄들. 편집기(ProseMirror) 셀은 문단(<p>)마다, 그 안에서는 <br> 마다 한 줄이다.
 * 빈 문단도 한 줄을 차지한다. innerText 는 문단 사이에 빈 줄을 덧붙이므로 문단별로 읽는다.
 */
function cellLines(cell: HTMLTableCellElement): string[] {
  const paragraphs = Array.from(cell.children).filter((e) => e.tagName === 'P') as HTMLElement[];
  const split = (text: string) => text.replace(/\n$/, '').split('\n');
  if (paragraphs.length === 0) return split(cell.innerText ?? cell.textContent ?? '');
  return paragraphs.flatMap((p) => split(p.innerText ?? p.textContent ?? ''));
}

let ctx: CanvasRenderingContext2D | null | undefined;

function textWidth(text: string, font: string): number {
  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return text.length * 8;
  ctx.font = font;
  return ctx.measureText(text).width;
}

const px = (v: string) => parseFloat(v) || 0;

/**
 * 표들의 셀 글자를 잰다. 여러 표를 넘기면(side-by-side 좌우) 같은 열끼리 합쳐서 잰다.
 * 열 수가 다른 표가 섞여 있거나 열이 없으면 undefined.
 * 열 수가 다른 행(diff 의 빈 자리 행 등 colspan 행)은 건너뛴다.
 */
export function measureColumns(tables: HTMLTableElement[]): ColumnStats | undefined {
  const cols = tables[0]?.rows[0]?.cells.length ?? 0;
  if (cols === 0 || tables.some((t) => (t.rows[0]?.cells.length ?? 0) !== cols)) return undefined;

  const hi = new Array<number>(cols).fill(MIN_COL);
  const rows: Cell[][] = [];

  for (const table of tables) {
    for (const row of Array.from(table.rows)) {
      if (row.cells.length !== cols) continue;
      rows.push(
        Array.from(row.cells).map((cell, c): Cell => {
          const s = getComputedStyle(cell);
          const font = `${s.fontStyle} ${s.fontWeight} ${s.fontSize} ${s.fontFamily}`;
          const pad = px(s.paddingLeft) + px(s.paddingRight) + px(s.borderLeftWidth) + px(s.borderRightWidth) + 2;
          const space = textWidth(' ', font);
          const lines = cellLines(cell).map((line): Line => {
            const t = line.trim();
            const words: number[] = [];
            const glue: number[] = [];
            if (t) {
              t.split(/\s+/).forEach((part, k) => {
                // 하이픈·슬래시 뒤에서도 줄이 바뀔 수 있다
                part.split(/(?<=[-/])/).forEach((piece, j) => {
                  words.push(textWidth(piece, font));
                  glue.push(j > 0 ? 0 : k > 0 ? space : 0);
                });
              });
            }
            const width = t ? textWidth(t, font) : 0;
            hi[c] = Math.max(hi[c], Math.ceil(width + pad));
            return { words, glue, width };
          });
          return { lines, pad };
        }),
      );
    }
  }

  // 긴 단어는 최소 폭으로 강제하지 않는다. 자르면 벌점을 받아 가능하면 자르지 않는 쪽이 골라진다
  const lo = hi.map((h) => Math.min(h, SOFT_MIN));
  return { cols, lo, hi, rows };
}

/**
 * 폭 width 인 셀에서 이 줄들이 차지하는 [줄 수, 연속값(동점일 때 비교용), 잘린 단어 수].
 * 브라우저처럼 단어를 하나씩 채우다 안 들어가면 줄을 바꾼다 (한글도 공백 단위로 줄이 바뀐다).
 * 셀보다 긴 단어는 셀 폭마다 잘린다 (overflow-wrap: anywhere).
 */
export function linesAt(cell: Cell, width: number): [number, number, number] {
  const inner = Math.max(width - cell.pad, 1);
  let n = 0;
  let x = 0;
  let broken = 0;
  for (const line of cell.lines) {
    x += line.width / inner;
    if (line.width <= inner) {
      n += 1;
      continue;
    }
    let count = 1;
    let used = 0;
    for (let k = 0; k < line.words.length; k++) {
      const w = line.words[k];
      const need = used === 0 ? w : used + line.glue[k] + w;
      if (need <= inner) {
        used = need;
        continue;
      }
      if (used > 0) count++;
      if (w > inner) {
        broken++;
        count += Math.ceil(w / inner) - 1;
        used = w % inner || inner;
      } else {
        used = w;
      }
    }
    n += count;
  }
  return [n, x, broken];
}

/** 동점일 때(행 높이가 같을 때) 연속값으로 비교하기 위한 가중치 */
const TIE = 0.001;
/** 열 사이에서 한 번에 옮겨 보는 폭. 큰 폭부터 시도해 점점 줄인다 */
const MOVES = [96, 48, 24, 12, 6];
const MAX_ITER = 600;

/**
 * 열 폭을 정한다.
 * - 다 한 줄로 들어가면 한 줄 폭에서 시작한다
 * - 최소 폭만으로도 넘치면 최소 폭 (표가 available 보다 넓어져 가로 스크롤)
 * - 그 사이면 initial(브라우저 기본 배치의 열 폭)에서 시작해, 두 열 사이에서 폭을 옮겼을 때
 *   표 전체 높이(행마다 가장 많은 줄 수의 합)가 줄어드는 경우에만 옮긴다.
 *   높이가 줄 때만 옮기므로 시작점(브라우저 기본)보다 나빠지지 않는다.
 * - 최소 폭만으로도 넘치는 경우가 아니면, 마지막에 남는 폭을 나눠 주어 표가 available 을 꽉 채운다
 */
export function planWidths(stats: ColumnStats, available: number, initial?: number[]): number[] {
  const { cols, hi, rows } = stats;
  const sum = (ws: number[]) => ws.reduce((a, b) => a + b, 0);
  if (sum(hi) <= available) return stretch(hi, available);

  const lo = stats.lo;
  if (sum(lo) >= available) return [...lo];

  // 시작점: 브라우저 배치(없으면 한 줄 폭 비율)를 available 에 맞춰 늘이거나 줄인 뒤 [최소, 한 줄] 로 자른다
  const start = initial?.length === cols && sum(initial) > 0 ? initial : hi;
  const scale = available / sum(start);
  const widths = start.map((w, c) => Math.min(hi[c], Math.max(lo[c], Math.round(w * scale))));
  /** 아직 어느 열에도 주지 않은 폭 (자르면서 남은 폭). 자르느라 넘쳤으면 여유가 큰 열부터 되돌린다 */
  let spare = available - sum(widths);
  while (spare < 0) {
    let c = -1;
    for (let k = 0; k < cols; k++) if (widths[k] - lo[k] > 0 && (c < 0 || widths[k] - lo[k] > widths[c] - lo[c])) c = k;
    if (c < 0) break;
    const back = Math.min(widths[c] - lo[c], -spare);
    widths[c] -= back;
    spare += back;
  }

  // 열별 줄 수 캐시: 폭이 바뀔 때만 다시 센다
  const cache = new Map<string, { n: number[]; extra: number }>();
  const column = (c: number, w: number) => {
    const key = `${c}:${w}`;
    let v = cache.get(key);
    if (!v) {
      const n: number[] = [];
      // 열 전체의 부가 비용: 잘린 단어 벌점 + 동점 비교용 연속값
      let extra = 0;
      for (const row of rows) {
        const [nn, xx, broken] = linesAt(row[c], w);
        n.push(nn);
        extra += BREAK_PENALTY * broken + TIE * xx;
      }
      v = { n, extra };
      cache.set(key, v);
    }
    return v;
  };
  const current = widths.map((w, c) => column(c, w));

  /** 열 a 폭을 da 만큼, 열 b 폭을 db 만큼 바꿨을 때의 표 전체 높이 (a/b 가 -1 이면 해당 없음) */
  const costWith = (a: number, wa: number, b: number, wb: number) => {
    const ca = a >= 0 ? column(a, wa) : undefined;
    const cb = b >= 0 ? column(b, wb) : undefined;
    let total = 0;
    for (let r = 0; r < rows.length; r++) {
      let max = 0;
      for (let c = 0; c < cols; c++) {
        const lines = c === a ? ca!.n[r] : c === b ? cb!.n[r] : current[c].n[r];
        if (lines > max) max = lines;
      }
      total += max;
    }
    for (let c = 0; c < cols; c++) total += c === a ? ca!.extra : c === b ? cb!.extra : current[c].extra;
    return total;
  };

  let cost = costWith(-1, 0, -1, 0);
  let iter = 0;
  for (const delta of MOVES) {
    for (; iter < MAX_ITER; iter++) {
      let best: { a: number; wa: number; b: number; wb: number; cost: number } | undefined;
      // a = -1 은 남은 폭(spare)에서 가져오는 경우
      for (let a = -1; a < cols; a++) {
        const give = a < 0 ? Math.min(delta, spare) : Math.min(delta, widths[a] - lo[a]);
        if (give <= 0) continue;
        for (let b = 0; b < cols; b++) {
          if (b === a) continue;
          const take = Math.min(give, hi[b] - widths[b]);
          if (take <= 0) continue;
          const c2 = costWith(a, a < 0 ? 0 : widths[a] - take, b, widths[b] + take);
          if (c2 < cost - 1e-9 && (!best || c2 < best.cost)) {
            best = { a, wa: a < 0 ? 0 : widths[a] - take, b, wb: widths[b] + take, cost: c2 };
          }
        }
      }
      if (!best) break;
      if (best.a < 0) spare -= best.wb - widths[best.b];
      else {
        widths[best.a] = best.wa;
        current[best.a] = column(best.a, best.wa);
      }
      widths[best.b] = best.wb;
      current[best.b] = column(best.b, best.wb);
      cost = best.cost;
    }
  }
  return stretch(widths, available);
}

/** 남는 폭을 열 폭 비율대로 나눠 준다. 열이 넓어지기만 하므로 줄 수는 늘지 않는다 */
function stretch(widths: number[], available: number): number[] {
  const total = widths.reduce((a, b) => a + b, 0);
  const spare = Math.floor(available - total);
  if (spare <= 0 || total <= 0) return [...widths];
  const out = widths.map((w) => w + Math.floor((spare * w) / total));
  out[out.length - 1] += total + spare - out.reduce((a, b) => a + b, 0);
  return out;
}
