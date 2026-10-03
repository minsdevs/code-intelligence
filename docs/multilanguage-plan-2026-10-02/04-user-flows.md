# 사용자 흐름과 불확실성 UX

## F1. 첫 실행→로그인 없는 로컬 분석

설치한 앱 실행→runtime 상태 검사→“로컬 폴더 열기 / GitHub 연결”을 동등하게 제공한다. 계정 폼이 local 경로를 막지 않는다. main native picker만 root capability를 발급하고 앱 내부 source viewer를 기본으로 사용한다.

Preview에는 root·파일 수·bytes·포함 언어·제외 사유·예상 지원 깊이를 보여준다. home/상위 폴더를 골랐으면 기본 차단하고 특정 프로젝트로 좁히도록 안내한다. `.ssh/.aws/.env`, generated/vendor/submodule 등이 제외되는 이유와 분석 누락 영향을 명시한다. “비밀이 전혀 없다”라고 하지 않는다. 범위 변경→새 digest→확인→복사→분석. preview 이후 변경이면 409로 재검토, 이전 snapshot 유지.

진행 화면은 `검사/복사/구문/심볼/연결/저장`과 처리 files/bytes, 최근 진행 시간, 취소 상태를 보인다. 단계별 분모가 없는 동안 퍼센트를 꾸며내지 않는다. quota/permission/unsupported/worker crash를 분리해 재시도와 범위 축소 경로를 준다. parser 한 개 실패가 전체 서비스 고장으로 보이지 않게 하되 분석 중인 세대를 완료로 보여주지 않는다.

## F2. GitHub 연결과 연결 해제

“GitHub 연결”→권한 요약(선택 저장소 읽기)→브라우저의 공식 device page에서 코드 확인→앱에서 승인 대기→사용자 계정 확인→설치된 선택 repo 목록→branch/commit 선택→용량 사전 확인→immutable snapshot. 사용자가 브라우저에서 승인한 계정이 기대와 다르면 가져오기 전 취소 가능하다.

device denied/expired/slow_down/offline/organization approval pending/SSO를 별도 안내한다. 설치 repo가 0이면 전체 repo 권한을 자동 요청하지 않고 설치 관리 링크와 local 대안을 보여준다. 토큰/갱신 만료 시 기존 분석은 계속 열고 원격 refresh만 재인증을 요구한다. 계정 전환 시 remote connector ID만 바꾸며 기존 project 소유자/로컬 identity는 유지한다.

연결 해제는 로컬 암호화 token 삭제, 진행 중 원격 읽기 취소, GitHub에서 권한을 철회하는 공식 페이지 안내. 이미 가져온 소스 삭제는 별도 선택이다. 서버 revoke 성공과 로컬 token 제거를 혼동하지 않는다.

## F3. 근거 마인드맵

첫 화면은 project→service/module→영역→심볼의 2단계 접힌 구조다. 중요 노드 100개 이내에서 시작하고 사용자가 확장한다. 좌측 검색/필터, 중앙 마인드맵, 우측 근거/해석 패널은 기존 구조를 유지한다. “관련 파일 모두 보여주기”는 pagination으로 동작한다.

선택한 노드에는 선언 범위·source snapshot 시간·dirty 상태·analyzer/version·지원 수준을 표시한다. edge에는 관계 이름과 `정적 대상 확인 / 추정 / 해석 불가`를 텍스트로 함께 표시한다. 선 색상만으로 구분하지 않는다. 확정은 실선, 추정은 점선, 미해결은 끊긴 stub와 이유. 미지원은 관계 부재와 구분한 영역 카드다.

근거 클릭→**해당 snapshot 원본** 양쪽 span과 resolver/config 근거를 연다. 현재 작업 폴더와 다르면 “현재 파일과 다른 snapshot” 배지, 비교 동작. hash가 다르거나 retired면 잘못된 줄을 열지 않고 재가져오기/보존 snapshot 경로를 안내한다. q 점수는 고급 진단에만 보이며 확률로 표시하지 않는다.

## F4. 화면→API→서비스→데이터

사용자가 화면 route/component를 고르고 “요청 흐름” 선택→callsite URL→endpoint 후보→handler→service calls→entity/schema를 단계별 펼친다. Java API와 Python API도 동일 projection을 사용한다. 어느 단계의 소스도 없으면 연결을 꾸미지 않고 `API service origin 미확인` 등의 stop card와 후보들을 보인다.

