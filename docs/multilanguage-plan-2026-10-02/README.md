# Code Intelligence 다중언어 기획 인계

제품 구현 없이 작성한 기획 패키지다. 원래 기획서·출시 감사·인수 문서와 기존 안전 수정은 보존했다. 현재 제품 일반 출시는 **No-Go**이며, 기획의 점수·승인 여부는 [평가 기록](08-evaluation.md)을 따른다.

**부모의 다음 Astra Max 착수 문서:** [S1 근거 소스 안전 열람](11-first-implementation.md). 전체 언어 로드맵이나 18개 공개 셀을 한 번에 구현하라는 요청이 아니다.

| 문서 | 용도 |
|---|---|
| [00 고정 루브릭](00-rubric-v1.md) | 집필 전 고정한 100점 평가와 중대 결함 차단 |
| [01 PRD](01-prd.md) | 사용자·목표·범위·결정·운영 입력 |
| [02 언어지원표](02-language-support.md) | 현재 상태와 언어별 목표 깊이·순서·공식 근거 |
| [03 구조/IR 계약](03-architecture-contracts.md) | 재사용·namespace·근거·신뢰도·migration·worker 격리 |
| [04 사용자흐름](04-user-flows.md) | 가져오기·마인드맵·flow·impact·복구 UX |
| [05 보안/성능/운영](05-security-performance-operations.md) | OAuth·비밀·비용 원장·성능 예산·설치·백업·복원 안전 영역 |
| [06 벤치마크](06-benchmarks-validation.md) | fixture/oracle·정확도 산식·반례·실행 증거 |
| [07 개발/출시 게이트](07-delivery-release-gates.md) | 장기 작업·의존·위험·수용/중단 조건·감사 연결 |
| [08 평가](08-evaluation.md) | 독립 점수·결함·수정 이력·최종 판정 |
| [09 근거](09-evidence-register.md) | 원문 소스·공식 문서·검증 한계 |
| [10 최초 공개 18셀](10-r1-public-cells.md) | required/experimental·표본·장기 사람 작업량 |
| [11 첫 구현 S1](11-first-implementation.md) | 다음 한 번의 좁은 수직 기능·데이터 호환·검증·중단 조건 |

운영 GitHub App 소유 주체(O1)와 Developer ID/공증·배포 주체(O2)가 정해지기 전에는 해당 운영 검증·배포 게이트를 닫는다. 이 문서는 계정 생성·자격증명 발급·유료 호출·배포를 대신 승인하지 않는다.
