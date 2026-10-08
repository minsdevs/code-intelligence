# w21 — TS 실제 session 성능 조사 (2026-10-08)

- 기준: 공개 main `6ddeefb`, 유닛 `f66057a164fdcf99e42d8e920957cf166d8a0627`.
- 실측 후보: `p6yGme`, product source `f0b983f`, baseline `tZgvV7`. 과거 `h7hpw4`/w17 수치는 현재 후보 시간으로 대체하지 않는다.
- 증거: `validation/local/w21-adapter-perf/`. 기존 w17 감사 및 `w17-adapter-incremental/validation/local/w17-adapter-incremental/coordinator-final/verify.log`를 읽었다. 원래 `memory://root/memory_summary.md`는 이 작업자에서 존재하지 않았다.
- 실제 large fixture는 `run-Fn31Fu/result.json`의 **50,000파일 / 209,715,200 bytes (200 MiB)**다. brief의 250 MiB는 coordinator가 오기로 정정했으며 generator·seed·목표를 바꾸지 않았다.

## 초기 profiler 관찰

`npm run build` 뒤 실제 `dist/stdio.js`의 새 프로세스마다 handshake와 `open/put/seal/analyze/page/close`를 사용했다. input은 backend와 같은 TS/JS/config 전체 목록, chunk는 JSON 기준 1 MiB다. 실제 generator `g-perf-1`, 기본 1% revision mutation을 사용하고 변경 refresh 전체 canonical JSON SHA-256를 새 cache 없는 full session과 비교했다.

`baseline-medium.log`는 다른 작업과 겹쳐 load1 10.93–27.10이었다. **시간 비교·SLO 근거로 사용하지 않는다.** CPU sample/소유 cache 동작의 원인 진단용이다.

- medium TS/config 5,503개, 26,271,681 source bytes. 결과 token 5,499개 모두 보관, backend 문자수×2 비용 15,771,406 bytes, eviction/oversize 0.
- refresh 인증 envelope 5,499개 승인; 실제 decode 2,930개 모두 성공, 호출 64 MiB 중 40,272,018 bytes 잔여. result reuse 2,330 / metadata reuse 581 / compiler 입력 합계 5,069 (cold 9,546). cap/HMAC/해제 실패로 reuse가 줄어든 것이 아니다.
- cold profile의 `collectManifestFacts` self sample 1,237,134 µs. provider마다 program 전체 method map을 prefix scan하는 중첩 순회가 확인됐다.
- cold/refresh `writtenBindings` inclusive sample 4,308,860 / 2,679,332 µs. React route가 없는 program에도 write-binding 증명을 미리 계산했다. 이 값은 겹친 CPU sample이며 wall-time 개선치가 아니다.
- 독립 full canonical equality 통과: `80f561e0c6ac6578c86ef70d1c7315c9059bd49b658cccbc58a75720d57bf264`. 원문/토큰/인증키는 로그에 쓰지 않았다.

## 변경 경계

- `semantic-extractor.ts`: metadata 소비자용 method 목록을 정확한 owner로 한 번 묶는다. method name의 quoted/computed dot을 자르지 않으며 기존 declaration/map 순서를 유지한다.
- `react-component-binding.ts`: JSX component proof가 처음 필요한 때에만 전체 program write set을 계산한다. 조회 파일 범위·write 판정·ambiguity·scope 증명은 줄이지 않는다.
- consumer 회귀: provider alias/overload/동명 class/점 포함 method, unsupported element 뒤 valid route 및 다음 route의 write proof/전체 cold·warm equality.
- `AdapterResultCache`, Tree caller, SourceParsing, outcome loop, GraphPersistence, desktop bridge/supervisor는 변경하지 않는다. 신규 migration 없음.
- 50k/512 MiB source, request 10 MiB/chunk 1 MiB, 기존 source/root 증명, HMAC-before-inflate, 4 MiB/entry·64 MiB/call decode, owner 16 MiB, unknown/transitive/SCC/global/Nest 의미는 유지한다. cap 증가는 없다.

## 제한

packaged workload의 `resultEqualsFull=null`/`NOT_RUN`은 그대로다. 단독 session equality를 packaged graph equality로 주장하지 않는다. 전체 suite·새 packaged candidate·최종20회·실계정/실사용 profile/Keychain·paid AI·signing/notary·Actions·push는 **NOT_RUN**이며 릴리스 판정은 변경하지 않는다.
