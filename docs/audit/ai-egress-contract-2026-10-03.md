# Main-owned AI egress core — 2026-10-03

Status: implementation candidate; this module alone does not enable a product or prove a live provider, PostgreSQL, Electron, signed installation, or private-channel integration. It adds no endpoint, renderer IPC, environment switch, real provider credentials, or production price catalog. The parent integration owns those adapters and their separate evidence. The previous disabled integration remains historical evidence, not evidence of this gateway working in the application.

Owned files: `desktop/src/ai-egress.cjs`, `desktop/test/ai-egress.test.cjs`, this contract. Other dirty files and agents' work are preserved. No Gradle, database, Docker, Keychain, GUI, network, paid provider, commit, push, or deployment is used by this task.

## Authority and sequence

Main owns an exact copied wire `Buffer`, validated ModelContract, bounded quote and one-use approval. The backend serializes JSON exactly once and passes base64 over its separately authenticated private channel; the channel adapter strictly decodes it and supplies that Buffer to `prepare`. Main parses it for validation without reserializing it. A public-facing route must authenticate the user, consume the backend RequestPlan approval, and map only the fixed methods below. Renderer tokens cannot substitute for the private channel capability. There is no caller-provided URL, header, SQL, permit, price, actual-cost proof, or `verified` flag.

1. Main prepares a body and returns only typed metadata and hashes, including the conservative reservation amount. User consent must cover that quote before the main-private `approve` call.
2. The backend commits the exact typed V25 reservation. Main's independent committed-read adapter returns the row, the owner's current AI settings and a complete consistent projection. Main compares all owner/project/snapshot/approval/plan/body/price/policy/settings/main-epoch bindings. All existing B obligations must appear unchanged in PG; additional RESERVED PG rows must correspond to exact bodies prepared in this main process.
3. The real journal independently invokes the core's committed-read verification callback. The core returns its private ACK only after the checks above. B fsyncs RESERVED and DISPATCH_INTENT before returning its private single-use permit.
4. Main publishes DISPATCHED from its own immutable journal observation, independently reads back the full projection, then rechecks the committed request and current settings/catalog. It consumes the permit and checks OFF, epoch, expiry and body hash. No await occurs between the final barrier and the sole transport invocation.
5. Main observes bounded provider response bytes. A known usage parser must return every supported billing dimension. Main computes the actual integer charge and a proof digest from its own observation; it publishes that immutable evidence to PG. Journal settlement verification independently reads that evidence and the unchanged dispatch binding from PG and compares them with the private main observation.
6. B fsyncs SETTLED before main publishes the settlement to PG and checks readback. Answer bytes leave main only after this finishes. Subsequent answer/chat persistence failure cannot roll back accounting.

This is an ordinary trusted-main boundary, not a defense against arbitrary execution inside the same main process or a malicious replacement adapter. `transport` is trusted to honor the exact Buffer, no retries/redirects and bounded timeout/response; the production HTTPS adapter must independently enforce origin/TLS/public-address rules. Merely passing these flags does not prove a network implementation honored them.

## Public core facade (private main controller only)

`createAiEgress(options)` is async. Required values are `installationId` (journal-compatible identifier), fresh UUID `mainEpoch`, canonical nonnegative signed-64 decimal `runningBuild`, and the function dependencies below. `clock:{wall,monotonic}` is optional trusted dependency injection, not a product flag. `wall` returns safe integer epoch milliseconds and `monotonic` finite nonnegative milliseconds. Default clocks are Date.now and process.hrtime. A clock rollback blocks and latches; clocks cannot extend a prepared body beyond its original ten-minute lifetime.

