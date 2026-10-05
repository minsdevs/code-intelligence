# 배포 전 통합 후보·검증·최종 판정

> 후속 상태: [2026-10-06 Docker 통합 검증](docker-integration-2026-10-06.md)에서
> Docker 환경 차단과 기본 백엔드/품질 구성 검증을 보완했다. 아래 Docker unavailable는
> 이 후보 작업 당시의 역사적 기록이다. 보존 후보·기존 실패 원장은 변경하지 않았다.

## 현재 결론

**통합 후보 제작, 실행 가능한 회귀, 의존성 보안 보완과 운영 문서를 정리하고 전체
8단계의 출시 전 최종 판정을 기록했다. 정식 출시는 No-Go이며, 실제 배포는 실행하지
않았다.** 이는 모든 출시 수용조건이 완료돼 공개 버튼만 남았다는 뜻이 아니다.
아래의 미검증/실패·추가 구현 및 외부 조건을 통과로 바꾸지 않았다. 실제 사용자
DB·profile·Keychain·GitHub private key를 실험 대상으로 삼지 않는다.

원본 `/Users/minseokchae/Dev/code-intelligence`만 사용했다. 중단 시 남아 있던
작업을 확인하여 PR92의 비용 복구 결과와 인증 구현을 보존했다. 인증 수명주기는
PR93 / `8f84b9c`로 병합했고, 후속 후보/준비는
`codex/pre-release-candidate-readiness-20261005`에서 작업한다.

## 전체8단계의 완료 범위

‘이번 수행’은 실제 완료한 구현/검증 단위이며, ‘출시 수용 잔여’가 남아 있는
단계는 전체 PASS가 아니다. 기존 제품 A–E 구현과 배포 수용을 혼동하지 않는다.

| 단계 | 이번 수행 및 재사용 근거 | 출시 수용 잔여 |
| --- | --- | --- |
| 1 데이터 복구 안정화 | 비호환 사전 거부·정상 복원·두 I/O 중단 복구/재시작·한영 안내. PR92의173 비용 보존과202 보수적 rollback, 소유 Node owner 중단2경계 | Electron singleton까지 포함한 전체 crash/power-loss 행렬, 기존 실사용 DB의 extension/index/locale·ICU 적용·되돌리기 조건, 최초 간헐적 시작 실패 원인 |
| 2 실제 GitHub 가져오기 | repo/clone/import/PR metadata에 revision-bound credential 소비와 게시 fence, 단위/실제 PG 검증 | 기존 실패 project1의 실계정 UI 재분석. 기존 데이터 적용 조건 충족 전 해당 프로필을 변경하지 않음 |
| 3 인증 수명주기 | device refresh 영속 claim→provider→동일 revision/generation CAS, 실패 재인증, single-flight, late401·unlink/newlogin 방어. PR93 병합 | 실제 GitHub refresh/revoke/SSO, production Spring/JPA 전체 트랜잭션 통합. Docker-backed 시험은 실행 불가 상태 |
| 4 분석·작업 신뢰 | frontend 전체425, TS analyzer222, backend 선택277, 실제 후보의 가져오기/재분석/보관소스/flow/삭제/재시작 | 독립 corpus의 공개 정확도 기준, 전체 cancel/delete/worker-crash 경합. 선택 tree sidecar의 기존 native binding은 로드 실패하여 시험0건 |
| 5 성능·보안·사용성 | quality-gate의 두 Gradle offline 적용·RSS 미수집/0값의 잘못된 PASS 제거, 실제 time 파싱 회귀. 보안공지19건과 일치한9개 패키지를 포함하는 관련 의존성 계열 갱신 | Docker-backed quality corpus,20회 전체 프로세스 RSS/p95, 독립보안·사용자 과제 기준, OS/native/browser 전체 advisory·라이선스 검토 |
| 6 새 설치·업데이트 | 현재 Java/frontend/desktop를 묶은 새 Validation 후보, 실제 데이터·소스/복원/재시작과 패키지 해시 readback | 개발도구 없는 새 기기·실제 최소 macOS·Windows, Developer ID/공증/Gatekeeper, 서명 업데이트/다운그레이드/중단 rollback |
| 7 배포물·운영 준비 | README/SECURITY 현행화, 정확한 후보 해시·정적 component 목록·실제 JAR 좌표 매칭·현재 advisory 조회, 재현 명령/known issues | 완전한 SBOM/브라우저 번들 의존 그래프·재배포 라이선스 의무, 운영용 GitHub App 외부 설치 범위·문제 대응 주체/지원정책 확정 |
| 8 최종 출시 판정 | 미검증과 실패 기록을 보존하고 이번 후보 기준 No-Go 기록. 정식배포/Actions/유료 AI 실행0 | 앞선 필수 gate 및 독립 검토 통과, 정식 서명/공증 자격과 최종 공개 승인 |

