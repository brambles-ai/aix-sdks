# Changelog

## 0.1.1 — unreleased candidate

Both `@brambles-ai/aix` and `brambles-aix` move together from the published 0.1.0
baseline. No tag, GitHub release, npm/PyPI publication or production deployment is
created by this candidate.

- Fix Python 3.10 `TypedDict` runtime metadata so `NotRequired` wire fields stay
  optional, using the already declared `typing_extensions` dependency.
- Add package CI, exact-version/tag artifact verification, installed-package smoke
  checks and an opt-in read-only API/MCP connection probe.
- Upgrade only development tooling to Vitest 4.1.12 with its existing Vite 7 peer,
  resolving the observed audit findings; pin CI actions to verified immutable SHAs.
- Document separate sandbox, real-client OAuth, merchant and capped paid evidence.

Runtime dependency requirements, runtime engine support and the HTTP/client APIs
remain unchanged. The release tag must point at the final reviewed source commit;
follow [release verification](docs/verification.md#tag-verification-without-publication)
from that clean tag before any later authorized publication. Never republish 0.1.0.
