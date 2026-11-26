import assert from 'node:assert/strict';
import { diffMarkdown, diffHtml } from '../src/markdownDiff';
import { applyNormalizedEdit, referencesOf } from '../src/preserveFormat';
import { BlockNotFoundError, currentBlockSource, insertBlockAfter, replaceBlock } from '../src/blockEdit';
import { linesAt, planWidths } from '../src/webview/tableWidths';

let failed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n    ${(e as Error).message.split('\n').join('\n    ')}`);
  }
}

console.log('markdownDiff');

test('동일 문서는 모두 equal', () => {
  const src = '# 제목\n\n본문입니다.\n\n- a\n- b\n';
  const r = diffMarkdown(src, src);
  assert.deepEqual(r.stats, { added: 0, removed: 0, modified: 0 });
  assert.ok(r.rows.every((x) => x.kind === 'equal'));
});

test('문단 단어 수정은 modified + ins/del', () => {
  const r = diffMarkdown('# T\n\n사과를 좋아합니다.\n', '# T\n\n바나나를 좋아합니다.\n');
  assert.deepEqual(r.stats, { added: 0, removed: 0, modified: 1 });
  const row = r.rows.find((x) => x.kind === 'modified')!;
  assert.match(row.inline, /<del>사과를<\/del>/);
  assert.match(row.inline, /<ins>바나나를<\/ins>/);
  assert.doesNotMatch(row.left, /<ins>/);
  assert.doesNotMatch(row.right, /<del>/);
});

test('블록 추가/삭제', () => {
  const r = diffMarkdown('A\n\nB\n\nC\n', 'A\n\nC\n\n## 새 섹션\n');
  assert.equal(r.stats.removed, 1);
  assert.equal(r.stats.added, 1);
  assert.deepEqual(
    r.rows.map((x) => x.kind),
    ['equal', 'removed', 'equal', 'added'],
  );
});

test('종류가 다른 블록은 짝짓지 않는다 (문단 → 헤딩)', () => {
  const r = diffMarkdown('제목입니다\n', '# 제목입니다\n');
  assert.deepEqual(r.stats, { added: 1, removed: 1, modified: 0 });
});

test('완전히 다른 내용은 modified 대신 삭제+추가', () => {
  const r = diffMarkdown('하나 둘 셋 넷 다섯\n', '전혀 관계 없는 새로운 문장\n');
  assert.deepEqual(r.stats, { added: 1, removed: 1, modified: 0 });
});

test('리스트 항목 추가 시 리스트 블록이 modified', () => {
  const r = diffMarkdown('- 사과\n- 배\n', '- 사과\n- 배\n- 포도\n');
  assert.equal(r.stats.modified, 1);
  const row = r.rows[0];
  assert.match(row.right, /<li><ins>포도<\/ins><\/li>/);
});

test('서식 변경(굵게)은 태그가 살아있다', () => {
  const r = diffMarkdown('중요한 내용\n', '**중요한** 내용\n');
  const row = r.rows[0];
  assert.equal(row.kind, 'modified');
  assert.match(row.right, /<strong>/);
});

test('참조형 링크가 블록 단위 렌더링에서도 해석된다', () => {
  const src = '[링크][ref] 입니다\n\n[ref]: https://example.com\n';
  const r = diffMarkdown(src, src);
  assert.match(r.rows[0].inline, /href="https:\/\/example.com"/);
});

test('코드블록 수정은 공백을 보존한다', () => {
  const r = diffMarkdown('```js\nconst a = 1;\n  return a;\n```\n', '```js\nconst a = 2;\n  return a;\n```\n');
  const row = r.rows[0];
  assert.equal(row.kind, 'modified');
  assert.match(row.inline, /\n {2}return/);
  assert.match(row.inline, /<del>1<\/del><ins>2<\/ins>/);
});

test('표: 행 단위로 바뀐 행만 강조한다', () => {
  const t1 = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n';
  const t2 = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 9 |\n';
  const t3 = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n';
  const r2 = diffMarkdown(t1, t2);
  assert.deepEqual(r2.stats, { added: 0, removed: 0, modified: 1 });
  assert.match(r2.rows[0].inline, /<tr class="tr-same">/);
  assert.match(r2.rows[0].inline, /<tr class="tr-mod"[^>]*>[\s\S]*<del>4<\/del><ins>9<\/ins>/);
  const r3 = diffMarkdown(t1, t3);
  assert.deepEqual(r3.stats, { added: 0, removed: 0, modified: 1 });
  assert.equal((r3.rows[0].inline.match(/tr-ins/g) ?? []).length, 1);
  assert.match(r3.rows[0].left, /tr-empty/, 'side-by-side 왼쪽에는 빈 행');
});

test('표: 바뀐 행에 줄 단위 되돌리기 정보(data-revert)가 들어간다', () => {
  const t1 = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |\n';
  // 수정(3|4 → 3|9), 추가(5|6)
  const t2 = '| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 9 |\n| 5 | 6 |\n';
  const mod = diffMarkdown(t1, t2).rows[0].inline;
  assert.match(mod, /data-revert="mod" data-old-line="\| 3 \| 4 \|" data-new-line="\| 3 \| 9 \|"/);
  assert.match(mod, /data-revert="ins" data-new-line="\| 5 \| 6 \|"/);

  // 삭제(3|4 제거): 삭제 행에는 원본 줄과 바로 앞 수정본 줄(data-after)이 들어간다
  const t3 = '| a | b |\n|---|---|\n| 1 | 2 |\n';
  const del = diffMarkdown(t1, t3).rows[0].inline;
  assert.match(del, /data-revert="del" data-old-line="\| 3 \| 4 \|" data-after="\| 1 \| 2 \|"/);
});

test('렌더링이 같은 변경(이스케이프·리스트 기호·표 패딩)은 변경으로 보지 않는다', () => {
  const a = '절차: 1. 다이얼로그 [No] 클릭\n\n* 항목\n\n|a|b|\n|-|-|\n|1. 단계|2|\n';
  const b = '절차: 1\\. 다이얼로그 \\[No\\] 클릭\n\n- 항목\n\n| a | b |\n| --- | --- |\n| 1\\. 단계 | 2 |\n';
  const r = diffMarkdown(a, b);
  assert.deepEqual(r.stats, { added: 0, removed: 0, modified: 0 });
});

test('큰 표의 셀 하나 변경: 한 행만 tr-mod, 나머지는 tr-same', () => {
  const rows = Array.from({ length: 40 }, (_, k) => `| TC-${k} | 제목 ${k} | 1. 절차<br>2. 확인 | 결과 ${k} |`);
  const head = '| ID | 제목 | 절차 | 결과 |\n|---|---|---|---|\n';
  const a = head + rows.join('\n') + '\n';
  const b = head + rows.map((r, k) => (k === 20 ? r.replace('결과 20', '결과 이십') : r)).join('\n') + '\n';
  const html = diffMarkdown(a, b).rows[0].inline;
  assert.equal((html.match(/tr-mod/g) ?? []).length, 1);
  assert.equal((html.match(/tr-same/g) ?? []).length, 39);
  assert.equal((html.match(/tr-(ins|del)/g) ?? []).length, 0);
});

test('HTML 엔티티는 쪼개지지 않는다', () => {
  const d = diffHtml('<p>a &amp; b</p>', '<p>a &amp; c</p>');
  assert.match(d.inline, /&amp;/);
  assert.doesNotMatch(d.inline, /&<|amp<\/?(ins|del)/);
});

test('띄어쓰기만 추가/삭제해도 바뀐 공백을 강조한다', () => {
  const add = diffMarkdown('문장입니다.다음 문장\n', '문장입니다. 다음 문장\n');
  assert.equal(add.stats.modified, 1);
  const row = add.rows[0];
  assert.match(row.right, /입니다\.<ins class="ws"> <\/ins>다음/);
  assert.match(row.inline, /<ins class="ws"> <\/ins>/);
  assert.doesNotMatch(row.left, /<ins|<del/);

  const del = diffMarkdown('foo, bar\n', 'foo,bar\n').rows[0];
  assert.match(del.left, /foo,<del class="ws"> <\/del>bar/);
  assert.match(del.inline, /foo,<del class="ws"> <\/del>bar/);
  assert.doesNotMatch(del.right, /<ins|<del/);
});

test('띄어쓰기 교정(할수 → 할 수)은 단어 전체가 아니라 공백만 강조한다', () => {
  const row = diffMarkdown('그렇게 할수있다고 했다.\n', '그렇게 할 수 있다고 했다.\n').rows[0];
  assert.equal(row.kind, 'modified');
  assert.equal(row.right, '<p>그렇게 할<ins class="ws"> </ins>수<ins class="ws"> </ins>있다고 했다.</p>\n');
  assert.equal(row.left, '<p>그렇게 할수있다고 했다.</p>\n');
  // 글자도 바뀌면 지금처럼 단어 단위
  const mixed = diffMarkdown('그렇게 할수있다고 분명히 말했다.\n', '그렇게 할 수 없다고 분명히 말했다.\n').rows[0];
  assert.equal(mixed.kind, 'modified');
  assert.match(mixed.right, /<ins>[^<]*없다고[^<]*<\/ins>/);
  assert.doesNotMatch(mixed.right, /class="ws"/);
});

test('표 셀의 띄어쓰기 변경도 강조한다', () => {
  const r = diffMarkdown('| a | b |\n|---|---|\n| 가나 | x |\n', '| a | b |\n|---|---|\n| 가 나 | x |\n');
  assert.match(r.rows[0].right, /tr-mod[^>]*>[\s\S]*가<ins class="ws"> <\/ins>나/);
});

test('블록 사이 줄바꿈은 감싸지 않는다', () => {
  const r = diffMarkdown('- a\n- b\n', '- a\n- b\n- c\n').rows[0];
  assert.doesNotMatch(r.right, /<ins class="ws">\n/);
});

test('CRLF 문서', () => {
  const r = diffMarkdown('# A\r\n\r\nB\r\n', '# A\n\nB\n');
  assert.deepEqual(r.stats, { added: 0, removed: 0, modified: 0 });
});

console.log('preserveFormat');

// Toast UI 의 정규화를 흉내낸다: `*` 리스트 → `-`, `__` → `**`, 표 패딩 제거
const normalize = (s: string) =>
  s
    .replace(/^(\s*)\*(\s)/gm, '$1-$2')
    .replace(/__(.+?)__/g, '**$1**')
    .replace(/[ \t]+\|/g, ' |')
    .replace(/\|[ \t]+/g, '| ')
    .replace(/\n+$/, '');

const original = [
  '# 문서',
  '',
  '* 항목 하나',
  '* 항목 둘',
  '',
  '__강조__ 문단입니다.',
  '',
  '|  이름   |  값  |',
  '|---------|------|',
  '|  a      |  1   |',
  '',
  '마지막 문단.',
  '',
].join('\n');

test('한 줄 수정 시 다른 줄의 원래 서식은 유지된다', () => {
  const prev = normalize(original);
  const next = prev.replace('마지막 문단.', '마지막 문단 수정.');
  const out = applyNormalizedEdit(original, prev, next);
  assert.equal(out, original.replace('마지막 문단.', '마지막 문단 수정.'));
});

test('리스트 항목 수정 시 해당 줄만 정규화된다', () => {
  const prev = normalize(original);
  const next = prev.replace('- 항목 둘', '- 항목 둘(수정)');
  const out = applyNormalizedEdit(original, prev, next);
  assert.ok(out.includes('* 항목 하나'), '수정하지 않은 항목은 * 유지');
  assert.ok(out.includes('* 항목 둘(수정)'), '수정한 항목도 원본 리스트 기호(*)를 따른다');
  assert.ok(out.includes('|  이름   |  값  |'), '표 패딩 유지');
  assert.ok(out.endsWith('\n'), '마지막 개행 유지');
});

test('줄 추가', () => {
  const prev = normalize(original);
  const next = prev.replace('마지막 문단.', '마지막 문단.\n\n새 문단.');
  const out = applyNormalizedEdit(original, prev, next);
  assert.equal(out, original.replace('마지막 문단.\n', '마지막 문단.\n\n새 문단.\n'));
});

test('정규화로 줄 구성이 바뀐 문단(soft wrap)을 수정해도 중복되지 않는다', () => {
  const orig = '# A\n\n첫째 줄\n이어지는 줄\n\n* x\n* y\n';
  const prev = '# A\n\n첫째 줄 이어지는 줄\n\n- x\n- y';
  const next = '# A\n\n첫째 줄 이어지는 줄 수정\n\n- x\n- y';
  const out = applyNormalizedEdit(orig, prev, next);
  assert.equal(out, '# A\n\n첫째 줄 이어지는 줄 수정\n\n* x\n* y\n');
});

test('블록 삭제', () => {
  const prev = normalize(original);
  const next = prev.replace('**강조** 문단입니다.\n\n', '');
  const out = applyNormalizedEdit(original, prev, next);
  assert.equal(out, original.replace('__강조__ 문단입니다.\n\n', ''));
});

test('리스트 맨 앞에 항목 추가', () => {
  const prev = normalize(original);
  const next = prev.replace('- 항목 하나', '- 항목 영\n- 항목 하나');
  const out = applyNormalizedEdit(original, prev, next);
  assert.equal(out, original.replace('* 항목 하나', '* 항목 영\n* 항목 하나'));
});

test('줄 안에서도 편집한 부분만 반영한다 (에디터가 넣은 이스케이프 무시)', () => {
  // 실제 Toast UI 동작: __로그인__과 → \_\_로그인\_\_과 로 직렬화
  const orig = '이번 버전에서는 __로그인__과 *회원가입* 화면을 개선했습니다.\n';
  const prev = '이번 버전에서는 \\_\\_로그인\\_\\_과 *회원가입* 화면을 개선했습니다.';
  assert.equal(applyNormalizedEdit(orig, prev, prev + ' 편집 테스트'), orig.replace('니다.', '니다. 편집 테스트'));
  assert.equal(
    applyNormalizedEdit(orig, prev, prev.replace('이번 버전', '지난 버전')),
    orig.replace('이번 버전', '지난 버전'),
  );
});

test('이스케이프가 섞인 줄 안을 고쳐도 원본 표기는 유지된다', () => {
  const orig = '앞 문단\n\n이번 __로그인__과 화면.\n';
  const prev = '앞 문단\n\n이번 \\_\\_로그인\\_\\_과 화면.';
  const next = prev.replace('로그인', '로그아웃');
  assert.equal(applyNormalizedEdit(orig, prev, next), orig.replace('로그인', '로그아웃'));
});

test('내용 변화 없이 이스케이프만 생긴 줄은 원본 유지', () => {
  const orig = '| a | 1. Discard 다이얼로그에서 [No] 클릭 | 1. 다이얼로그 닫힘<br>2. EDIT 모드 유지 (수정 중이던 값 보존) |\n';
  const prev = '| a | 1\\. Discard 다이얼로그에서 \\[No\\] 클릭 | 1\\. 다이얼로그 닫힘<br>2\\. EDIT 모드 유지 \\(수정 중이던 값 보존\\) |';
  // 같은 줄의 다른 셀만 고친 경우: 이스케이프는 원본으로, 고친 부분만 반영
  const next = prev.replace('[No\\] 클릭', '[No\\] 선택');
  assert.equal(applyNormalizedEdit(orig, prev, next), orig.replace('[No] 클릭', '[No] 선택'));
});

test('변경 없음 → 원본 그대로', () => {
  const prev = normalize(original);
  assert.equal(applyNormalizedEdit(original, prev, prev), original);
});

test('CRLF 원본도 패치된다', () => {
  const crlf = original.replace(/\n/g, '\r\n');
  const prev = normalize(original);
  const next = prev.replace('마지막 문단.', '끝.');
  const out = applyNormalizedEdit(crlf, prev, next);
  assert.equal(out, original.replace('마지막 문단.', '끝.'));
});

test('편집기가 직렬화하며 잃은 블록은 다른 곳을 고쳐도 원본 그대로 둔다', () => {
  const orig = '첫 줄\n\n원본에만 있는 숨은 줄\n\n둘째 줄\n';
  const prev = '첫 줄\n\n둘째 줄';
  const next = '첫 줄\n\n둘째 줄 수정';
  assert.equal(applyNormalizedEdit(orig, prev, next), orig.replace('둘째 줄', '둘째 줄 수정'));
});

// 브라우저에서 확인한 실제 Toast UI 출력. HTML 블록, 엔티티, 줄 끝 공백 줄바꿈 등은 직렬화하며 내용을 잃는다
const lossyOrig = [
  '# 제목 ※ ① → ★',
  '',
  '* 항목 하나 **굵게** __밑줄굵게__ _기울임_',
  '+ 다른 기호',
  '1) 번호',
  '',
  '- [ ] 할 일',
  '- [x] 완료',
  '',
  '| A | B |',
  '|:--|--:|',
  '| 1 | 2 |',
  '',
  'A &nbsp; B &lt;tag&gt; &copy; &rarr;',
  '',
  '줄바꿈  ',
  '다음 줄<br>HTML',
  '',
  '***',
  '',
  '<div align="center">',
  '  <b>센터</b>',
  '</div>',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '    들여쓴 코드',
  '',
  'Setext 제목',
  '===',
  '',
  '> 인용 > 기호',
  '',
  '[링크](http://a.com "타이틀") ![img](a.png) <http://auto.link>',
  '',
  '~~취소~~ ~한개~ `코드 *별*` 2 * 3 = 6, a_b_c, 100% #해시 [대괄호]',
  '',
  '각주[^1]',
  '',
  '[^1]: 설명',
  '',
].join('\n');
const lossyPrev = [
  '# 제목 ※ ① → ★',
  '',
  '* 항목 하나 **굵게** **밑줄굵게** *기울임*',
  '',
  '',
  '* 다른 기호',
  '',
  '1. 번호',
  '',
  '* [ ] 할 일',
  '* [x] 완료',
  '',
  '| A | B |',
  '| :--- | ---: |',
  '| 1 | 2 |',
  '',
  String.raw`A ${' '} B \<tag> © →`,
  '',
  '줄바꿈다음 줄',
  'HTML',
  '',
  '***',
  '',
  '<b>센터</b>',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '```',
  '들여쓴 코드',
  '```',
  '',
  'Setext 제목',
  '===',
  '',
  '> 인용 > 기호',
  '',
  '[링크](http://a.com "타이틀") ![img](a.png) [http://auto.link](http://auto.link)',
  '',
  String.raw`~~취소~~ \~한개\~ ` + '`코드 *별*`' + String.raw` 2 \* 3 = 6, a\_b\_c, 100% #해시 [대괄호]`,
  '',
  '각주[^1]',
  '',
  String.raw`\[^1\]: 설명`,
].join('\n');