| Method | Exact input | Result / effect |
| --- | --- | --- |
| `prepare` | `{requestId,approvalId,planSha256,ownerUserId,projectId,snapshotId,settingsRevision,provider,model,operation,policyRevision,policySha256,budgetDay,expiresAt,outputTokenCap,body}` | Frozen metadata below. `body` is Buffer; `expiresAt` is a safe integer epoch-ms number; IDs/hashes and all long-like counters use canonical strings. CHAT or EMBEDDING only. Preparation is permitted while OFF so a cost can be shown; it does not authorize a send. |
| `approve` | `{requestId,approvalId,payloadSha256}` | One-use approval of an unchanged prepared body/quote; returns matching IDs and `approved:true`. Requires active B. |
| `execute` | `{requestId,payloadSha256}` | One transport attempt at most; `{requestId,payloadSha256,statusCode,body:Buffer,actualMicroUsd,proofSha256}` after accounting. No replacement body. |
| `reconcile` | `{restoreId:UUID}` | Immediately blocks and invalidates pending bodies. With no active request, imports complete PG/B conservative union, publishes it and checks full readback. Stays OFF. This is AI obligation reconciliation, not a claim that application backup restoration has completed. |
| `activate` | `{ownerUserId,policyRevision,policySha256,userApproved:true}` | Main-private explicit consent, complete matching PG/B projection, nonzero budget, current clock/build and no unresolved/legacy/conflict conditions required. Returns diagnostics. Caller booleans from renderer messages are not an authentication mechanism; the integration must deliver actual one-use consent through its private controller. |
| `latch` | no arguments | Immediate memory barrier and pending-body invalidation, durable USER_OFF, PG publication and full readback. |
| `latchOffline` | optional reason: USER_OFF, RESTART_RECONCILIATION or RESTORE | Lifecycle-only durable latch, PG callback count zero. Works before PG/gate exists; keeps recovery diagnostic and makes no projection-success claim. No caller-selected publication mode or projection-success claim. A fixed private USER_OFF command may invoke it; renderer cannot access the facade. |
| `diagnostics` | none | Only `{aiOff,recoveryOnly}`. No key, proof map, sequence, prompt, credential or permit. Initial `recoveryOnly:true` means AI reconciliation pending; it is not by itself whole-app corruption and must not block ordinary local analysis. |
| `close` | none | Immediately bars new work, latches without PG, waits for admitted transports/accounting and closes the journal. Keyring ownership/close is outside this core and must follow journal close. Trusted transport/PG adapters must terminate within their bounds; the core does not pretend that a still-running transport was canceled. |

UUIDs and lowercase SHA-256 strings are canonical. Positive database identities, revisions, token counts, microUSD and wire sizes are decimal strings (no sign, leading zero, float, unsafe JS number or value beyond `9223372036854775807`). Channel session epoch is a separate 64hex value; it is not the UUID `mainEpoch` in cost records.

Metadata, excluding its final payload hash:

```
{requestId,installationId,ownerUserId,projectId,snapshotId,approvalId,planSha256,
 wireBodySha256,wireBodyBytes,budgetDay,priceVersion,reservedMicroUsd,dispatchBinding}
```

`payloadSha256` is SHA-256 of UTF-8 JSON recursively sorting object keys, retaining array order and scalar representation, of the object above. `wireBodySha256` hashes the original exact bytes. `wireBodyBytes` appears both at the top level and inside `dispatchBinding`; both are the same canonical decimal string. V25 stores the binding copy, not body bytes or prompts. The backend adapter must reconstruct the top-level count from that typed binding when checking metadata.

`dispatchBinding` exact fields:

```
{mainEpoch,provider,model,operation,endpointId,adapterVersion,tokenizerId,tokenizerVersion,
 costContractSha256,priceSha256,settingsRevision,policyRevision,policySha256,
 inputTokenUpperBound,outputTokenMax,embeddingInputTokenUpperBound,wireBodyBytes,
 validUntilEpochMs}
```

`validUntilEpochMs` is also a decimal string. It is the earliest requested expiry, main preparation + 10 minutes, and catalog verifiedAt + 30 days.

## Trusted dependency contracts and PostgreSQL wire values

