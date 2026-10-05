**Languages:** English | [한국어](SECURITY.ko.md)

# Security Policy

## Scope

Code Intelligence analyzes source repositories and can send selected source
context to an external AI provider when AI features are enabled. Treat imported
repositories, API keys, GitHub credentials, database contents, and analyzer
payloads as sensitive.

## Reporting a vulnerability

Do not open a public issue for a suspected security vulnerability. Contact the
maintainer privately through the security contact configured for the repository,
including a description, affected version or commit, reproduction steps, impact,
and any suggested mitigation. Do not include real credentials or confidential
source code in the report.

## Security expectations

- Keep `.env`, provider keys, GitHub tokens, and `TOKEN_ENC_KEY` out of Git.
- Use a unique production encryption key and rotate credentials after exposure.
- Keep the backend on loopback unless deployment access controls and TLS are in
  place.
- Review provider data-use and retention policies before enabling AI for private
  repositories.
- The playground is intentionally non-executing; do not add clone execution or
  arbitrary subprocess behavior without a separate threat model and approval.

## RC local-source and output boundaries

- Local import is authenticated and requires explicit confirmation. Configure
  `LOCAL_IMPORT_ALLOWED_ROOTS` narrowly; an empty value grants no filesystem
  access. Desktop native folder selection grants separate main-process-authorized
  access to the selected project folder. Selecting the home directory itself is
  rejected. Canonical-path, protected-directory, and symlink checks are defense
  in depth, not permission to expose the backend remotely. See the
  [allowlist implementation](backend/src/main/java/dev/codeintelligence/project/LocalImportProperties.java)
  and [local import policy](docs/audit/local-ingest-policy.md).
- Initial import and full refresh require a server-issued, single-use preview
  token bound to the owner, project/base snapshot where applicable, source root
  identity, selection policy/limits, and selected file contents. Unused tokens
  expire after ten minutes; a consumed job uses its persisted approval receipt.
  The worker rechecks authorization and staged contents before replacing the
  managed source. A changed input requires a new preview; matching A/M/D counts
  alone do not grant approval. Imported source remains untrusted and is parsed,
  never built or executed. See the
  [approval contract](docs/audit/e2-approval-contract-2026-10-02.md),
  [approval implementation](backend/src/main/java/dev/codeintelligence/project/LocalSourceApprovalService.java),
  and [copy checks](backend/src/main/java/dev/codeintelligence/project/LocalImportService.java).
- Snapshot comparison, coverage, finding judgments, and export are owner-scoped.
  Export redacts detected secrets and omits source bodies, but review the file
  before sharing it.
- IDE opening is limited to local projects and validated relative paths. Treat
  custom-protocol launch prompts as a local action and verify commit-mismatch
  warnings before editing.
- AI preview makes no provider request and exclusions are applied server-side.
  Once an AI request is approved, selected context still crosses the external
  provider trust boundary.
- The current macOS desktop runtime with backup protocol 3 implements encrypted
  backup/restore for the same installation. Restore validates typed data and
  retained sources in staging; format 1/2 archives, another installation's
  archives, and raw SQL fallback are rejected. Restore revokes credentials,
  sessions, and folder approvals and keeps AI OFF. Normal access resumes only
  after health and recovery checks; unverified interrupted operations retain
  recovery data and block normal startup. The installation identity and required
  keys must remain available: this is not portable key recovery. Analysis export
  is not a substitute for a restorable backup. See the
  [backup runtime](desktop/src/backup-runtime.cjs),
  [backup/restore contract and limits](docs/audit/backup-restore-integration-2026-10-03.md),
  and [remaining release gates](docs/multilanguage-plan-2026-10-02/07-delivery-release-gates.md).
