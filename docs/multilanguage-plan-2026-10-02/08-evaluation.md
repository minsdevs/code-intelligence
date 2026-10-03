# 기획 평가·미결정·수정 이력

루브릭 [v1.0](00-rubric-v1.md)을 집필 전에 고정했다. 최종 v1.1 독립 평가는 **98.5/100, 기획 PASS**. 미해결 Critical0/High0/중대한 설계 미결정0으로95점 게이트를 통과했다. **제품 일반 출시는 별도로 No-Go**다. 다음 부모 Astra Max의 착수 범위는 [S1](11-first-implementation.md)뿐이다.

v0.9의 **92.5/100 HOLD, Critical0/High2/중대 미결정2**를 보존했다. 원 평가 [기록](review-records/v0.9-independent-review.md)·[대상 hash](review-records/v0.9-manifest.json), 최종 [독립 재평가](review-records/v1.1-independent-review.md)·[v1.1 hash](review-records/v1.1-manifest.json)를 비교할 수 있다. 평가 결과를 기록한 이08파일과 후속 탐색 README/보존 증거를 제외한 검토 대상 기술 명세는 최종 검토 후 변경하지 않는다.

## 항목별 최종 점수·근거·잔여 결함

| 영역 | v0.9 → v1.1 | 근거 | 남은 결함/한계 |
|---|---:|---|---|
| 요구·범위·사용자흐름15 | 15 →15 | 01 D01–D12/U1–U6,04 F1–F7,11 S1 | 실제 사용자시험은 미래 release gate |
| 언어·증거·혼합 정확성20 | 19.5 →19.5 | 02 깊이·한계,03 namespace/coverage,10 공개18셀 | N2 패턴별 표본 분배 보완 |
| 확장 구조·migration15 | 13.5 →15 | 03 factKey/immutable source/XPC·M1–M5,05 안전영역 | 실제 runtime 호환은 T03/C15에서 입증 |
| UX·불확실성10 | 10 →10 | 04 stop card/tier,11 old source unavailable | 실기기 접근성/사용성 미실행 |
| 성능·보안·복구15 | 11 →14.5 | 05 budgets/OAuth/원장/keys/restore,03 ADR-01 | N1 Git pack 압축 해제 예산 구체화 |
| 테스트·벤치마크·gate15 | 14 →14.5 | 06 gold/holdout/C15/C16·산식,07 gate | N2 runner의 세부 패턴 분포 고정 |
| 단계·의존·위험·수용10 | 9.5 →10 | 07 T00–T15·감사 매핑,10 작업량,11 좁은착수 | 사람 인력·운영 대기는 확보된 일정 아님 |
| **합계100** | **92.5 →98.5** | 고정 루브릭의 독립 점수 그대로 채택 | 기획 점수는 출시 보증/정확도 측정값 아님 |

하위 배점과 자세한 판단은 독립 검토 기록에 있다. 작성자는 점수를 보정하거나 루브릭을 완화하지 않았다. 자체 점검은 문서/링크/산술/원본 보존 확인이며 독립 리뷰로 부르지 않는다.

## 검토 방법

작성자와 별도 컨텍스트의 `independent_plan_review` Astra/xhigh 에이전트를 사용한다. reviewer는 본문을 작성/편집하지 않고 원문 감사·기획·현재 소스·고정 루브릭을 읽는다. 사전 소스 반례 제보는 03에 반영했으며, 본문이 완성된 후 전체 독립 채점과 결함 검토를 요청한다. 같은 모델 계열이므로 사람 사용자·현장 보안 검토/실기기 시험의 독립성을 대신하지 않는다.

## 초안 수정 이력