- `openJournal(callbacks)` returns the existing real journal interface. The supplied callbacks are `verifyCommittedReservation`, `verifySettlement`, `verifyActivation` and are implemented by this core. The factory owns enrollment/open selection, safe key lifecycle, exclusive journal ownership, and original durable marker/fail-closed behavior. This core does not initialize an alternate safety directory or bypass enrollment.
- `contractCatalog({provider,model,operation})` is a synchronous local trusted lookup returning the exact ModelContract below or null. No fallback model, invented price, network lookup, environment fixture toggle or implicit zero rate exists.
- `readCommittedRequest(requestId)` returns exactly `{request,settings,projection}`. `settings` is exactly `{ownerUserId,revision,provider,model,state}` with ACTIVE required. The projection and selected request must come from one consistent committed independent DB read and be identical. The request is RESERVED for preflight/journal verification, DISPATCHED after publication; calling the Java RESERVED-only `requireDispatchable` for the second read is incorrect.
- `readProjection()` and `readback()` return exactly `{version:1,complete:true,gate,requests,evidence}`. These flags describe the trusted adapter's read completeness, not an externally accepted verification claim. The core also checks bounded unique rows, all expected B obligations, financial identities and exact journal position/digest. Missing/truncated/unavailable data never becomes an empty list.
- `credentialProvider({ownerUserId,provider,settingsRevision})` returns the credential only to main. It must use the current owner's explicitly configured credential, with no host-environment/default-user fallback. Error text is sanitized. JS string credential erasure is not claimed.
- `commitEvidence(mainEvidence)` persists the observation below, and the independent read verifies it. It must not trust a backend request stating an actual amount.
- `applySettlement({phase,requestId,journal})` is the generic projection publisher despite its historical dependency name. Phases are DISPATCHED, SETTLED, RECONCILE, LATCH and ACTIVATED. Journal is the core's real snapshot, containing safe-number sequence/clock and decimal monetary strings. RequestId is null for whole-journal phases. The adapter independently obtains the private authority view rather than treating message fields as proof. ACTIVATED changes sequence/hash and must be published too. Each publication is followed by independent full readback.
- `transport({requestId,method:'POST',origin,path,headers,body,timeoutMs,maxResponseBytes,redirects:0,retries:0})` returns exactly `{statusCode:number,body:Buffer,providerRequestId:string|null}`. This object never leaves trusted main. Fixed endpoint IDs map only to OpenAI chat/embeddings or Gemini generateContent/embedContent. Production catalog decides which are actually supported. Non-2xx, malformed/bounded-response failure and invalid usage retain the entire hold. HTTP 4xx is not invented proof of no charge.

Projection Gate exact fields match V25/Java: `installationId,ownerUserId,policyRevision,policySha256,dailyLimitMicroUsd,monthlyLimitMicroUsd,reconciliationRequired,legacyLiabilityUnresolved,journalSequence,journalHash,journalProjectionSha256,clockHighWaterMs`.

Projection Request exact fields match Java: `requestId,installationId,ownerUserId,projectId,snapshotId,approvalId,planSha256,payloadSha256,wireBodySha256,dispatchBinding,budgetDay,priceVersion,reservedMicroUsd,status,actualMicroUsd,proofSha256,liabilityFloorMicroUsd,conflict,journalSequence,journalHash`. Restored placeholders may have null original identities/binding. They cannot dispatch. Non-SETTLED rows require null actual/proof. PG has no `dispatchIntent`; the core preserves B's existing bit and never fabricates it from UNKNOWN_HELD/SETTLED status during comparisons.

`MainEvidence` fields: `installationId,requestId,payloadSha256,priceVersion,proofSha256,mainEpoch,receiptType:'USAGE',providerRequestId,usageDimensions:{units:{INPUT_TOKENS,CACHED_INPUT_TOKENS,OUTPUT_TOKENS,EMBEDDING_INPUT_TOKENS,REQUESTS}},actualMicroUsd`. REQUESTS is `'1'`. Persisted Evidence omits installationId/payloadSha256/priceVersion, matching Java/V25. The proof binds request ID, payload/wire hashes, main epoch, price hash, observed provider request ID, response-byte hash, exact usage and actual charge. No response/prompt text is persisted by this module.

`bindAuthority(port)` receives a separate private frozen port, not exposed in the returned facade or renderer. Its synchronous getters return immutable copies and never reenter a work queue or acquire a PG lock:

