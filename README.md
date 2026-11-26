# Markdown Preview Editor & Diff

Markdown 파일을 **미리보기 상태에서 바로 편집**하고, **렌더링된 상태로 diff**를 비교하는 VS Code 확장입니다.

## 기능

### 1. 편집 가능한 미리보기 (WYSIWYG)

- `.md` 파일을 열고 에디터 우측 상단 `미리보기로 열기` 아이콘 클릭
  (또는 탐색기 우클릭 → **편집 가능한 미리보기로 열기**, 명령 팔레트 `MD Preview: 편집 가능한 미리보기로 열기`)
- 미리보기 화면에서 그대로 글을 쓰고 서식(제목, 굵게, 리스트, 표, 코드블록, 링크, 이미지 …)을 바꿀 수 있습니다.
- 상단 탭에서 `마크다운` 모드로 바꾸면 원문 + 미리보기 분할 편집도 가능합니다.
- 실제 파일과 연동되는 VS Code 문서이므로 저장(Ctrl+S), 변경 표시, 텍스트 에디터와의 실시간 동기화가 그대로 동작합니다.
- **서식 보존**: WYSIWYG 에디터는 내부적으로 Markdown 을 다시 직렬화하지만(`*`→`-`, 표 패딩 등),
  이 확장은 실제로 수정한 줄만 원본에 반영하므로 git diff 가 깔끔하게 유지됩니다.
  (안전하게 반영할 수 없는 경우에만 정규화된 전체 문서로 저장합니다.)
- 항상 이 에디터로 열고 싶다면: 파일 탭 우클릭 → `Reopen Editor With...` → `Configure default editor for '*.md'`
- **표 열 폭**: 셀 글자를 재서 표 전체 높이가 가장 낮아지도록 열 폭을 자동으로 맞춥니다(짧은 열은 좁게, 긴 열은 넓게).
  폭이 남으면 열 폭 비율대로 나눠 표가 화면 폭을 꽉 채웁니다. 자동 맞춤이 브라우저 기본 배치보다 낫지 않으면 기본 배치를 그대로 씁니다. diff 화면의 표에도 같은 방식이 적용됩니다.
- **열 폭 드래그**: 표의 열 경계에 마우스를 올리면 커서가 바뀌고, 드래그로 폭을 조절할 수 있습니다. 경계를 더블클릭하면 자동 폭으로 돌아갑니다.
  조절한 폭은 Markdown 파일에는 저장되지 않고, 편집기 탭에서만 (같은 머리글의 표끼리) 기억됩니다.

### 2. 미리보기 Diff

렌더링된 Markdown 을 블록 단위로 정렬하고, 바뀐 블록은 단어 단위로 강조합니다.

| 진입점 | 비교 대상 |
| --- | --- |
| 편집 가능한 미리보기 상단 `HEAD와 비교` 아이콘 / 탐색기 우클릭 | 작업 중인 내용 ↔ Git HEAD |
| `MD Preview: 미리보기 Diff: Git 리비전과 비교...` | 작업 중인 내용 ↔ 선택한 커밋/브랜치 |
| `MD Preview: 미리보기 Diff: 다른 파일과 비교...` | 두 파일 |
| 탐색기에서 `.md` 두 개 선택 후 우클릭 → `선택한 두 파일 비교` | 두 파일 |
| Source Control 등에서 연 **diff 에디터** 우측 상단 아이콘 | diff 에디터의 원본 ↔ 수정본 |

- `Inline` / `Side by side` 보기 전환, `변경만 보기`, 이전/다음 변경 이동(F7 / Shift+F7)
- 바뀐 줄(수정된 표 행, 바뀐 단어가 있는 문단·리스트 항목·제목)은 연한 배경으로 칠합니다. `Side by side` 는 원본 연한 빨강 / 수정본 연한 초록, `Inline` 은 연한 노랑이고, 바뀐 단어·셀은 그 위에 더 진하게 표시합니다.
- 표는 행 단위로 정렬하고, 수정된 행에서는 실제로 바뀐 셀을 강조합니다(한쪽에만 추가·삭제가 있어도 좌우 같은 셀을 함께 표시).
- `Side by side` 에서 좌우 표의 열 폭과 행 높이를 맞추고, 한쪽 표를 가로 스크롤하면 반대쪽도 같이 움직입니다.
  넓은 표는 Shift + 마우스 휠로 어디서든 가로 스크롤할 수 있고, 이전/다음 변경 이동 시 바뀐 셀이 보이도록 가로로도 이동합니다.
- 비교 중인 파일을 편집하면 diff 가 실시간으로 갱신됩니다.

#### Diff 화면에서 바로 편집

수정본이 로컬 파일인 경우(HEAD 비교, 파일 비교, Source Control diff) diff 화면에서 바로 고칠 수 있습니다.

| 동작 | 방법 |
| --- | --- |
| 블록 편집 | 고칠 곳을 **더블클릭**하면 그 자리에 커서가 놓이고 바로 입력할 수 있습니다. 바깥을 클릭하면(다른 블록 포함) 적용, Esc 는 취소, Ctrl+Enter 로도 적용됩니다 |
| 되돌리기 | 수정 전·후 사이(inline 은 블록 오른쪽)의 화살표: 바뀐 블록은 원본으로, 추가된 블록은 제거, 삭제된 블록은 복원. 수정된 표는 행마다 화살표가 있습니다 |
| 실행취소 / 다시실행 | diff 화면에서 적용한 편집·되돌리기를 Ctrl+Z / Ctrl+Shift+Z(또는 Ctrl+Y), 또는 상단 툴바 버튼으로 하나씩 되돌립니다 |
| 저장 | 상단 `● 저장 안 됨` 옆 `저장` 버튼 또는 Ctrl+S |
| 문서 전체 편집 | 상단 `편집기 열기` → 편집 가능한 미리보기가 옆에 열리고, 고치는 대로 diff 가 갱신됩니다 |