test('내용을 잃는 문법이 있는 문서: 한 곳을 고쳐도 나머지 기호·서식은 그대로', () => {
  const next = lossyPrev.replace('Setext 제목\n', 'Setext 제목X\n');
  assert.equal(applyNormalizedEdit(lossyOrig, lossyPrev, next), lossyOrig.replace('Setext 제목\n', 'Setext 제목X\n'));
  // 문단 안을 고친 경우도 그 줄만 바뀐다
  const next2 = lossyPrev.replace('# 제목 ※', '# 큰 제목 ※');
  assert.equal(applyNormalizedEdit(lossyOrig, lossyPrev, next2), lossyOrig.replace('# 제목 ※', '# 큰 제목 ※'));
  // 리스트에 항목 추가
  const next3 = lossyPrev.replace('* [x] 완료', '* [x] 완료\n* [ ] 새 일');
  assert.equal(applyNormalizedEdit(lossyOrig, lossyPrev, next3), lossyOrig.replace('- [x] 완료', '- [x] 완료\n- [ ] 새 일'));
});

// 아래 prev/next 는 브라우저에서 확인한 실제 Toast UI 출력 (리스트는 항상 `*`, 항목 사이 빈 줄 없음)
test('리스트 기호 `-` 가 `*` 로 바뀌지 않는다: 빈 줄로 띄운 리스트', () => {
  const orig = '- 첫째 항목\n\n- 둘째 항목\n\n- 셋째 항목\n';
  const prev = '* 첫째 항목\n* 둘째 항목\n* 셋째 항목';
  assert.equal(applyNormalizedEdit(orig, prev, prev + 'X'), orig.replace('셋째 항목', '셋째 항목X'));
  assert.equal(applyNormalizedEdit(orig, prev, prev.replace('첫째 항목', '첫째 항목X')), orig.replace('첫째 항목', '첫째 항목X'));
  const added = applyNormalizedEdit(orig, prev, prev + '\n* 새 항목');
  assert.ok(added.startsWith('- 첫째 항목\n\n- 둘째 항목\n\n- 셋째 항목'), added);
  assert.ok(added.includes('- 새 항목'), added);
  assert.doesNotMatch(added, /^\*/m);
});

