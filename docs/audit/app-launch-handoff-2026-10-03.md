# 별도 Mac 앱 실행 담당 인계

후속 상태: 부모 스레드는 별도 실행 담당이 아래 9월 29일 앱을 열었고 서비스 4개 ready,
DB V20 유지라고 보고했다. 이 감사가 앱을 실행하거나 DB 상태를 직접 검증한 것은 아니다.
해당 앱에서 사용자가 보고한 TS_PARSING 실패의 후속 수정은
[실사용 실패 추적](ts-parsing-live-app-2026-10-03.md)을 따른다. 구앱은 현재 소스 수정이
반영되지 않은 채 보존했다. 아래 내용은 앱 실행 전에 전달한 당시의 읽기 전용 인계다.

2026-10-03, 현재 감사 실행 중 부모 요청에 대한 읽기 전용 확인 결과.

- 이번 감사의 임시 Nest/Java 서버, Docker PostgreSQL·Redis 두 컨테이너와 전용 네트워크는
  모두 종료·삭제 확인됨. 최종 근거: `/private/tmp/ci-parser-flow-ilf8wo/reports/lifecycle.json`.
  공유 고정 포트를 점유하지 않고 브라우저·설치 앱·실제 사용자 DB를 실행하거나 변경하지 않았다.
- 존재하는 앱: `/Users/minseokchae/Dev/code-intelligence/desktop/dist/mac-arm64/Code Intelligence.app`.
  `Contents/Resources/app.asar`와 runtime manifest의 수정 시각은 2026-09-29이다.
  **현재 worktree의 10월 3일 수정이 포함된 앱이 아니다.**
- 위 앱과 `desktop/stage/runtime` manifest에는 `buildSequence`, `backupProtocol`,
  `ownershipProtocol`이 없다. 현재 `main.cjs`는 시작 시 build sequence를 요구하므로
  기존 stage에 대해 `npm start`를 실행하면 현재 integrity gate를 통과할 수 없다.
- 기존 앱의 일반 실행 명령은 `open "/Users/minseokchae/Dev/code-intelligence/desktop/dist/mac-arm64/Code Intelligence.app"`이다.
  **이번에는 실행하지 않았다. 실제 DB를 건드리지 않아야 하는 실행의 권장 명령이 아니다.**
  새 worktree보다 오래된 앱이 데이터 안전 면에서 더 안전하다는 근거는 없다.
- 현재 main은 `app.getPath('userData')`를 사용한다. 기본 저장소는
  `~/Library/Application Support/code-intelligence-desktop`이고 시작 시 DB·credential 처리가 있다.
  이번 확인 범위에서 명시적인 별도 userData 설정 코드는 발견하지 못했다.
  `DATA_DIR` 또는 검증하지 않은 Chromium 플래그만으로 DB·키체인까지 격리된다고 가정하지 말 것.
  별도 실행 담당은 복사본의 독립 userData와 credential 경로를 입증한 후 실행 방식을 정해야 한다.
- 감사는 동일 worktree의 `analyzers/ts-analyzer/src/semantic-extractor*.ts`,
  `desktop/src/main.cjs`, `desktop/package.json`, 신규 platform/build-gate 파일 및 audit 문서를 수정했다.
  staging/build/dist는 덮어쓰지 않았다. 실행 담당은 이 파일과 stage/dist를 동시에 수정하지 말 것.
  `git reset`, `npm run stage`, 전체 desktop/native guardian 테스트, 기존 PID 기반 종료는 사용하지 말 것.

기존 실행 파일은 보존했지만 설치·실행 안전 판정은 **미검증**이다. 현재 감사의 연결 시험
14개 통과가 이 과거 앱의 시작·설치 승인 근거를 대신하지 않는다.