## 통합 보안 패치 후보

```text
app                  .native-product-Imupzt/Code Intelligence Validation.app
buildSequence        1791218416622
app.asar SHA-256      7317187afaa9364651dd0a289130f4b07750890731600e0695c43e37582fc6e7
runtime-manifest     61c2f787f470970f1d6451d8fc23878880fba8266c154e227eb39c38e890819f
backend JAR          ad839cb5ab95a4daf756c78e849b263fdce6a705fef586d6a6962cd672a96bd2
```

`validation/local/pre-release-candidate/build-dX6t1j/result.json`이 빌드 원장이다.
Java746 class와27 migration의 정확한 집합, frontend120 static 자산, 비정적1094
JAR entry 바이트/압축방식과 nested-JAR 특성을 대조했다. 현재 desktop `.cjs`는
ASAR readback과 일치한다. 이전 `VOL4tM`의 runtime 사본을 사용하되 JAR와 build
identity를 새로 게시하고, native/JRE/TS 공급의 기존 바이트는 검증 후 재사용했다.
기존 앱/profile은 덮어쓰지 않았다.

`build-candidate.cjs`는 소스 root뿐 아니라 Gradle·wrapper·npm package/lock 입력
해시도 기록한다. frontend/desktop 의존성은 private copy를 사용하고 `.env`는
읽지 않는다. backend Gradle은 기존 checkout과 사용자 Gradle cache/configuration을
사용하므로 **hermetic build라고 부르지 않는다**. 새 보안 dependency의 공개 Maven
다운로드를 명시적으로 수행한 후 실제 후보 build는 `--offline`으로 성공했다.
배포용 DMG/ZIP/서명·공증이 아니라 기존 정책의 ad-hoc directory candidate다.

## 의존성 보안 점검과 조치

초기 `VOL4tM`의 npm/pom 기반 조회는206좌표에서15개 advisory와 일치했다. 실제
Gradle resolved artifact와 패키지 JAR의 filename+SHA-256을 대조해 조회 범위를
넓히자277좌표에서19개 advisory,9개 package와 일치했다. 이는 이 앱에서19개 취약점의
공격 경로를 재현했다는 뜻이 아니다. 등록 severity와 upstream의 영향 등급이 다른
경우도 그대로 기록하며, 어느 하나를 골라 과장하거나 수정을 면제하지 않는다.

| 계열 | 이전 실제 패키지 | 적용한 고정 버전 |
| --- | --- | --- |
| Jackson 2 | core/databind2.21.4 | BOM2.21.7 |
| Jackson 3 | core/databind3.1.4 | BOM3.1.7 |
| Netty | handler/DNS4.2.15.Final | BOM4.2.17.Final |
| Log4j | API2.25.4 | BOM2.25.5 |
| PostgreSQL JDBC |42.7.11|42.7.12|
| Tomcat embed |11.0.22|core/el/websocket11.0.26|

