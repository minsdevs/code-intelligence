# 최초 R1 공개 셀·표본·작업량 명세

v1.0 후보. [02 지원표](02-language-support.md)는 순차 목표 전체이며 **첫 R1의 required 공개 주장**은 이 파일의18셀만이다. 그 외 버전/패턴은 experimental 또는 unsupported로 표시한다. 02의 범위가 이 파일보다 넓다는 이유로 R1 지원을 확대하지 않는다. R2/R3는 같은 형식의 별도 셀 manifest와 표본/비용 검토를 만들어야 한다.

`required`는 R1이 해당 분석을 지원한다고 공개하려면 통과해야 한다는 뜻이다. 파싱/심볼/호출/프레임워크 셀은 개별 metric으로 판정한다. public supported mask는 이 표와 gate 결과의 교집합, 실험 결과는 일반 마인드맵 기본값에서 숨기고 사용자가 켜도 `미검증 후보`로 표시한다.

## 최초18셀

각 셀의 evaluation corpus(개발 split 제외)는 positive200 + negative/ambiguous100 =300 annotation, 독립 프로젝트≥3·시나리오≥10. P 셀의 positive는 구문 단위/파싱 판정이며 파일≥50도 충족한다. 같은 source 프로젝트를 여러 capability에 재사용할 수 있지만 정답 annotation/metric은 셀별 독립이다.

| Cell | 버전/지원 주장 | capability·gold 단위 | 상태 |
|---|---|---|---|
| J-P | Java21, preview 없음 | P 구문/파싱·invalid diagnostic | required |
| J-S | Java21 | S 타입/메서드/상속 선언과 정확 span | required |
| J-C | Java21, source-only classpath | C 명시 source 호출·overload, 외부/동적 unresolved | required |
| J-F | Spring MVC6.2 / Boot3.4, Java21 | F 명시 annotation route·조건·handler; 동적 bean 제외 | required |
| J-D | Jakarta Persistence3.1, Java21 | F 명시 Entity/Table/schema 선언, runtime naming strategy 제외 | required |
| T-P | TS5.9 / JSX는 TSX | P syntax/diagnostic | required |
| T-S | TS5.9 | S 함수/type/module/component span | required |
| T-C | TS5.9, source config/alias/reexport | C 명시 source call, 동적 dispatch unresolved | required |
| T-F | Nest11, TS5.9 | F Controller/route/global prefix/module 정적 설정 | required |
| T-UI | React19 / React Router7, TSX | F component·literal route·fetch/axios callsite 추출 | required |
| JS-P | ECMAScript2022 / JSX | P syntax/diagnostic | required |
| JS-S | ECMAScript2022 | S 함수/module/component span | required |
| JS-C | ECMAScript2022 lexical source | C 명시 function/import call; prototype/computed property 제외 | required |
| JS-UI | React19 / React Router7, JSX | F literal route·HTTP callsite, TS 결과로 대체 불가 | required |
| SQL-P | PostgreSQL16 DDL subset | P CREATE TABLE / ALTER ADD·DROP COLUMN 구문; procedure/dynamic SQL 제외 | required |
| SQL-S | PostgreSQL16 동일 subset | S schema-qualified table/column 선언과 source range | required |
| X-HTTP | 위 UI→J-F/T-F의 HTTP 계약 | X method/origin/service/path/조건의 candidate 또는 resolved relation | required |
| X-DATA | J-D→SQL-S 명시 매핑 | X datasource/schema/table 일치; 이름-only 추정·다른 DB 반례 | required |

X-HTTP의 공통 rule cell 안에는 TSX→Spring, TSX→Nest, JSX→Spring, JSX→Nest 네 입력 strata를 각 positive50/negative25 이상 배정한다. cell 총계 문턱 외에도 **각 stratum의 point precision/recall 문턱과 false-resolved0**을 각각 적용한다. Wilson lower 문턱은 n≥200인 cell에 적용하고 작은 stratum은 구간을 공개하되 표본 충분하다고 주장하지 않는다. 한 stratum이 실패하면 그것을 지원하는 HTTP 조합만 fail이며 “전체 평균이 통과했다”로 덮지 않는다.

기존02의 Java17, Spring7/Boot4, Nest10, React18/Router6, TypeORM0.3, Prisma6 schema, SQL의 다른 dialect, Kafka 연결/Next/Vue/Svelte의 자세한 rule은 첫 R1 **experimental**이다. 공개 지원으로 승격하려면 새 cell·버전·oracle·negative 기준을 추가한다. 다른 Prisma major는 unknown version으로 처리한다. 설정 파일/SQL을 읽는다는 이유로 모든 database lineage를 지원한다고 쓰지 않는다. 시스템 자체가 Boot4라는 사실과 분석 대상 Spring7 지원은 별개다.

## Annotation 수와 현실적인 개발 계획

- required18 × (positive200+negative100) = **5,400 평가 annotation**. 60/20/20 split에서 평가분이40%이므로 전체 개발+평가 corpus의 비율을 그대로 채우면 약13,500 annotations가 필요하다. 개발분은 완전한 두 사람 검토를 필수로 하지 않지만 평가 gold는 필수다.
- 평가분 두 독립 검토자 =10,800 decisions. 평균3분/decision를 기획 가정으로 잡으면540시간=67.5인일(8h). 20% annotation의 adjudication을3분씩 더하면54시간=6.75인일. **평가 검토만 약75인일**.
- 합성/대표 corpus 준비·라이선스·version pin·개발 gold 준비20–35인일을 추가하여 **독립 corpus/annotation 예산95–110인일**을 잡는다. task engineering 추정과 분리해 중복 계상하지 않는다. 운영 App 승인·서명·실기기 모집 대기는 이 합계에도 없다.
- T00의 첫300 annotations pilot에서 실제 case당 시간/불일치율/셀이 섞인 fixture 재사용률을 측정하고 전체 추정을 갱신한다. 더 빠른 deterministic span validator/annotation UI는 사용할 수 있으나 모델 출력으로 자기 정답을 만들지 않는다.
- 작업량이 감당되지 않으면 **릴리스할 셀을 줄인 명시적 scope revision**을 부모에게 검토받는다. 표본/임계치/독립성을 낮춰 기존18셀을 통과 처리하지 않는다. 이 기획의 점수를 위해 개발 일정이 짧다고 표현하지 않는다.

최초 R1은18셀을 기준으로 계획하되 R1의 광범위한 버전 지원이나 R2의 출시일을 확정하지 않는다. 첫 구현은 T00 pilot+T01/T02/T03의 안전 기반부터 시작할 수 있고, 이 문서가 생태계 모든 조합을 구현하라는 지시는 아니다.