test('리스트 기호 `-` 가 `*` 로 바뀌지 않는다: 줄 끝 공백 줄바꿈, &nbsp; 가 있는 리스트', () => {
  const br = '- 첫째 항목  \n  이어지는 줄\n- 둘째 항목\n- 셋째 항목\n';
  const brPrev = '* 첫째 항목이어지는 줄\n* 둘째 항목\n* 셋째 항목';
  assert.equal(applyNormalizedEdit(br, brPrev, brPrev + 'X'), br.replace('셋째 항목', '셋째 항목X'));
  assert.equal(applyNormalizedEdit(br, brPrev, brPrev + '\n* 새 항목'), br + '- 새 항목\n');
  // 줄바꿈이 있는 항목 자체를 고치면 그 항목은 편집기 내용을 따르지만 기호는 `-`
  assert.equal(
    applyNormalizedEdit(br, brPrev, brPrev.replace('줄\n', '줄X\n')),
    '- 첫째 항목이어지는 줄X\n- 둘째 항목\n- 셋째 항목\n',
  );

  const nbsp = '- 첫째 &nbsp; 항목\n- 둘째 항목\n- 셋째 항목\n';
  const nbspPrev = '* 첫째   항목\n* 둘째 항목\n* 셋째 항목';
  assert.equal(applyNormalizedEdit(nbsp, nbspPrev, nbspPrev + '\n* 새 항목'), nbsp + '- 새 항목\n');
});

