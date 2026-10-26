# Main-process startup loading study (2026-10-26)

The recommended stack reduces median idle V8 heap by 4.44 MB and median RSS by 5.87 MB in this Linux workload. Keep M3 (per-group RPC implementation loading) as a separate experimental draft: adding it increases loaded chunk count and memory in the full app. macOS physical-footprint savings remain unverified.

## Comparison and method

- Base: `15a1ff75fc5db5caff151b8b90ed50700ef262ac`.
- Recommended: `e36de62ce0e` (M1, M2, M4, M5, M6 and the benchmark; runtime build `6778f87122c`).
- RPC experiment included: `49e90c468ed` (M1–M6 and the same benchmark).
- SSH/lifecycle attribution: `759b6b2cf64` (M1/M2 only). The recommended and RPC-inclusive trees differ only by the 14-file M3 change.
- Linux x64, Electron 43.8.1, production electron-vite bundles under the development runtime; isolated fresh HOME/profile, telemetry disabled, GPU disabled, Xvfb, one hidden renderer.
- Three fresh launches per build; sample 120 seconds after the first renderer's DOM content is loaded. Builds use the same pinned source base and dependencies. Baseline runs preceded candidate runs; they were not interleaved. Other tests were running on this host, so startup timing and small RSS differences are not causal performance evidence.
- Sample `process.memoryUsage()`, Electron process-memory information, V8 heap statistics, and the actual CJS cache. No heap snapshot or forced GC. Measurements cover the main process, not the whole process tree.
- MB means 1,000,000 bytes. Electron's reported KiB values are converted using 1,024 bytes/KiB.

| Main-process metric              | Base median | Recommended median | With M3 median |
| -------------------------------- | ----------: | -----------------: | -------------: |
| V8 heap used                     |   50.893 MB |          46.453 MB |      46.924 MB |
| V8 heap capacity                 |   53.711 MB |          48.845 MB |      49.152 MB |
| RSS (`memoryUsage`)              |  270.610 MB |         264.741 MB |     270.647 MB |
| Electron-reported private memory |  121.303 MB |         117.563 MB |     125.121 MB |
| External memory                  |   16.012 MB |          14.974 MB |      17.062 MB |
| Loaded main CJS files            |         172 |                216 |            417 |
| Bytes in loaded main CJS files   |   12.284 MB |          12.154 MB |      11.849 MB |
| Loaded dependency CJS files      |         234 |                109 |            109 |
| Loaded SSH2 files                |          21 |                  0 |              0 |
| Loaded PostHog files             |          28 |                  0 |              0 |
| Loaded YAML files                |          72 |                 72 |             72 |

Per-run heap used (MB): base `50.877, 50.893, 50.895`; recommended `46.468, 46.453, 46.451`; with M3 `46.924, 46.942, 46.911`. Per-run RSS (MB): base `271.471, 267.411, 270.610`; recommended `264.741, 263.381, 265.314`; with M3 `270.647, 272.306, 269.730`.

M1/M2 alone produced medians of 48.183 MB heap, 265.642 MB RSS and 118.100 MB reported private memory. It loaded 215 main CJS files. The remaining recommended changes reduce heap further and remove PostHog; M4/M5 do not make xterm or YAML cold in this workload.

### Why M3 is held

Compared with the recommended stack, adding M3 yields 201 more loaded main CJS files, +0.471 MB median heap, +5.906 MB median RSS, +7.557 MB median reported private memory and +2.089 MB external memory. Its loaded main-file source bytes fall by only 0.305 MB. The standalone registry import graph improves, but much of that implementation code remains reachable through the runtime inheritance chain. The generated metadata and finer bundler partitioning introduce additional startup work.

The observation is sufficient to withhold this memory optimization from the recommended stack. It does not identify the allocator responsible for every native byte. A revised design needs a full-app win before promotion; do not infer that from its isolated source graph or cold registry test. The implementation and contract tests remain reviewable in the separate draft.