공식 근거: [FasterXML core](https://github.com/FasterXML/jackson-core/security/advisories/GHSA-7hhh-6rmp-j9qf),
[FasterXML databind](https://github.com/FasterXML/jackson-databind/security/advisories/GHSA-cxp5-3px4-pw24),
[Netty](https://github.com/netty/netty/security/advisories/GHSA-c4c3-7fpv-j4q5),
[Apache Logging](https://logging.apache.org/security.html),
[pgJDBC](https://jdbc.postgresql.org/security/),
[Tomcat11](https://tomcat.apache.org/security-11.html).
실제 적용은 Gradle169 resolved artifact 목록, JAR 바이트 readback와 후보 inventory로
확인하며 선언한 버전 문자열만으로 패키지가 바뀌었다고 판정하지 않는다.

최종 `inventory-Imupzt-final.json`과 `advisory-Imupzt-final.json`은 새 후보를
검사했다. **조회한276개 고유좌표에서 일치 advisory0건**이며, Maven152개는 실제
패키지 filename+SHA-256과 resolved artifact가 일치한다. `spring-boot-jarmode-tools`
1개는 연결된 runtime 좌표가 없어 제외했고, 그 사실을 omission으로 남겼다.
기본 앱 package와 `private:true`는 제외하며, 최종 조회기는 외부 registry에
좌표/버전을 보내 무인증 공개 응답을 확인한 뒤 확인된 좌표만 OSV에 전송한다.
registry 확인 전의 요청에도 이름/버전이 전달되므로 이를 비공개 좌표를 모르는
자동 비밀탐지기로 사용하지 않는다. 소스/사용자경로/키/원시 JAR는 전송하지 않았다.

고정된 allowlist 외 오류·불완전 페이지·반복 토큰·결과 수 불일치는 실패로 처리한다.
resolved 목록을 지정하면 SHA 불일치 시 POM으로 몰래 대체하지 않는다. ZIP 파서가
지원하지 않는6개 nested metadata는 검증된 외부 entry 해시와 NOASSERTION만
남기며 경로/크기/CRC 보호를 완화하지 않는다. registry200이나 조회0건은 tarball
provenance·전체 공급망·실행 가능성·법적 재배포·향후 advisory 부재를 보장하지 않는다.

### 중단 재개 후 최종 보정과 재검사

`--resolved-maven`으로 지정한 문서 내용이 JSON `null`이면 제공 여부를 false로
판정하여 legacy POM 조회로 돌아갈 수 있는 잔여 입력 검증 문제를 수정했다.
이제 옵션 미제공만 legacy 모드를 허용하고, 제공된 null/boolean/number/배열/잘못된
문서 구조는 출력 보고서 생성·registry/OSV 통신 전에 거부한다. 유효한 빈 resolved
목록도 POM fallback을 허용하지 않는다. 실제 scanner 소스를 평가하는 VM 회귀에서
보고서 open0·외부 요청0을 단언했다. CLI의 고정 거부 stderr는 허용되므로 ‘무출력’은
보고서 파일 미생성 의미로 한정한다.

보정 후 동일 후보·inventory·resolved 입력의276개 좌표가 이전 공개 확인 집합과
일치하는지 확인하고 새 파일 `advisory-Imupzt-resume-20261006.json`으로 다시 조회했다.
결과는 **276개 조회좌표에서 advisory 무일치, 파일명+SHA256 일치 Maven152개,
미매핑 JAR1개 제외**다. 이전19개 일치 기록·앞선 무일치 기록은 덮어쓰지 않았다.
실제 조회 시각과 입력/결과·검증 도구 해시는 최종 JSON 원장에 기록한다.

## 실행 기록과 실패 보존

공통 경로는 `validation/local/pre-release-final/`이다. 원시 JUnit/로그는 local에
보존하고 Git에는 선별된 카운트·상대 evidence 경로·해시와 한계를 게시한다.

| 범위 | 확인한 결과 |
| --- | --- |
| PR93 backend |277/277 PASS,16 suite; `auth-backend-summary.json`, `auth-junit/`|
| 보안dependency 변경 후 backend |277/277 PASS,0failure/error/skip; `security-patched-backend-summary.json`, `security-patched-junit/`|
| frontend 전체 |425/425 PASS,0pending; `frontend-all.json`|
| TS analyzer |222/222 PASS,6 files; typecheck exit0|
| Tree 선택 sidecar |typecheck exit0, native binding 로드에서 suite FAIL·실행한 test0. 해당 sidecar는 현재 native candidate에 묶지 않음|
| 실제 JDBC CAS |`pre-release-auth/auth-store-nox56E`:6/6 PASS,27 migration,소유PG exit0. Spring/JPA 전체 연결 통합의 대체 아님|
| quality-gate |Docker daemon unavailable로 실행 전 거부. RSS/p95/정확도 통과라고 기록하지 않음|
| patched candidate |아래 최종 native evidence와 `pre-release-candidate-validation-2026-10-05.json`에 분리 기록|
| 중단 재개 최종 JavaScript 회귀 |`resume-92dOec/javascript.log`:293/293 PASS,0failure/cancel/skip. scanner·inventory·출력guard·측정·진단·desktop 계약의 명시적 선택이며 전체제품 수용 대체 아님|
| 중단 재개 Python 회귀 |`resume-92dOec/python.log`:4/4 PASS. 후보 static 교체의 정확한 class집합·symlink·기존receipt 보호를 합성 파일로 검증|
| 현재 소스/후보 재대조 |`resume-92dOec/source-candidate-check.json`:제품 소스3개트리·7개빌드입력,desktop43파일이 빌드 증거와 일치. 실제 후보 ASAR/JAR/manifest·ad-hoc strict signature 재검사 통과|

이전 `VOL4tM`의 `product-GLlv1s`와 보안패치 후 `Imupzt`의 `product-i4Asap`은
각 실제 앱 통합 실행에서31개 check를 기록하며 통과했다. 최종 후보는 필터링한965개 source 중883개,
7,940,986bytes를 실제 import했고 flow step→보관 source와 재시작을 확인했다.
관측 import→overview61,212ms,검색13ms,관계1,131ms이며 **해당 입력·한 호스트·
한 번의 값**이다. success164/partial631/unsupported1/unmeasured87을 정확도나
제품지원율로 바꾸지 않는다. source scan의 SECRET_CONTENT80건은 제외 사유
카운트이지80개의 실제 사용자 비밀 유출을 의미하지 않는다. 초기57byte1파일은
승인 클릭→개요1,158ms였고, 이 작은 fixture를 큰 입력 성능과 혼동하지 않는다.
이전 후보의61,691ms 등은 별도 기록으로 보존하며 최종 결과와 합산하지 않는다.

최종 Imupzt의 `restore-preflight/native-YvrmAt`는 비호환 사전 거부 후 정상 복원과
재시작4개 검사를 통과했다. `restore-interruption/native-EjUHjk`와 `native-GPHJHz`는
각 source-rename 직후/완료후정리 오류에서 한영 안내와 데이터·소스 복구·추가 정상
재시작6개 검사를 통과했다. 이 세 보고서의8개 process exit는0/signal없음이고,
source-rename 실패 직후의 shutdown recovery notice는 clean으로 세지 않는다.
전체 product runner의31개 check에는 반복된 앱 버전/서비스 확인도 포함되므로
31개의 독립 기능·서로 다른 테스트라고 확대하지 않는다.

중단 후 제품 코드는 다시 바꾸거나 같은 후보를 다시 빌드하지 않았다. 기존 결과와
현재 소스·후보 해시를 대조해 재사용했다. 새 Docker 상태 점검 역시 daemon unavailable
였으므로 Docker corpus나 Spring/JPA 통합 전체를 실행했다고 처리하지 않는다.

실패 기록: `native-U5JF2f`는 CREDENTIALS startup timeout 후 owned child 강제정리;
`native-XSAaAM`은 MANIFEST/RUNTIME_INTEGRITY_FAILED로 시험 전 실패했다. mock
Keychain flag를 spawn 시점에 명시하고 고정 stream/Node 오류 분류를 확장했으나
**과거 원인은 미확정**이다. `integrity-w9FMgx`의20회 검증은 한 Electron 프로세스
안의 read-only inventory 반복이며20회 앱 시작을 의미하지 않는다. 최초 실패를
삭제하거나 retry PASS로 바꾸지 않는다. Tree sidecar의 기존 `.node` Mach-O 오류,
초기 출력 guard의 공유 evidence 부모0755 거부도 local 로그에 따로 보존한다.

중단 재개 후 최신 진단 도구로 **현재 Imupzt 후보**를 새 mock-Keychain claim에서
실행한 `integrity-evHspy/result.json`도 PASS다. 한 Electron 프로세스 안에서20회
read-only inventory 검사가 완료됐고 failure/trace0, runtime ready/AI OFF,
exit0/signal없음과 후보 해시 불변을 기록했다. 앞선 구 후보의 `integrity-w9FMgx`와
별개이며, 이 역시20회 앱 시작·전원손실 시험이나 간헐적 오류의 근본 원인 해결을
의미하지 않는다. 진단 실행은 기존 검증/실계정 프로필을 재사용하지 않았다.

## 운영·복구 경계

후보 앱을 Finder에서 직접 열면 격리 claim이 자동 적용되지 않는다. 검증은
`validation/pre-release/README.md`에 명시한 새 합성 claim runner로만 재현한다.
실사용 설치 또는 기존 계정 프로필로 테스트하기 전에 버전/locale/extension 호환과
복구계획을 확인해야 한다. `.app` 파일만 복사한다고 키·암호화 백업이 다른 설치로
이동 가능해지지 않는다.

복구 필요 상태에서는 백업·체크포인트·recovery 파일을 보관한다. 같은 설치에서
앱을 닫고 재오픈한 뒤 기록된 거래 검증 안내가 나타나면 따른다. 검증 실패 시
새 데이터를 덮거나 lock/PID/키를 추측하여 제거하지 않는다. Runtime 재시작 버튼은
미완료 복구 검증을 대신하지 않는다. GitHub 재인증은 로컬 분석 기록 삭제와 다르다.

정식 배포물은 아직 없다. 공개 설치 범위가 제한된 개발용 GitHub App을 운영 App으로
간주하지 않는다. 지원OS/업데이트정책/개인정보·외부전송 설명/라이선스 선택·지원
담당을 운영 의사결정으로 확정하고, 서명·공증·clean-machine검증 및 최종사용자
승인을 받은 뒤에만 공개한다.
