# Verify an AIX connection and release candidate

The package versions remain **0.1.0**. This tooling prepares local artifacts and CI
artifacts. It does not publish to npm/PyPI, create a tag or GitHub release, issue a
credential, or change an AIX account. A successful check is evidence only for the
specific layer it exercised.

## Local package verification

Use Node 22 or 24 and Python 3.11+ for release tooling. Python package CI also runs
its test suite on 3.10–3.14; JavaScript CI runs on Node 22 and 24 because current
framework adapter development dependencies require Node 22. The package's Node 18+
core runtime claim is not covered by this CI matrix.

From the repository root:

```sh
npm ci --prefix packages/aix-js
python3 -m venv .venv
.venv/bin/python -m pip install -e './packages/aix-python[test]' build twine
.venv/bin/python scripts/verify-release.py --version 0.1.0
```

This runs both existing package suites, JavaScript type checking, controlled HTTP
probe fixtures, and release validator tests. It cleans/rebuilds JavaScript, packs
the actual npm archive, builds Python's sdist and then its wheel from that sdist,
checks versions/names/license/types/exports, runs `twine check --strict`, and installs
both built packages in temporary directories for offline import/no-key smoke tests.
The generated `.artifacts/0.1.0/verification.json` records the commit, dirty state,
requested tag (if any), and artifact SHA-256 values. It is not a provenance signature.
The output directory must be new or empty; use `--output` to keep another run.

The validator requires the same exact `X.Y.Z` version in the JavaScript manifest,
both lockfile locations, and Python project metadata. It rejects mismatched artifact
metadata and missing package entry points. Tests and builds need installed development
dependencies; the script never installs project dependencies on your behalf. Building
and temporary package installs may fetch public registry dependencies.

## Tag verification without publication

The `SDK checks` workflow runs package tests on pull requests and main, then verifies
artifacts. `Verify release artifacts (no publication)` can also be run manually with
an exact version. A future push of an already authorized `vX.Y.Z` tag runs the same
verification and requires that tag to point at the clean checked-out commit:

```sh
.venv/bin/python scripts/verify-release.py --version 0.1.0 --tag v0.1.0 --output .artifacts/tag-check
```

That command **does not create a tag**. It fails unless the tag already exists locally
and matches HEAD and the package versions. The workflow only reads repository contents
and uploads build artifacts. There are no npm/PyPI credentials or publication steps.
Tag creation, a version change, publication, and any live deployment remain separate
reviewed release actions. Do not re-publish an existing 0.1.0 registry version.

## Opt-in connection probe

The probe uses Node's HTTP client directly, independently of the SDK suites. It makes
only these requests:

| Mode | Requests | Required environment |
| --- | --- | --- |
| `public` | GET `/api/aix/mcp/server-card`; unauthenticated MCP `initialize`, expecting a 401 Bearer challenge | `AIX_PROBE=1` |
| `api` | GET `/api/aix/activity?days=1` | `AIX_PROBE=1`, `AIX_API_KEY` |
| `mcp` | MCP `initialize`, `notifications/initialized`, `tools/list` | `AIX_PROBE=1`, `AIX_MCP_TOKEN` or `AIX_API_KEY` |

```sh
AIX_PROBE=1 node scripts/probe-connection.mjs public
# Reuse an existing server-side sender OR receiver key from your environment:
AIX_PROBE=1 AIX_API_KEY="$AIX_SENDER_KEY" node scripts/probe-connection.mjs api
AIX_PROBE=1 AIX_API_KEY="$AIX_RECEIVER_KEY" node scripts/probe-connection.mjs mcp
# An OAuth-capable client must obtain its own AIX-audience token first:
AIX_PROBE=1 node scripts/probe-connection.mjs mcp
```

