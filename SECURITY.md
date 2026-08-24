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
  `LOCAL_IMPORT_ALLOWED_ROOTS` narrowly; an empty value allows only the backend
  user's home directory. Canonical-path, protected-directory, and symlink
  checks are defense in depth, not permission to expose the backend remotely.
- Safe refresh revalidates ownership, allowed-root access, snapshot ID, and
  previewed A/M/D counts immediately before enqueueing a full analysis. Imported
  source remains untrusted and is parsed, never built or executed.
- Snapshot comparison, coverage, finding judgments, and export are owner-scoped.
  Export redacts detected secrets and omits source bodies, but review the file
  before sharing it.
- IDE opening is limited to local projects and validated relative paths. Treat
  custom-protocol launch prompts as a local action and verify commit-mismatch
  warnings before editing.
- AI preview makes no provider request and exclusions are applied server-side.
  Once an AI request is approved, selected context still crosses the external
  provider trust boundary.
- User-data backup/restore is not implemented in this RC. Do not treat analysis
  export as a restorable backup of Notes, Tasks, judgments, settings, or keys.