The main-file count reflects bundler partitioning, not enabled services. Fewer dependency files do not by themselves establish a native-memory win. These sequential, non-interleaved Linux runs show a modest improvement for the recommended workload; they do not establish the proposal’s 10–13 MB macOS footprint estimate. Packaged releases, retained profiles, native Windows/macOS execution and actual mixed-version fleets remain unmeasured here.

## Boundaries and correctness

1. **M1 / quit lifecycle:** the quit controller imports an ordered registry, and initialized owners register their existing drains. Named phase positions preserve the update veto, synchronous SSH-detach/final-save ordering, daemon disconnect versus shutdown, metadata cleanup and deadlines. A second review caught a late-first-owner shutdown regression; explicit passed-phase admission checks now reject those starts without eagerly importing owners or replaying callbacks.
2. **M2 / SSH and managed hosts:** IPC names and passive reads are available immediately. A shared retryable loader owns active transport, migration, tunnel and forward restoration. Saved managed targets still initialize before renderer/serve publication. Cleanup registers before side effects. Obsolete tunnel requests retain cancellation records only until their pending start settles, then remove them in `finally`.
3. **M3 / RPC (separate experiment, excluded):** static generated names, permissions, schema identities and streaming flags stay synchronous. Seventy implementation groups load on dispatch, with single-flight/retry behavior and cancellation checks that prevent late streaming subscriptions. Exhaustive parity covers 777 declarations and both compile switches. The standalone registry source graph shrinks from roughly 3,508 files to 486, but that does not mean those files all leave the full application graph.
4. **M4 / history:** only eligible incremental replay imports its emulator. Missing/header-only histories stay cold. Load/constructor failures preserve checkpoint fallback, and all paths release replay admission.
5. **M5 / YAML:** shared parsing/normalization is unchanged, renderer/CLI retain their ESM facade, and main uses a synchronous first-use loader. Limits and recipe contracts remain intact.
6. **M6 / telemetry:** startup capture is bounded to 100 validated events; a single transport starts after the existing first-window deferral (15-second headless fallback). Consent is checked before and after loading, disabled/unofficial sessions create no client, and shutdown prevents late construction. Explicit opt-in can start immediately.

## Runtime and contract checks

- Both Linux builds passed. Final changed-code gates: PENDING (recommended and RPC-inclusive trees).
- M1: 18 quit/fence tests, 77 existing owner tests, and 7 independent rereview tests passed; Node typecheck and commit checks passed.
- M2: 290 focused tests passed across registration, first use/retry, partial initialization, shutdown, managed-target and forward restoration, auth, reconnect, cancellation, RPC/prechecks and linking. Node typecheck and relevant ratchets passed.
- M3: catalog verification, Node typecheck, cold-bundle zero-implementation enumeration, 70-group metadata parity, compile switches, stream cancellation, serve/remote and CLI/mobile tests passed. Initial broad-run failures were corrected (subscription readiness assumptions and missing local `lsof`); all failing files passed their controlled rerun. An individual 21-check gate passed before a final test-only import relocation; the final combined gate owns committed-tree coverage.
- M4/M5: existing history tests and real-emulator/load-failure controls passed; 452 YAML/Hermes/update/model tests passed (one skipped).
- M6: telemetry suites and nine transport startup/consent/queue/retry/shutdown tests passed. Independent review found no remaining blocker after the history fallback fix.
- Actual recommended and RPC-inclusive fresh renderer IPC: SSH2 files `0 → 21` on first `testConnection`. A synthetic refused endpoint returns `ECONNREFUSED`; a separate loopback SSH2 server authenticates and returns `status: connected`, then the probe disconnects. This proves transport loading and handshake, not real managed-server deployment, SFTP, live forwarding or production auto-reconnect.
- Actual local runtime socket (both builds): `host.platform` and `status.get` return successful replies through lazy RPC dispatch.
- Playwright CDP rendered check: initial desktop and SSH settings/add-host/test flow render successfully; the connection-refused toast is visible. All app windows remain hidden on an isolated display. No UI layout/style changed.

