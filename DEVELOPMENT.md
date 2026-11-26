# 개발

```bash
npm install
npm run build      # dist/ 빌드
npm test           # diff / 서식 보존 로직 테스트
npm run package    # .vsix 생성
```

VS Code 에서 이 폴더를 열고 `F5` 를 누르면 확장 개발 호스트에서 바로 실행됩니다.

## 배포

`package.json` 의 `version` 과 `CHANGELOG.md` 를 고쳐 커밋한 뒤, 같은 버전의 태그를 push 하면
GitHub Actions([publish.yml](.github/workflows/publish.yml))가 GitHub Release 를 만들고 Open VSX, VS Code Marketplace 에 배포합니다.

```bash
npm version 1.0.6 --no-git-tag-version   # 버전 올리기
git commit -am "Release 1.0.6"
git tag v1.0.6
git push && git push --tags
```

- **VS Code Marketplace**: Trusted Publishing(OIDC). Marketplace 관리 페이지 → publisher `vuei91` → Trusted Publishing 에
  저장소 `vuei91/md-preview-editor`, 워크플로 `publish.yml` 이 등록되어 있습니다. (저장소 Secret `VSCE_PAT` 가 있으면 그것을 대신 씁니다)
- **Open VSX**: 저장소 Secret `OVSX_PAT`. 없으면 건너뜁니다.
- 이미 올라간 버전은 건너뛰므로, 실패한 단계만 다시 돌려도 됩니다.

## README 데모 GIF

`images/demo-*.gif` 는 `test/harness/` 의 브라우저 화면을 headless Chrome 으로 자동 조작해 녹화한 것입니다.
GIF 는 `.vsix` 에 넣지 않고(`.vscodeignore`), 마켓플레이스는 GitHub 에 올라간 파일을 불러와 보여 줍니다.

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