test('나란히 있는 `*` 리스트와 `-` 리스트는 각자의 기호를 유지한다', () => {
  const orig = '* 별 첫째\n* 별 둘째\n* 셋째 항목\n\n- 대시 첫째\n- 대시 둘째\n';
  const prev = '* 별 첫째\n* 별 둘째\n* 셋째 항목\n\n\n* 대시 첫째\n* 대시 둘째';
  const next = prev.replace('* 셋째 항목\n', '* 셋째 항목\n* 새 항목\n');
  assert.equal(applyNormalizedEdit(orig, prev, next), orig.replace('* 셋째 항목\n', '* 셋째 항목\n* 새 항목\n'));
});

test('편집기가 다시 쓴 줄도 원본의 리스트 기호와 구분선 표기를 따른다 (안전장치 경로)', () => {
  // 원본과 전혀 맞출 수 없어 정규화본 전체로 대체되는 경우
  const orig = '- 하나\n- 둘\n\n---\n\n끝\n';
  const out = applyNormalizedEdit(orig, 'x', '* 하나\n* 둘\n* 셋\n\n***\n\n끝\n\n```\n* 코드 안\n***\n```');
  assert.equal(out, '- 하나\n- 둘\n- 셋\n\n---\n\n끝\n\n```\n* 코드 안\n***\n```\n');
});