For the last command, load `AIX_MCP_TOKEN` through your existing secret handling first.
The probe never performs browser sign-in or refresh, mints a machine token, or requests
a new key. The API mode needs an AIX key; a delegated Clerk MCP token is not an API key.
The legacy machine-token contract and the Clerk MCP contract have different audiences
and scopes. Use a credential intended for the endpoint being checked.

The default origin is `https://aix.brambles.ai`. `AIX_PROBE_BASE_URL` can select a trusted
HTTPS origin for a preview; credentials are sent to that origin, so inspect it before
running. Only an origin is accepted, with no path/query/user info. HTTP loopback is
allowed for local fixtures. Redirects are refused. `AIX_PROBE_TIMEOUT_MS` defaults to
10000 per request (50–60000 accepted); each response is capped at 1 MiB. JSON and MCP
SSE responses are supported. Exit 0 means that mode passed; exit 1 gives a concise
failure without printing tokens, activity bodies, tool schemas or server error text.

No mode calls an MCP tool, reads receiver secrets, sends intent, creates a test delivery,
acknowledges anything, redeems a handoff, follows an AIX/store link, reports an order,
changes billing or causes a campaign charge. Authenticated requests can still create
normal server access/rate-limit/authentication audit records. They consume no business
operation beyond the listed reads/protocol messages.

## Sandbox exercise (separate from the read-only probe)

Use **existing** sandbox sender and receiver keys for an organization/app that is already
enrolled with current terms. Do not issue keys or accept terms as part of verification.
Confirm both have `aix_test_` prefixes before a separate, deliberately authorized write
exercise. Never silently fall back to `aix_live_` keys.

1. Install the actual candidate npm archive and Python wheel, or deliberately select
   the published registry versions and record which you used. Record package version,
   artifact digest, environment, date and client/runtime.
2. Follow each package README to submit a synthetic shopping task with a unique test
   session id and a public HTTPS store destination. Use synthetic requirements only.
3. Report its sandbox handoff, then pass the id directly to the receiver's sandbox
   redemption method as the documented test flow. Do not open or prefetch the returned
   AIX link or store URL. Sandbox redemption can create a free test delivery.
4. Verify its signed receipt against the pinned issuer, receiver audience and delivery
   reference. Verify a webhook signature using the existing server-side receiver secret,
   or use pull mode. Check the sender's task reaches the matching receiver, including
   cross-organization/wrong-audience refusal.
5. Acknowledge only what the test server actually verified or applied. If a sandbox
   outcome is recorded, label it synthetic; do not represent it as a real order or sale.
   Record expected sandbox zero charges separately from any unknown live economics.

Those steps are documentation, not actions performed by the probe or CI. A local mocked
transport test does not establish sandbox, webhook delivery, merchant, or paid evidence.

## Evidence still required before a complete connection/release claim

- **Authenticated sandbox:** read-only probes for an existing sender and receiver;
  paired candidate-package sandbox exercise above; receipt/signature and webhook/pull
  parity. Preserve test/live separation and tenant-denial results.
- **Real MCP clients:** connect the canonical `https://aix.brambles.ai/api/aix/mcp`
  resource from each supported client; record client/version, login/consent, scope
  escalation, app selection, test default, explicit live selection, role/membership
  revocation, reconnect/refresh, and denial for customer-reporting tokens. `tools/list`
  with a supplied token proves none of that browser flow. Delegated Clerk settings and
  deployed server support must be verified separately.
- **Real merchants:** approved merchant integration evidence for actual webhook receipt,
  signature/receipt verification, applied context and legitimate completed-order flow.
- **Paid production:** a separate explicit capped authorization, legitimate transaction,
  and reconciliation of delivery/charge/outcome/payout ledgers. Never manufacture clicks,
  visits or orders to fill this gap. No paid validation belongs in this probe or CI.

As of this tooling candidate, controlled fixtures and local package/build checks are
automated; authenticated sandbox, external-client sign-in, real-merchant and paid results
are not recorded here. CI configuration is separate from an observed green GitHub run.
