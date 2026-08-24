**언어:** [English](SECURITY.md) | 한국어

# 보안 정책

## 범위

Code Intelligence는 소스 저장소를 분석하며 AI 기능이 활성화된 경우 선택한 소스
컨텍스트를 외부 AI provider에 전송할 수 있습니다. 가져온 저장소, API 키,
GitHub 자격 증명, 데이터베이스 콘텐츠, analyzer payload를 민감한 정보로
취급하십시오.

## 취약점 보고

의심되는 보안 취약점에 대해 공개 issue를 열지 마십시오. 설명, 영향을 받는 버전
또는 commit, 재현 단계, 영향, 제안하는 완화책을 포함하여 저장소에 설정된 보안
연락처를 통해 maintainer에게 비공개로 연락하십시오. 보고서에 실제 자격 증명이나
기밀 소스 코드를 포함하지 마십시오.

## 보안 기대 사항

- `.env`, provider 키, GitHub token, `TOKEN_ENC_KEY`를 Git에 포함하지 마십시오.
- 고유한 프로덕션 암호화 키를 사용하고 노출 후 자격 증명을 교체하십시오.
- 배포 접근 제어와 TLS가 마련되지 않았다면 backend를 loopback에 유지하십시오.
- 비공개 저장소에 AI를 활성화하기 전에 provider의 데이터 사용 및 retention
  정책을 검토하십시오.
- playground는 의도적으로 실행하지 않습니다. 별도의 위협 모델과 승인 없이
  clone 실행이나 임의 subprocess 동작을 추가하지 마십시오.

## RC 로컬 소스 및 출력 경계

- 로컬 가져오기는 인증되며 명시적 확인이 필요합니다.
  `LOCAL_IMPORT_ALLOWED_ROOTS`를 좁게 설정하십시오. 빈 값은 backend 사용자의
  home directory만 허용합니다. 정규 경로, 보호 디렉터리, symlink 검사는
  심층 방어 수단이지 backend를 원격으로 노출해도 된다는 허가가 아닙니다.
- 안전한 새로고침은 전체 분석을 queue에 넣기 직전에 소유권, allowed-root 접근,
  snapshot ID와 미리 본 A/M/D 개수를 다시 검증합니다. 가져온 소스는 계속
  신뢰할 수 없는 상태이며 parsing만 하고 build하거나 실행하지 않습니다.
- 스냅샷 비교, coverage, finding 판정, 내보내기는 owner 범위로 제한됩니다.
  내보내기는 감지된 secret을 redaction하고 소스 본문을 생략하지만, 공유하기
  전에 파일을 검토하십시오.
- IDE 열기는 로컬 프로젝트와 검증된 상대 경로로 제한됩니다. custom-protocol 실행
  prompt를 로컬 작업으로 취급하고 편집 전에 commit 불일치 경고를 확인하십시오.
- AI 미리보기는 provider 요청을 하지 않으며 제외 사항은 서버 측에서 적용됩니다.
  AI 요청이 승인되면 선택한 컨텍스트는 여전히 외부 provider 신뢰 경계를 넘습니다.
- 이 RC에는 사용자 데이터 백업/복원이 구현되지 않았습니다. 분석 내보내기를
  Notes, Tasks, 판정, settings 또는 키의 복원 가능한 백업으로 취급하지 마십시오.