- `readDispatch(requestId)` → Java DispatchReceipt with installation/mainEpoch + exact five-field reservation + Position, or null.
- `readEvidence(requestId,proofSha256)` → MainEvidence for this main's observed receipt, or null.
- `readSettlement(requestId,proofSha256)` → Java SettlementReceipt after B fsync, or null.
- `readJournal()` → `{installationId,position,budgetDay,restorePending,obligations}`; obligations are B rows excluding dispatchIntent. Position is `{sequence,hash,projectionSha256,clockHighWaterMs}`, all long-like values decimal strings. Gateways must authenticate reverse reads; no caller boolean replaces these getters. The observations exist before corresponding PG publication, avoiding Java adapter callback deadlock.

No fresh-enrollment liability exemption is provided by this port. Existing/ambiguous legacy liabilities require their own verified policy; a fresh-enrollment assertion cannot reset existing data.

## ModelContract and prices

Exact fields: `provider,model,operation,endpointId,adapterVersion,tokenizerId,tokenizerVersion,costContractSha256,priceVersion,priceSha256,verifiedAtEpochMs,inputTokenLimit,embeddingTokenLimit,outputTokenLimit,rates,validateBody,inputBound,readUsage`. VerifiedAt is a safe epoch-ms number, not future and within 30 days. Limits/rates are decimal strings. PriceVersion is at most 96 characters for compatibility with B. The three functions are synchronous, stable function references from the trusted registry; their implementations are reviewed evidence, not serialized code. Their identities and every metadata/rate field are rechecked at approval and dispatch. Changed catalog/quote invalidates consent.

- `validateBody(parsed,{model,operation,outputTokenMax})` must return literal true only for a supported fixed request shape, exact model, enforceable provider output cap and supported billing features. It must reject unpriced additional modalities/tools/caching/reasoning/prediction or parameters which change billing.
- `inputBound(parsed)` returns exactly `{inputTokens,embeddingInputTokens}`. It must be a reviewed upper bound for the exact whole request including provider framing. A fake byte bound exists only in synthetic fixtures. The real catalog's independently verified context ceiling may be a conservative upper bound; it must not be advertised as an exact token estimate.
- `readUsage(parsedResponse)` returns exactly `{inputTokens,cachedInputTokens,outputTokens,embeddingInputTokens}` with every value present as a decimal string. Cached input is included in inputTokens and must be ≤ inputTokens. Omitted cached usage is unknown, not default zero. The adapter must reject unknown billed dimensions and imprecise numeric data; silently dropping provider fields would violate this trusted contract.

Rates are exactly `{inputMicroUsdPerMillion,cachedInputMicroUsdPerMillion,outputMicroUsdPerMillion,embeddingMicroUsdPerMillion,fixedMicroUsd}`. Cached rate cannot exceed ordinary input rate when quoting all input at the ordinary rate. Quote cached count is zero, output is the enforced maximum. Let `N=(input-cached)*inputRate+cached*cachedRate+output*outputRate+embedding*embeddingRate+fixed*1,000,000`.

- Reserve = `ceil(N * 11 / 10,000,000)`.
- Actual = `ceil(N / 1,000,000)` from main-observed usage, with the actual cache discount.

Only BigInt arithmetic is used and the final monetary result must fit signed 64-bit nonnegative microUSD. Unknown/missing prices, unsupported tokenizer/body/cap and overflow cannot yield a zero-cost quote. Known explicit zero rates remain explicit contract data. Overspend is never clamped: the complete known charge is recorded and B latches OFF; unsupported overflow leaves a full unknown hold and blocks.

## Bounds, failure and recovery

Per body ≤1 MiB; main retained body bytes ≤64 MiB; pending plus executing ≤64 and per owner ≤32; admitted transports ≤2. Prepared bodies expire at the earliest bound above, using wall and monotonic clocks, with an unref'ed expiry timer plus checks on every use. Request UUID tombstones and approvals are one-use per core lifetime; durable B/PG IDs and mainEpoch prevent restart replay. B/projection records are bounded to 10,000. The 64 MiB figure is a raw Buffer budget, not a claim about total JS heap including parsed strings and projections.

Strict JSON rejects duplicate decoded keys, malformed UTF-8, unpaired surrogates, prototype keys, arrays at root, extra trailing data, >32 nesting levels, >50,000 object keys and oversize bytes. Response ≤2 MiB; trusted transport deadline ≤60 seconds. Owned body/temporary response Buffers are cleared when released. JS strings, parsed objects, other-process copies, filesystem pages and secure erase are not claimed.

