# Opaline Solver

A standalone companion server for [Opaline](https://github.com/verback2308/Opaline).
It implements the app's existing solver protocol; no iOS changes are required.
Node.js 24 runs the API, with separate child processes for EJS solving and each
BotGuard client (`TVHTML5`, `WEB`, `MWEB`). Docker deployment includes Caddy HTTPS.

## Deploy

Use a Linux amd64 or arm64 host with Docker Engine and the Compose plugin. Allow
about 2 GB RAM and two CPU cores. Point a DNS name at the host and open TCP 80/443
and optionally UDP 443. This service needs outbound HTTPS access to YouTube,
Google's BotGuard resources, and the Web Anti-Abuse API.

```sh
cp .env.example .env
```

Generate a 256-bit random secret with Node.js (`npm run --silent secret`) or:

```sh
openssl rand -hex 32
```

Edit `.env`, setting `SOLVER_DOMAIN` to your bare DNS name and `SOLVER_SECRET` to
the generated value. Keep this file private. `GENERATE_IT_ENDPOINT=google` preserves
the original preferred route. Set it to `youtube` to prefer YouTube's hosted
`/api/jnn/v1/GenerateIT` route instead. Both choices keep Opaline's API unchanged.
An invalid value prevents startup. Then:

```sh
docker compose up --build -d
docker compose logs --tail=50 solver
```

Caddy obtains and renews a trusted certificate automatically. Only Caddy publishes
host ports; the Node API remains on the internal Docker network. `.env` and Docker
configuration contain the secret; treat access to the host and Docker daemon as
privileged access. The included configuration omits access logs and redacts URI
and headers from proxy error logs. Avoid enabling additional request logging.

In **Opaline → Settings → Debug → Solver Server**, save:

```text
https://your-domain.example/YOUR_SECRET
```

Do not add `/solve` or another endpoint to the base URL. Avoid sharing screenshots
or exported app logs containing this URL: the path is the authentication token.
Opaline's own client-side logging is outside the server's redaction boundary.
To revert, choose **Reset to default** in the same settings dialog.

## API

Every public route is a JSON `POST` underneath `/<SOLVER_SECRET>`.

| Route | JSON request | JSON response |
|---|---|---|
| `/solve` | `{"jsUrl":"/s/player/.../base.js","n":["challenge"]}` | `{"solved":{"challenge":"answer"}}` |
| `/solve` | `{"jsUrl":"/s/player/.../base.js","sig":["cipher"]}` | `{"solved":{"cipher":"signature"}}` |
| `/sts` | `{"jsUrl":"/s/player/.../base.js"}` | `{"sts":20739}` |
| `/get_pot` | `{"content_binding":"device-or-video-id","client":"TVHTML5","bypass_cache":false}` | `{"poToken":"..."}` |

`jsUrl` accepts relative paths and absolute `https://www.youtube.com/s/player/...`
URLs. Redirects, other hosts, credentials, nondefault ports, queries, fragments,
and encoded paths are rejected. `/sts` reads the exact requested file; it never
substitutes the web player's timestamp for the TV timestamp.

`n` and `sig` may be supplied together when their challenge strings are distinct.
Requests accept at most 16 challenges total, 4096 characters each, and a 64 KiB
body. Unknown fields and unsupported clients fail with HTTP 400. Duplicate strings
within one challenge kind are deduplicated. Standard base64 TV bindings, including
`+` and `/`, are preserved. Bindings are required and are at most 256 characters.

Failures return `{"error":"category"}` with HTTP 400/413/415 for invalid requests,
429 for rate limiting, 502 for upstream/extraction failure, 503 for overload, and
504 for a worker deadline. Wrong or missing secret paths return 404. The API does
not echo inputs or upstream error bodies. A failed challenge is never returned
unchanged as a successful solve.

## Runtime behavior

- EJS 0.8.0 is vendored with its dependency notices. TV's obfuscated URL factory is
  exposed to EJS using a source-derived AST adapter. No player hash or minified
  function name is hardcoded. Unrecognized builds fail explicitly.
- Four exact player URLs are cached for up to 24 hours per solver worker. Source,
  prepared transform and timestamp remain paired. Downloads are limited to 8 MiB,
  prepared code to 16 MiB, and download time to five seconds.
- Each client gets its own persistent token worker, page context, integrity state
  and 256-entry binding cache. Tokens expire within 25 minutes or sooner with the
  integrity state. `bypass_cache` replaces integrity state and clears that client's
  token cache before minting. A nonempty `EVENT_ID` is required. WEB/MWEB must use
  the embedded challenge from the same page; TV retains its client-specific
  `/att/get` path when the TV page omits a challenge. A missing BotGuard minter is
  reported explicitly before requesting an integrity token.
- A recoverable mint failure gets at most one retry with a new page/challenge,
  DOM, snapshot and integrity state; stale token caches are cleared. Network or
  integrity-route failures switch to the other GenerateIT endpoint on retry.
  Other recoverable BotGuard/mint failures retry the configured route. Invalid
  client context, missing `EVENT_ID`, unsafe interpreter URLs and malformed page
  data fail without retry. Every attempt preserves the client's original binding.
- Both attempts share a 12.5-second budget, shortened by time already spent in the
  worker queue. No retry starts with less than 1.5 seconds left. Downloads observe
  cancellation; an exhausted budget returns `mint_deadline` (504) and retires the
  worker so pending browser work cannot affect a later request. There is still
  a fourteen-second supervisor deadline including queue time. These retries
  recover token creation failures; they cannot replace tokens already cached
  by Opaline or react to SABR responses seen only by the app.
- Identical in-flight requests share work. A single solver lane also serializes
  preparation so `/sts` and `/solve` reuse one download. Requests have a seven-second
  solver deadline or fourteen-second token deadline, including queue time. Each
  lane has at most 16 queued jobs; there are at most 32 unique in-flight requests.
- The API allows a burst of 120 authenticated requests, replenishing two per second.
  Workers are killed on timeout, have a 384 MiB JS heap limit, and recycle after
  256 completed jobs. They do not inherit the secret or host credentials. Docker
  supplies a non-root, read-only runtime with dropped capabilities and resource
  limits. Process isolation is not a guarantee that Node's `vm` is a security sandbox.

Startup warms the current `tv-player-ias-tcl` build and a throwaway TV token, then
repeats every fifteen minutes. It also handles builds requested by devices, which
can differ from the server's advertised build. Failed warmup leaves the API running
so subsequent valid requests can recover. Stop/start clears all caches.

## Health and troubleshooting

Health routes are internal and Caddy does not expose them:

```sh
docker compose exec solver node -e "fetch('http://localhost:8080/health/ready').then(async r=>console.log(r.status,await r.json()))"
```

`/health/live` reports process availability and drives the container health check.
`/health/ready` returns 200 only after TV solve and TV mint probes have succeeded;
otherwise it returns 503 with capability flags. `playbackVerified` remains `false`:
a generated token does not establish CDN acceptance. A currently failing request
or scheduled warmup clears the corresponding TV capability flag.

Logs contain operation, player build, duration, cache outcome and an error category.
They omit bindings, challenges, tokens and secret paths. Common categories:

| Category | Next action |
|---|---|
| `unsupported_player`, `unsupported_tv_player`, `challenge_failed` | Run probes and update the pinned solver/adapter with new fixtures. |
| `client_context_mismatch`, `page_event_id_missing`, `botguard_challenge_missing` | Check whether the requested client's page still supplies the expected context and challenge. |
| `botguard_minter_missing`, `botguard_initialization_failed`, `botguard_snapshot_failed`, `integrity_token_rejected`, `token_mint_failed` | Both attempts failed or there was insufficient time to retry; inspect upstream compatibility and connectivity. |
| `page_data_incomplete`, `page_config_invalid`, `page_challenge_invalid` | The page data is malformed or exceeds the 2 MiB extraction limit. |
| `upstream_unreachable`, `upstream_timeout`, `upstream_http_error` | Check DNS, outbound networking and whether the host is being refused upstream. |
| `worker_timeout`, `mint_deadline`, `busy` | Check host resources and concurrent requests. |

The server accepts no account credentials or cookies, and does not proxy video
media. It sends only its own public-page context and the supplied binding/challenges
upstream. Moving the server to another network can affect token acceptance; verify
playback from the actual device and network you intend to use.

## Develop and test

```sh
npm ci --ignore-scripts
npm test
npm run fixtures
npm run test:fixtures
npm run probe
```

The first test suite is offline and uses temporary loopback listeners. It covers
both integrity routes, fresh retry state, strict page/minter validation, preserved
bindings, canceled downloads, retry limits and worker recycling. Fixture
download is explicit and hash-checked; immutable player sources are stored locally
under ignored `tests/players/`. Fixtures cover different TV/web transforms and
timestamps for build `0229cd64`, plus a simulated player rotation. Do not commit
downloaded YouTube player files. `probe` discovers today's TV build and measures
cold/warm solving and all client mints, including TV bypass; it prints no tokens.

With Caddy installed:

```sh
npm run test:proxy
# Or: CADDY_BIN=/path/to/caddy npm run test:proxy
```

This starts temporary localhost HTTPS with a temporary local CA, without installing
the CA into your trust store. It checks routing and forced proxy-error redaction.
With Docker installed, run `npm run test:docker`; this uses a temporary isolated
Compose project on localhost:18443 and includes live upstream calls, then removes
its containers and volumes. Neither test deploys your production instance.

To probe the alternative route, run `GENERATE_IT_ENDPOINT=youtube npm run probe`.
The preferred endpoint may fall back once after a recoverable route failure;
a successful probe alone does not identify which route supplied the token.

For local development, export a generated `SOLVER_SECRET`, then `npm run build`
and `npm start`. This listens on port 8080; use `WARMUP=false` to disable automatic
upstream probes. Direct HTTP development is intended for local testing; configure
Opaline with trusted HTTPS for deployment.

## Acceptance and updates

Before treating an instance as a full replacement, use a signed-in Opaline device
with the custom URL and confirm ordinary TV playback beyond one minute, seeking,
available dubbed audio, and available kids content. Check actual audio/video delivery
and fallback behavior, not just a 200 from `/get_pot`. Repeat on the intended mobile
network. No server-side test can prove these account/device-specific scenarios.

For updates, keep a copy of the previous source/image, update exact dependency
versions and lockfile, update both EJS files together and their hashes/notices, then
run all test suites and live probes. Build and recreate with
`docker compose up --build -d`. Caches need no migration. Rebuild the previous source
to roll back, or reset the app's solver setting.

Rotate a leaked secret by editing `.env`, running
`docker compose up -d --force-recreate solver caddy`, and updating every device's
base URL. The old URL stops working immediately after recreation.

See [VALIDATION.md](VALIDATION.md) for the current verification record and remaining
deployment/device checks. See [vendor/README.md](vendor/README.md) for EJS provenance.