test('내용을 잃는 블록 자체를 고치면 그 블록만 편집기 내용으로 바뀐다', () => {
  const next = lossyPrev.replace('줄바꿈다음 줄', '줄바꿈다음 줄 수정');
  const out = applyNormalizedEdit(lossyOrig, lossyPrev, next);
  assert.ok(out.includes('줄바꿈다음 줄 수정\nHTML'), out);
  for (const keep of ['__밑줄굵게__', '+ 다른 기호', '1) 번호', '&nbsp;', '&lt;tag&gt;', '<div align="center">', '<http://auto.link>', '[^1]: 설명']) {
    assert.ok(out.includes(keep), `${keep} 유지\n${out}`);
  }
});

test('새로 쓴 줄에서 렌더링에 영향 없는 이스케이프는 붙이지 않는다', () => {
  const orig = '# 제목\n\n본문.\n';
  const prev = '# 제목\n\n본문.';
  // Toast UI 가 실제로 내보내는 형태
  const next = prev + '\n\n경로는 C:\\\\Users\\\\me, snake\\_case, \\(괄호\\) \\[대괄호\\] 1\\.5배\\!';
  assert.equal(applyNormalizedEdit(orig, prev, next), orig + '\n경로는 C:\\Users\\me, snake_case, (괄호) [대괄호] 1.5배!\n');
});