PG/journal/readback failure blocks future sends. If B has an intent, unknown result retains full held liability. If B already settled, later PG/answer failure preserves that known charge; it does not turn it into zero or reopen a permit. All previous UTC bucket unknown holds count against both current daily/monthly budgets. Settled spend counts in the matching UTC day/month. Every operation uses the same two-send and budget path.

Startup is OFF. Reconciliation requires complete PG data and conservative union, retaining B-only obligations and importing PG-only entries as held. Larger PG floors become larger conservative holds; same-UUID mismatches become conflicts. A PG-only settled row is not treated as verified main usage. Ambiguous legacy liability, incomplete projection, conflicts, pending merge, overspend, wrong build/clock or failed readback cannot activate. Ordinary OFF still permits local analysis. This core does not implement full app backup sealing/restore, native rollback protection, provider cancellation, secure erasure, a distributed transaction, or malicious same-user process confinement.

## Validation evidence

Author synthetic tests use Node, fresh temporary directories, the real `safety-journal.cjs`, HMAC/fsync/replay, synthetic keys, explicit fixture contracts and in-memory PG/transport adapters. They do not prove actual PostgreSQL queries, private UDS authentication, production provider pricing/tokenization/HTTPS, OS credential wrapping, UI consent, or end-to-end main integration; those belong to separately reported parent gates.

Historical local candidates: 64/64 PASS at `/tmp/ci-ai-egress-second-2026-10-03.log`; 85/85 PASS including explicit cached-input discounts at `/tmp/ci-ai-egress-cached-2026-10-03.log`. These are candidate results before the final offline-latch/timer additions. The final author run and immutable file hashes will be recorded below after its completion. No production enablement or release Go decision follows merely from these tests.

Initial frozen author gate: **88 tests passed, 0 failed/canceled/skipped** on local Node v26.5.0. Both owned CJS files passed `node --check`. Artifacts: `/tmp/ci-ai-egress-final-2026-10-03.log`, `/tmp/ci-ai-egress-final-2026-10-03.xml`, `/tmp/ci-ai-egress-final-2026-10-03.json`. This is the author core gate only, separate from parent full Node/Java/UDS/app and independent review gates.

Operational integration constraint: every settings-OFF/revision/policy mutation or restore which changes the approved A state must enter the main memory latch barrier before changing PG. An independent read followed by journal permit consumption cannot itself atomically observe an unrelated writer changing settings in that interval. Responses already sent continue accounting after OFF. Expired/abandoned PG reservations are conservatively reconciled as held; this version does not emit PROVEN_NOT_SENT refunds. Trusted adapter deadlines, the actual context/token/usage contract, genuine user-consent routing and private-channel/PG lifecycle wiring remain release requirements.


## Follow-up: OFF wins over outstanding activation

The root review identified a cancellation race: an activation waiting for independent PG verification or ACTIVATED publication readback could report success after a newer OFF had invalidated the process barrier. Two deterministic real-journal tests reproduced that stale success (2/2 failed with missing expected rejection) in `/tmp/ci-ai-activation-off-race-red-2026-10-03.log`. This evidence proves an obsolete activation returned success; it does not prove an external provider send escaped the separate serialized dispatch barrier.

The core now captures its generation when `activate` is called, before entering the queue. It checks that generation before and after independent activation verification, after B activation, and after PG publication/readback before changing the memory barrier. A newer OFF/close/reconciliation rejects the older consent as OFF. Verification returns a normal false acknowledgement on cancellation rather than poisoning an otherwise healthy journal. New explicit consent after a fresh reconciliation remains usable. A third regression covers an activation which is queued when OFF arrives.

Follow-up author gate: **91/91 PASS**, no failures/errors/skips. Narrow RED and GREEN logs are preserved separately. Final artifacts are `/tmp/ci-ai-egress-race-final-2026-10-03.log`, `.xml`, `.json`; both CJS files pass syntax validation. Earlier 88/88 remains historical evidence of the earlier frozen candidate. Wrapper-level reconcile-plus-activate consent is a separate parent integration responsibility: it must invalidate/recheck its own one-use consent across every await before calling this core.