| 변경 | 근거/결함 | 반영 |
|---|---|---|
| 0.1→0.9 | service 없는 endpoint/table/topic key 충돌·임의 best match | 03 namespace/candidate/조건 계약, 06 C03/C04 |
| 0.1→0.9 | edge-only result evidence 미저장 | 03 EDGE subject 영속화·M1, T02 |
| 0.1→0.9 | 과거 snapshot에서 현재 소스 읽기 | 03 immutable source store/hash/retention/pin/GC·legacy unavailable |
| 0.1→0.9 | impact의 관계·confidence 혼합/경로 중복 점수 | 03 typed traversal/tier/visited, 04 F5 |
| 0.1→0.9 | device token refresh의 secret 필요 여부 | 공식 E15의 예외 확인, 01 D04/05 §2 수정 |
| 0.1→0.9 | backup restore 뒤 비용 원장 역행 | 05 §3 원장 합집합·UNKNOWN_HELD 유지 |
| 0.9 | 작업 추정 합계 산술 정정 | R0/R1 56–95 집중 개발일 |
| 0.9→1.0 H1 | worker의 OS 권한 enforcement 미결정 | 03 ADR-01 XPC/App Sandbox·상속·stdio·fail closed, 06 C15, 07 T03/G-SEC |
| 0.9→1.0 H2 | restore 시 ledger/vault 권위와 crash 순서 미결정 | 05 ADR-02 safety 영역·journal·AI latch·purpose key·credential scrub, 06 C16, 07 T08/T09 |
| 0.9→1.0 M1 | 같은 줄 복수 callsite·idempotency | 03 factKey/edgeId/legacy unique 이행 |
| 0.9→1.0 M2 | 최초 공개셀·SQL/Prisma 범위·annotation 추정 | 10의18셀/5,400 평가facts/95–110 annotation인일, 07 engineering66–112인일 |
| 0.9→1.0 M3 | candidate-set metric 계산 단위 | 06 micro/macro·set formulas·예시, exact-set≥85% 추가 |
| 1.0→1.1 | crypto key/nonce 문구·journal durable rename·transport 혼동 | 05 DEK256bit/nonce96bit,rename뒤dirfsync,03 productionstdio/devHTTP분리 |
| 1.0→1.1 | 사용자가 전체로드맵과 현실적 첫묶음 분리 요구 | 11 S1·person3–6인일·12runs·중단조건,01/07 착수범위 연결 |
| 1.1 최종 | 같은 독립 reviewer의 재평가 |98.5/PASS,Critical0/High0/중대한미결정0; 미래release No-Go유지 |

## 잔여 비차단 보완의 owner·수용 조건

| ID/심각도 | owner/착수 시점 | 후속 수용 조건 |
|---|---|---|
| N1 Medium | BE+SEC, T01/T07의 Git clone 경로를 바꾸기 전 | 압축 해제 총bytes/object당bytes/object수/delta-chain 깊이/decoder CPU·RSS/timeout의 명시적 한도를 고정하고 합성 pack 한도±1·깊은delta·중단cleanup으로검증. G-IMPORT/G-PERF PASS 전에 완료; S1 blob읽기에는 기존 파일크기+실제 bytes 상한 적용 |
| N2 Low | QA+ANA, T00 pilot/runner 확정 시 | required cell마다 하위 pattern 목록과positive/negative할당·누락셀을manifest에기록. 모든명시지원패턴과예외의표본을검사하고unknown/ambiguous false-resolved0를cell평균과별도로강제 |

이 두 항목은 허용된 무제한 동작이나 확인된 보안 취약점을 출시하는 면제가 아니다. 관련 구현/출시 게이트에서 닫아야 하며 현재 S1의 source-reader·호환 계약에 영향을 주는 중대 미결정은 아니다.

## 남은 운영 입력과 release 증거

O1 운영 GitHub App 소유 개인/조직·client ID/선택 repository 설치; O2 Developer ID/notary·배포 host/서명 주체. 기획의 프로토콜/권한/오프라인 기본값은 이미 정했고 실제 입력 전 해당 출시 게이트를 닫는다. 새 계정·자격증명·배포를 임의 실행하지 않는다. 07의 모든 미래 gate는 NOT RUN/BLOCKED이며 기획 점수로 PASS가 되지 않는다.