test('빼면 렌더링이 달라지는 이스케이프는 유지한다', () => {
  const orig = '# 제목\n';
  const prev = '# 제목';
  const next = prev + '\n\n1\\. 리스트 아님\n\n\\# 헤딩 아님\n\n\\*\\*굵게 아님\\*\\* 그리고 \\<span> 태그 아님';
  // 여는 ** 만 이스케이프돼 있으면 닫는 ** 는 그대로 글자다
  assert.equal(applyNormalizedEdit(orig, prev, next), `${next.replace('아님\\*\\*', '아님**')}\n`);
});

test('줄 안에서 고친 부분의 이스케이프만 걷어내고, 원본의 이스케이프는 손대지 않는다', () => {
  const orig = '원본 1\\.5 값\n';
  const prev = '원본 1\\.5 값';
  const next = '원본 1\\.5 값 \\(추가\\)';
  assert.equal(applyNormalizedEdit(orig, prev, next), '원본 1\\.5 값 (추가)\n');
});

test('표 셀의 | 이스케이프는 유지한다', () => {
  const orig = '| a | b |\n| --- | --- |\n| 1 | 2 |\n';
  const prev = '| a | b |\n| --- | --- |\n| 1 | 2 |';
  const next = prev + '\n| x\\|y \\(z\\) | 3 |';
  assert.equal(applyNormalizedEdit(orig, prev, next), orig + '| x\\|y (z) | 3 |\n');
});

test('블록만 편집할 때: 문서의 참조형 링크 정의를 넘기면 \\[foo\\] 를 링크로 바꾸지 않는다', () => {
  const block = '앞 문장\n';
  const next = '앞 문장 \\[foo\\] \\(bar\\)';
  // 정의가 없으면 블록 안에서는 그냥 글자라 걷어낸다
  assert.equal(applyNormalizedEdit(block, '앞 문장', next), '앞 문장 [foo] (bar)\n');
  const refs = referencesOf('# 문서\n\n앞 문장\n\n[foo]: https://example.com\n');
  // 여는 [ 만 이스케이프돼 있어도 링크가 되지 않는다
  assert.equal(applyNormalizedEdit(block, '앞 문장', next, refs), '앞 문장 \\[foo] (bar)\n');
});

test('markdown-it 이 모르는 GFM 문법이 되는 이스케이프는 유지한다 (취소선 ~, 작업 목록, 각주, 알림)', () => {
  const orig = '# 제목\n';
  const prev = '# 제목';
  const next = [
    prev,
    '',
    '\\~취소선 아님\\~ \\(a\\)',
    '',
    '- \\[ \\] 체크박스 아님 \\[링크\\]\\(x\\)',
    '',
    '> 1\\. x',
    '',
    '각주 아님\\[^1\\] 알림 아님 \\[!NOTE\\]',
  ].join('\n');
  const out = applyNormalizedEdit(orig, prev, next);
  assert.ok(out.includes('\\~취소선 아님\\~ (a)'), out);
  // 여는 [ 만 이스케이프돼 있으면 작업 목록이 되지 않는다
  assert.ok(out.includes('- \\[ ] 체크박스 아님'), out);
  assert.ok(out.includes('\\[^1') && out.includes('\\[!NOTE'), out);
});