- 블록 편집도 실제로 바꾼 부분만 원본에 반영합니다(줄 안에서도 편집한 부분만 교체).
- 저장하지 않은 채 diff 창을 닫으면 저장 여부를 묻습니다.
- side-by-side 보기에서는 오른쪽(수정본)에서 편집하고, 삭제된 블록 복원은 왼쪽에서 합니다.
- 한 번 클릭하거나 끌어서 글자를 고르면 편집이 열리지 않으므로 복사할 수 있습니다. 편집하는 동안 그 블록의 변경 강조는 잠시 사라지고, 적용하면 다시 표시됩니다.
- 편집기 툴바는 숨겨져 있습니다. 서식은 단축키(Ctrl+B, Ctrl+I 등)로, 표 행·열 추가는 표 위 우클릭 메뉴로 합니다.
- 고칠 수 있는 쪽의 링크는 더블클릭하면 링크 글자를 편집하고, Ctrl+클릭하면 링크를 엽니다(VS Code 편집기와 같습니다).
- 블록 편집 중 Ctrl+Z 는 편집기 안의 입력을 먼저 되돌리고, 고친 게 없으면 편집기를 닫고 diff 화면에서 적용한 변경을 되돌립니다.
- 그 사이 다른 편집기에서 문서가 바뀌면 diff 화면의 실행취소 기록은 지워집니다(원문에서 Ctrl+Z 로 되돌릴 수 있습니다). diff 화면에서 적용한 변경도 문서의 실행취소 기록에 그대로 남습니다.

## 설치

- **VS Code**: 확장 뷰에서 `Markdown Preview Editor` 검색
- **Cursor / Kiro / Windsurf / VSCodium**: 확장 뷰에서 검색 ([Open VSX](https://open-vsx.org/extension/vuei91/md-preview-editor))
- **직접 설치**: [Releases](https://github.com/vuei91/md-preview-editor/releases)에서 `.vsix` 를 받아 확장 뷰 `...` 메뉴 → `Install from VSIX...`
  (또는 `code --install-extension md-preview-editor-<버전>.vsix`)

## 설정

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `mdPreviewEditor.editMode` | `wysiwyg` | 편집 가능한 미리보기를 열 때의 기본 모드 (`wysiwyg` / `markdown`) |
| `mdPreviewEditor.diff.defaultView` | `inline` | Diff 기본 보기 (`inline` / `sideBySide`) |

## 개발

```bash
npm install
npm run build      # dist/ 빌드
npm test           # diff / 서식 보존 로직 테스트
npm run package    # .vsix 생성
```

VS Code 에서 이 폴더를 열고 `F5` 를 누르면 확장 개발 호스트에서 바로 실행됩니다.

### 배포

`package.json` 의 `version` 과 `CHANGELOG.md` 를 고쳐 커밋한 뒤, 같은 버전의 태그를 push 하면
GitHub Actions([publish.yml](.github/workflows/publish.yml))가 VS Code Marketplace, Open VSX 에 배포하고 GitHub Release 를 만듭니다.
(저장소 Secrets 의 `VSCE_PAT`, `OVSX_PAT` 를 사용합니다. 없는 토큰의 배포 단계는 건너뛰므로, 그때는 Release 에 첨부된 `.vsix` 를 직접 올립니다)

```bash
npm version 1.0.1 --no-git-tag-version   # 버전 올리기
git commit -am "Release 1.0.1"
git tag v1.0.1
git push && git push --tags
```

수동 배포:

```bash
npm run package                          # 빌드 + 테스트 + .vsix 생성
npx vsce publish --packagePath md-preview-editor-<버전>.vsix   # VS Code Marketplace (VSCE_PAT 필요)
npx ovsx publish md-preview-editor-<버전>.vsix                 # Open VSX — Cursor, Kiro 등 (OVSX_PAT 필요)
```

## 구조

```
src/
├── extension.ts       # 명령 등록, 대상 문서 해석
├── editorProvider.ts  # CustomTextEditor: 문서 ↔ webview 동기화
├── preserveFormat.ts  # WYSIWYG 정규화 결과를 원본 서식을 유지하며 반영
├── markdownDiff.ts    # 블록 정렬 + HTML 단어 단위 diff
├── diffPanel.ts       # Diff webview 패널 (실시간 갱신, 블록 편집/되돌리기)
├── blockEdit.ts       # 블록 단위 교체/삽입 (원문으로 위치 재확인)
├── documentEdit.ts    # 최소 범위 문서 편집
├── git.ts             # git show / log
└── webview/           # webview 스크립트/스타일 (Toast UI Editor)
```

## 알려진 제약

- WYSIWYG 에디터([Toast UI Editor](https://github.com/nhn/tui.editor), CommonMark + GFM)가 지원하지 않는 문법
  (front matter, 수식, mermaid 등)은 편집 시 일반 텍스트/코드로 취급될 수 있습니다.
- Diff 는 최상위 블록(문단, 리스트, 표 …) 단위로 정렬합니다. 표는 행 단위로 비교하지만, 열이 추가·삭제되면 좌우 열 폭은 맞추지 않습니다.
