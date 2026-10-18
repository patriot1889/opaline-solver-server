# Verification record — 18 October 2026

Implementation has been tested on macOS arm64 with Node.js 24.18.0.

| Check | Result |
|---|---|
| TypeScript build | Passed |
| Offline HTTP/cache/worker tests | Passed, 22 tests |
| Hash-checked real-player fixtures | Passed for TV and web `n`, web `sig`, timestamps and rotation |
| TV AST extraction | Passed on current `0229cd64` `tv-player-ias-tcl` build |
| Caddy 2.11.2 production configuration | Validated |
| Local Caddy HTTPS routing and forced-error redaction | Passed |
| Live TV, WEB and MWEB token minting | Passed; generated tokens only |
| TV token cache bypass | Passed with a 12-character standard-base64 TV binding |
| Cold/warm TV probes | Passed within existing app request deadlines |
| Docker smoke and Linux amd64/arm64 builds | Not run locally: Docker is not installed; workflow and smoke script supplied |
| Public deployment and trusted domain certificate | Pending deployment host/domain |
| Signed-in playback, >1 minute, seeking, dubs, kids content | Pending an Opaline device connected to the deployed instance |

An observed cold TV solve took about 1.4 seconds including download and extraction.
A warm solve took 42–46 ms. Cold token minting took approximately 0.7–0.9 seconds;
cached mints took less than 1 ms. These are observations on this host, not latency
guarantees for other hosts or networks. The TV player timestamp was `20739001` and
the web variant's was `20739`; tests deliberately keep them separate.

Do not interpret token generation or readiness as evidence that YouTube accepted
the resulting media requests. The full-replacement acceptance gate is still pending.

## Server-only reliability update

- Both preferred GenerateIT routes were exercised. Direct probes in a fresh
  process for each route/client successfully minted TVHTML5, WEB and MWEB tokens,
  with no route fallback involved in those probes (roughly 0.4–0.7 seconds).
- The default-route cold/warm probe, including TV cache bypass, passed. A repeated
  TV bypass in the YouTube-preferred probe returned `botguard_minter_missing`
  after its two attempts. Later isolated route probes passed. This remains an
  observed runtime/upstream failure; no guarantee of consistent acceptance is made.
- Offline tests exercise one fresh-state retry, endpoint switching after integrity
  rejection, unchanged client/binding, cache invalidation, no retry for invalid
  context, shared deadlines, download cancellation and worker retirement on timeout.
- Real-player fixture tests and the local Caddy HTTPS/redaction smoke test passed
  after the update. Docker/Linux and signed-in device acceptance remain pending.