test('참조형 링크가 있는 문서: 다른 줄을 고쳐도 문서 전체가 정규화되지 않고 정의 줄도 그대로', () => {
  // 브라우저에서 확인한 실제 Toast UI 출력: 참조형 링크를 지원하지 않아 정의 줄을 글자로 보고 이스케이프한다
  const orig = '__강조__ 참조 [foo] 링크.\n\n|  a  |  b  |\n|-----|-----|\n|  1  |  2  |\n\n편집할 문단.\n\n[foo]: https://example.com\n';
  const prev = '**강조** 참조 [foo] 링크.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n\n편집할 문단.\n\n\\[foo\\]: https://example\\.com';
  const next = prev.replace('편집할 문단.', '편집할 문단 수정 (x).');
  assert.equal(applyNormalizedEdit(orig, prev, next), orig.replace('편집할 문단.', '편집할 문단 수정 (x).'));
});

test('참조형 링크가 있는 문서: 참조를 쓰는 줄을 고쳐도 [foo] 는 그대로', () => {
  const orig = '참조 [foo] 링크.\n\n[foo]: https://example.com\n';
  const prev = '참조 [foo] 링크.\n\n\\[foo\\]: https://example\\.com';
  const next = prev.replace('링크.', '링크 수정.');
  assert.equal(applyNormalizedEdit(orig, prev, next), orig.replace('링크.', '링크 수정.'));
});

test('성능: 큰 문서 + 안전장치 경로에서도 빠르다', () => {
  const para = (i: number) => `문단 ${i} 내용 snake\\_case \\(괄호\\) 1\\. 값 \\*별\\* C:\\\\dir`;
  const big = Array.from({ length: 2000 }, (_, i) => para(i)).join('\n\n');
  const t = Date.now();
  applyNormalizedEdit('완전히 다른 원본\n', 'x', big);
  const ms = Date.now() - t;
  console.log(`    (2000문단 ${ms}ms)`);
  assert.ok(ms < 3000);
});

console.log('blockEdit');

const docA = '# 제목\n\n첫 문단입니다.\n\n* 하나\n* 둘\n\n마지막.\n';
const docB = '# 제목\n\n첫 문단을 고쳤습니다.\n\n* 하나\n* 둘\n* 셋\n\n새로 추가한 문단.\n';
const linesOf = (s: string) => s.split('\n');

test('행에 수정본 줄 범위/원문이 들어간다', () => {
  const r = diffMarkdown(docA, docB);
  const lines = linesOf(docB);
  for (const row of r.rows) {
    if (row.newRange) assert.equal(lines.slice(...row.newRange).join('\n').trimEnd(), row.newSource);
  }
  const removed = r.rows.find((x) => x.kind === 'removed')!;
  assert.equal(removed.oldSource, '마지막.');
  assert.equal(removed.prev?.source, '* 하나\n* 둘\n* 셋');
});

test('블록 편집', () => {
  const r = diffMarkdown(docA, docB);
  const row = r.rows.find((x) => x.kind === 'modified' && x.newSource?.startsWith('첫'))!;
  const out = replaceBlock(linesOf(docB), { range: row.newRange!, source: row.newSource! }, '첫 문단을 다시 고쳤습니다.');
  assert.equal(out.join('\n'), docB.replace('첫 문단을 고쳤습니다.', '첫 문단을 다시 고쳤습니다.'));
});

test('되돌리기: modified → 원본, added → 제거, removed → 복원', () => {
  // 실제 화면처럼 하나 되돌릴 때마다 diff 를 다시 계산한다 (아래쪽 변경부터)
  let lines = linesOf(docB);
  for (let step = 0; step < 10; step++) {
    const row = diffMarkdown(docA, lines.join('\n')).rows.filter((x) => x.kind !== 'equal').pop();
    if (!row) break;
    const block = row.newRange ? { range: row.newRange, source: row.newSource! } : undefined;
    if (row.kind === 'modified') lines = replaceBlock(lines, block!, row.oldSource!);
    else if (row.kind === 'added') lines = replaceBlock(lines, block!, '');
    else if (row.kind === 'removed') lines = insertBlockAfter(lines, row.prev, row.oldSource!);
  }
  assert.equal(lines.join('\n'), docA);
});

test('블록 위치가 밀려도 원문으로 다시 찾는다', () => {
  const r = diffMarkdown(docA, docB);
  const row = r.rows.find((x) => x.newSource === '새로 추가한 문단.')!;
  const shifted = linesOf('앞에 끼어든 줄\n\n' + docB);
  const out = replaceBlock(shifted, { range: row.newRange!, source: row.newSource! }, '바뀐 문단.');
  assert.ok(out.join('\n').endsWith('바뀐 문단.\n'));
});

