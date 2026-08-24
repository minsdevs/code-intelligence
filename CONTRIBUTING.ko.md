**언어:** [English](CONTRIBUTING.md) | 한국어

# 기여하기

## 개발 환경 설정

[README.md](./README.md)의 사전 요구 사항과 로컬 시작 단계를 따르십시오.
변경 사항은 집중된 범위를 유지하고 저장소의 결정론 우선, 근거 기반 분석 모델을
보존해야 합니다.

## Pull request를 열기 전에

변경한 모든 영역의 검사를 실행하십시오. 전체 로컬 게이트는 다음과 같습니다.

```bash
cd backend && ./gradlew spotlessCheck build
cd ../frontend && npm ci && npm run lint && npm run typecheck && npm test -- --run && npm run build
cd ../analyzers/ts-analyzer && npm ci && npm test && npm run typecheck && npm run build
cd ../tree-analyzer && npm ci && npm test && npm run typecheck && npm run build
cd ../.. && ./quality-gate
```

backend Testcontainers와 `./quality-gate`를 위해 Docker가 실행 중이어야 합니다.
quality gate는 `quality-baseline.env`에 검토된 corpus/time/RSS 임계값도 검사합니다.
이 baseline을 암묵적으로 업데이트하거나 `QUALITY_BASELINE_UPDATE`를 사용하지
마십시오. baseline 변경에는 명시적으로 검토된 편집이 필요합니다.

로컬 스크립트를 변경할 때는
`bash -n start-local stop-local check-local quality-gate`를 실행하십시오. Docker,
PostgreSQL, Redis, 브라우저 세션 또는 외부 provider를 사용할 수 없다면 검증하지
못한 범위를 명시하십시오. Unit/API smoke test는 브라우저 E2E로 간주되지 않으며,
결과 개수는 정확도 oracle로 간주되지 않습니다.

## 보안과 개인정보

secret이나 실제 저장소 콘텐츠를 절대 커밋하지 마십시오. 위협 모델을 문서화하고
명시적인 사람의 승인을 추가하지 않은 채 가져온 코드, 생성된 AI 출력 또는
신뢰할 수 없는 저장소 명령을 실행하는 기능을 추가하지 마십시오.
