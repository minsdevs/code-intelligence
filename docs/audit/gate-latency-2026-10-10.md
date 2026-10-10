# 출시 게이트 지연 후속 작업 — 2026-10-10

**NO_GO, 작업 진행 중.** PR #115/main `b0309e9616570438a75b49c931b3ec6448659291`에서 시작했다. 이전 lqudku와 보관 디렉터리는 불변이며 이전 PASS를 새 후보에 상속하지 않는다. 아래 비공개 증거는 COORD `validation/local/gate-latency-20261010/` 기준이다.

## 1. 소스 재사용의 중복 경로 검사

실제 production vault와 합성 메모리 wrapping으로 1,024개·각4KiB의 서로 다른 blob을 stage/barrier한 뒤128개씩 retain했다. 실사용 프로필·Keychain에는 접근하지 않았다. 기존 retain은 한 blob의 project/address와 파일 읽기에 같은 ancestor chain을 반복 순회했다.

| 진단 | 첫 회차 | 둘째 회차 | 셋째 회차 | 회차당 lstat |
| --- | ---: | ---: | ---: | ---: |
| 기존 vault-baseline-vRmo3G | 678.735ms | 645.996ms | 638.946ms | 69,168 |
| 변경 vault-guarded-path-vK2Dlm | 377.195ms | 356.190ms | 357.918ms | 29,232 |

읽기 전후 각각의 ancestor walk에서 project/address의 기대 identity를 함께 검사하도록 합쳤다. root부터 모든 ancestor의 symlink/type 검사, private UID/mode, project/address identity, O_NOFOLLOW 파일 열기, 파일 state 재검사, AEAD/hash/key 검증·실패 시 bytes zeroization은 유지한다. 이전 읽기의 검사를 캐싱하거나 source 검증을 생략하지 않는다. 경로 기반 검사를 descriptor-relative confinement으로 주장하지 않는다. Windows native-state 경로에도 동일한 읽기 전후 directory identity 계약을 유지한다.

추가한 directory 교체 경계2개는 기존 구현에서도 PASS했으며 최적화로 보안 경계가 약해지지 않게 보호한다. 변경 후 batch/Windows 모델36개, 나머지 vault/backup107개, 합계143개가 PASS했다. 실제 진단에서도 마지막 blob의 암호문 변조 거부와 합성 루트 정상 정리를 확인했다. Windows 모델 시험을 실제 Windows 네이티브 수용으로 대체하지 않는다. `vault-identity-before.log`, `vault-security-after.log`, `vault-other-contracts.log`에 결과를 보존했다.

이 값은 깊은 임시 프로필 경로의 소형 계측 진단이며 전체 packaged refresh의 SLO가 아니다. medium30초 목표 검증·새 후보 수용은 NOT RUN이다.

## 2. RSS 최소 관측과 실행 조건

`rss-reader-SFUJma/result.json`은 작은 Node owner를 대상으로 production reader를100회 실행했다. 두 ps 호출 중 discovery의 p95/max는51.037/54.586ms, targeted read는41.193/225.424ms였고 전체 최대271.203ms였다. 제품 large 부하 없이도250ms를 넘을 수 있음을 확인했다. OS 내부 지연의 정확한 원인은 아직 분리하지 않았다. 실제 PPID, 동일 번들의 XPC 범위·owner identity·수집 상한을 유지해야 하며 읽기 scope를 종료 권한으로 사용하지 않는다.

시작 시 AC·닫힌 덮개·load1 12.48·가용 약3.2GB를 관측했다. 새 build/medium/large의 기존 공간 진입 조건과 정식 quiet/open-lid 조건을 만족하지 못했다. 임의 삭제·부하 기준 완화 없이 소형 재현과 대상 시험을 진행했다. 최종20회와 사람 수용은 NOT RUN/준비 상태만 유지한다.