test('블록을 찾을 수 없으면 BlockNotFoundError', () => {
  assert.throws(() => replaceBlock(linesOf(docB), { range: [2, 3], source: '없는 문단' }, 'x'), BlockNotFoundError);
});

test('문서 맨 앞 블록 복원', () => {
  const r = diffMarkdown('# 머리말\n\n본문\n', '본문\n');
  const removed = r.rows.find((x) => x.kind === 'removed')!;
  assert.equal(removed.prev, undefined);
  assert.equal(insertBlockAfter(linesOf('본문\n'), removed.prev, removed.oldSource!).join('\n'), '# 머리말\n\n본문\n');
});

test('블록 편집도 원래 서식을 유지한다 (리스트 기호)', () => {
  const lines = linesOf(docB);
  const block = { range: [4, 7] as [number, number], source: '* 하나\n* 둘\n* 셋' };
  const current = currentBlockSource(lines, block);
  const edited = applyNormalizedEdit(current, '- 하나\n- 둘\n- 셋', '- 하나\n- 둘(수정)\n- 셋');
  assert.equal(edited, '* 하나\n* 둘(수정)\n* 셋');
});

console.log('tableWidths');

/** 글자 폭 8px, 공백 4px 로 가정한 셀 (DOM 없이 planWidths 만 시험) */
function cellOf(text: string, pad = 20) {
  const lines = text.split('\n').map((line) => {
    const parts = line.trim() ? line.trim().split(/\s+/) : [];
    return { words: parts.map((p) => p.length * 8), glue: parts.map((_, k) => (k > 0 ? 4 : 0)), width: line.trim().length * 8 };
  });
  return { lines, pad };
}
function statsOf(table: string[][]) {
  const rows = table.map((r) => r.map((t) => cellOf(t)));
  const cols = table[0].length;
  const hi = Array.from({ length: cols }, (_, c) =>
    Math.max(48, ...rows.map((r) => Math.ceil(Math.max(0, ...r[c].lines.map((l) => l.width)) + r[c].pad))),
  );
  return { cols, rows, hi, lo: hi.map((h) => Math.min(h, 64)) };
}
const sumOf = (ws: number[]) => ws.reduce((a, b) => a + b, 0);
const longText = '긴 설명 문장이 여러 단어로 이어지는 셀입니다 '.repeat(6).trim();
const tcTable = [
  ['ID', 'Seq.', 'Expected Result'],
  ['TC-1', '1', longText],
  ['TC-2', '2', longText + ' 추가'],
];

test('모두 한 줄로 들어가면 사용 가능한 폭을 한 줄 폭 비율로 채운다', () => {
  const s = statsOf([
    ['a', 'bb'],
    ['ccc', 'd'],
  ]);
  const ws = planWidths(s, 1000);
  assert.equal(sumOf(ws), 1000);
  assert.ok(ws.every((w, c) => w >= s.hi[c]), `폭 ${ws}, 한 줄 폭 ${s.hi}`);
  assert.ok(ws[0] > ws[1] === s.hi[0] > s.hi[1], `폭 ${ws}, 한 줄 폭 ${s.hi}`);
});

test('넓은 표: 사용 가능한 폭을 꼭 채우고, 긴 열이 가장 넓다', () => {
  const s = statsOf(tcTable);
  const ws = planWidths(s, 500, [160, 160, 180]);
  assert.equal(sumOf(ws), 500);
  assert.ok(ws[2] > ws[0] && ws[2] > ws[1], `폭 ${ws}`);
});

test('최소 폭만으로도 넘치면 최소 폭 (가로 스크롤)', () => {
  const s = statsOf(tcTable);
  assert.deepEqual(planWidths(s, 100), s.lo);
});

test('시작 배치보다 예상 줄 수가 늘지 않는다', () => {
  const s = statsOf(tcTable);
  const start = [160, 160, 180];
  const total = (ws: number[]) => s.rows.reduce((a, row) => a + Math.max(...row.map((cell, c) => linesAt(cell, ws[c])[0])), 0);
  assert.ok(total(planWidths(s, 500, start)) <= total(start));
});

test('셀보다 긴 단어는 셀 폭마다 잘리고 잘린 수를 센다', () => {
  // 160px 단어, 안쪽 폭 80px
  const [lines, , broken] = linesAt(cellOf('abcdefghijklmnopqrst'), 20 + 80);
  assert.equal(lines, 2);
  assert.equal(broken, 1);
});

if (failed) {
  console.log(`\n${failed}개 실패`);
  process.exit(1);
}
console.log('\n모두 통과');