## Remaining eager graph and follow-up design

`main-process-ready` still reaches `main-process-ready-runtime` → `main-process-runtime-service` → `OrcaRuntimeService`. The service is an inheritance chain, and `pty-terminal-summary` itself extends orchestration/terminal owners rather than importing only a small summary function. Those layers statically reach `headless-terminal-state`, `provider-buffer-capture`, `terminal-visible-state`, and `HeadlessEmulator`. Durable checkpoint/replay owners provide another emulator path. M4 therefore removes one edge, not the idle xterm library.

Moving the whole runtime import until ready would shift module initialization to services startup, with no demonstrated full-idle saving. The next useful boundary is composition of optional command owners behind stable contracts. M3 shows why that must remove full-app eager owners before adding a fine-grained loader manifest. For example, `integrations/linear/linear-commands` constructs `RuntimeLinearCommands` per runtime, while `runtime-linear-command-surface` imports concrete classes and walks prototypes to install its surface. A lazy command owner would need a lightweight static method contract and preserved receiver/override behavior; moving just the getter would leave the prototype-import edge. Measure full-app script/heap/native effects before expanding that refactor.

YAML remains loaded by required Hermes hook/config refresh in a fresh profile. Delaying that refresh past its correctness deadline solely to remove YAML from a sample is not justified. M5 provides a main-only loading policy, with no idle saving attributed to this workload.

Making xterm truly cold requires changing synchronous runtime terminal creation, or introducing a supported lazy composition seam. Preserve ingestion/write ordering, renderer hydration/live overlap, cancellation generations, query replies, ConPTY behavior, daemon recovery and mobile provider snapshots. This is a separate terminal-lifecycle change, disproportionate to the proposed 0.65 MB without stronger evidence.

## Performance audit coverage

- **Skipped work:** traced full-app and standalone registry graphs, built chunks and actual runtime caches. SSH/PostHog are cold; YAML/xterm remain live for the owners above.
- **Ownership:** quit tasks replace by phase/name; loaders are process-owned and shared; RPC caches are bounded by the fixed group manifest; telemetry owns one client and at most 100 queued captures. No per-workspace polling or service instance was added.
- **Thread/storage:** first-use compilation remains on main. Parsing and synchronous semantics are retained where required. No new subprocess or filesystem scan cadence is introduced; module load deferral is not a background-thread claim.
- **Growth/progress:** failed loaders clear their in-flight promise; caller teardown releases streaming waiters and pending tunnel cancellation records. No removed-target tombstone map persists indefinitely.
- **Host:** cross-platform/remote paths and unchanged wire contracts reviewed; Linux executed. Windows/macOS and actual mixed-version fleets are evidence gaps, not local passes.
- **Obsolete work:** deterministic tests cover quit during load, partial initialization, first owner after quit, canceled streaming admission, tunnel removal, and telemetry consent/shutdown races. Existing durable unary operations preserve their accepted-work behavior.

## Reproduction

```sh
ORCA_BACKGROUND_LAUNCH=1 pnpm build:electron-vite
DISPLAY=:96 ORCA_BACKGROUND_LAUNCH=1 node tests/tools/benchmarks/main-startup-loading-bench.mjs \
  --app-root /absolute/path/to/build --output /tmp/main-loading.json --runs 3 --idle-ms 120000
ORCA_BACKGROUND_LAUNCH=1 pnpm check:changed --maxWorkers=2
```

Use an owned isolated display on Linux; omit `DISPLAY` on other hosts. Each benchmark run creates and removes its own HOME/profile, rejects any presented window, and terminates only its captured process tree. Copy `out/` before changing build revisions and keep native/package dependencies matched. Use the macOS physical-footprint rig for the original footprint claim; Linux RSS must not be substituted for it.
