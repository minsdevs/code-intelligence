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