동일 `/orders` endpoint가 2개면 두 후보·서비스·조건을 비교한다. 사용자 선택은 USER_ASSERTED로 저장되고 원본 analyzer 결과는 유지한다. 설정을 추가하거나 분석을 갱신하면 확인이 필요한 오래된 수동 판단을 표시한다. ORM entity는 table 이름 근거와 datasource를 함께 보여주며 SQL read/write 방향이 추정이면 명시한다. 사건/queue/FFI 경계는 별 배지와 한계 설명을 제공한다.

“전체 flow”는 실행 순서 보장이 아닌 정적 연결임을 제목 주변에서 짧게 설명한다. 중간에 추정이 있으면 path 배지가 전체 `추정 포함`이 된다. API endpoint를 선택해도 모든 가능한 UI 진입점이 발견됐다고 하지 않는다.

## F5. 변경 영향

심볼·파일 또는 snapshot diff 선택→정적 의존 확인/추정 영향/분석 밖 범위 세 탭→각 후보가 포함된 짧은 근거 경로→필요 source 열람. 노드가 여러 경로로 도달해도 위험 점수를 누적하지 않는다. 순위는 거리·관계 종류·확인 수준의 설명 가능한 정렬이며 위험 확률이 아니다.

필터로 추정을 숨길 때 상단에 숨긴 수와 미지원 수를 유지한다. 빈 결과는 “확인된 의존을 찾지 못함; 호출 해석 62/80”처럼 표현한다. depth/page 한계는 명시적 “추가 범위 있음”으로 표시한다. source 편집/자동 수정 버튼은 이 단계에서 추가하지 않는다.

## F6. AI와 비용

처음에는 OFF. 사용자가 provider/model/key/앱 일일 예산을 설정하고 전송 미리보기에서 파일·span·마스킹 결과·추정 최대 비용을 확인한 뒤 호출한다. context 전송 범위는 질문별 선택이다. embedding/요약을 background에서 몰래 시작하지 않는다. 사전 승인 묶음 작업은 항목 수·총예약액·취소 조건을 포함한다.

usage 불명 오류는 “청구 상태 미확인—예약액 보류”로 보여주며 자동 재호출하지 않는다. AI 문장은 별도 해석 블록이고 evidence ID 검증 실패면 출처없는 확정 문장으로 표시하지 않는다. AI가 repo 안의 지시를 따라 도구를 실행할 수 없다.

## F7. 업데이트·복구·삭제

업데이트 확인은 사용자가 켜는 옵션, 다운로드는 확인 후. 버전·서명 publisher·설치 용량·backup checkpoint·schema 호환을 보고 종료 후 검증된 패키지를 설치한다. 실패하면 마지막 작동 버전과 데이터 checkpoint 복구 화면으로 진입한다. 새 database를 구버전으로 임의 열지 않는다.

백업은 같은 설치 전용이라는 배지·포함 source/노트/AI 설정 범위·token 제외를 보여준다. 복원 미리보기에는 생성 버전·identity 일치·무결성·필요 공간·영향 데이터를 표시한다. recovery marker가 남으면 backend 기동을 막고 보존 파일 위치와 복구/진단 내보내기 선택을 제공한다. 로그 내보내기는 redaction 후 미리보기와 확인이 필요하다.

프로젝트 삭제는 원본·앱 snapshot·백업의 범위를 구분하고 취소중 job이 끝나기 전 409 유지. source quota 정리는 pin/노트 참조를 함께 보여준다.

## UI 상태·접근성 수용기준

| 상태 | 반드시 보여줄 것 | 금지 표현 |
|---|---|---|
| 일부 언어 성공/다른 adapter 실패 | capability별 성공·실패·미지원 수, 재시도 범위 | 분석 100% |
| 새 generation 실행중 | 마지막 완료 결과+진행중 배지 | 부분 결과를 최신 확정처럼 덮기 |
| budget 초과 | bytes/files/메모리 원인과 범위 축소 | 빈 프로젝트/지원안함으로 오도 |
| 오래된 근거 | snapshot 시간·원본 hash 상태 | 현재 파일의 같은 행을 무조건 열기 |
| 장애 복구 | 마지막 완성 결과·복구 지점·데이터 영향 | 복구 성공 보장 |

모든 노드/edge는 키보드 검색·포커스·리스트 대안으로 접근 가능. 200% 확대와 한국어 긴 문구에서 overflow 없음, 색각 이상 모드에서 텍스트/선형 유지, screen reader로 node/edge/상태/근거 링크를 읽을 수 있어야 한다. 그래프 렌더링이 느리면 테이블 대안을 즉시 제공한다. OS native picker·Keychain 흐름은 mock 브라우저로 검증했다고 하지 않는다.
