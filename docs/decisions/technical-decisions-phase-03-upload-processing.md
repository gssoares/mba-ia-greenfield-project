---
scope_type: phase
related_phases: [3]
status: finalized
date: 2026-09-13
scope_description: "Phase 03 — object storage engine and endpoint topology, 10GB resumable upload protocol and browser client, draft pre-registration and upload-completion lifecycle, unique public video IDs, background job queue and video-worker topology, media probing/thumbnail tooling, accepted input formats, streaming format, and playback/download URL delivery."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — owns the storage integration (S3 API client, presigning), the upload orchestration endpoints, the `Video` entity/migration, the job queue, and the video worker (second entrypoint + compose service with FFmpeg). Covered by TD-01, TD-02, TD-03, TD-05, TD-06, TD-07, TD-08, TD-09, TD-10, TD-11, TD-12.
- `next-frontend/` — owns the browser upload client (direct-to-storage part uploads, progress, resume), the BFF Route Handlers that relay the small JSON orchestration calls, and native `<video>` playback / download links fed by URLs issued via the BFF. Covered by TD-03, TD-04, TD-05, TD-06, TD-10, TD-11, TD-12.

> Cross-doc anchors (already decided — do NOT reopen):
> - **Strict BFF, server-only `API_URL`:** `next-frontend-config-base/TD-03`. The browser never calls NestJS directly. Its Context already anticipates that "object storage URLs will need a separate mechanism (presigned URLs from object storage, NOT the backend URL)" — direct browser ↔ storage traffic is compatible with the BFF model; browser ↔ NestJS is not.
> - **Mutations via Route Handler POST + client `fetch`:** `phase-02-auth-frontend/TD-05`. Upload orchestration calls (initiate, sign parts, complete) follow this pathway.
> - **Session & transparent refresh in the BFF:** `phase-02-auth-frontend/TD-01..TD-03`. Authenticated upload calls reuse `callUpstream` + single-flight refresh — a multi-hour upload outlives the 15-min access token, and part uploads to storage carry no app credentials.
> - **Config & env validation:** `phase-01-configuracao-base/TD-01..TD-04` (`@nestjs/config`, Joi, namespaced `registerAs`). New keys (storage, queue) land in a `storage.config.ts` / `queue.config.ts` + the Joi schema.
> - **Error envelope `{ statusCode, error, message }`:** `phase-02-auth/TD-07`. New domain codes (e.g., `UPLOAD_TOO_LARGE`, `UNSUPPORTED_CODEC`) use it.
> - **Validation, OpenAPI, typing, MSW:** `phase-02-auth/TD-06`, `openapi-docs-nestjs/TD-01..TD-03`, `next-frontend-openapi-typing/TD-01..TD-05`, `next-frontend-msw-foundation/TD-01..TD-04`. New endpoints flow through the existing contract chain; a `mocks/handlers/videos.ts` domain file is expected.
> - **Entity conventions:** UUID PK, explicit table name, timestamps (`.claude/rules/nestjs-entities.md`).
> - **Docker networking rule (root `CLAUDE.md`):** server-to-server traffic uses Compose service names, never `localhost`.

Environment facts that constrain every option below:

- **MinIO Community Edition is no longer viable:** console removed (May 2025), Docker images/binaries no longer published (Oct 2025), repository archived read-only (Apr 25, 2026). Existing images run but receive no security fixes.
- **S3 multipart limits:** parts 5 MiB–5 GiB (last part unbounded), max 10,000 parts, max object 48.8 TiB. A 10 GB file fits comfortably (e.g., 64 MiB parts → ~160 parts).
- **Next.js 16 buffers request bodies in memory when `proxy` is used** (`proxyClientMaxBodySize`, default 10 MB). Relaying 10 GB bodies through the Next server is structurally hostile.
- **`fluent-ffmpeg` was archived on May 22, 2025** and is deprecated.

---

## TD-01: Object Storage Engine (S3-compatible)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** The architecture diagram names "S3 or MinIO" for Object Storage. MinIO CE is archived (see environment facts), so the local-dev engine must be re-chosen. Whatever runs locally must implement the S3 features Phase 03 depends on: multipart upload, SigV4 presigned URLs, bucket CORS (browser uploads), byte-range GET (streaming) and ideally a lifecycle rule to abort incomplete multipart uploads (abandoned 10 GB uploads). Application code talks to the S3 API via `@aws-sdk/client-s3` regardless of engine, so the production provider (AWS S3, R2, etc.) stays swappable and is deferred to Phase 07 ("Ambiente de produção e deploy").

**Options:**

### Option A: Garage
- Lightweight Rust S3-compatible store (Deuxfleurs, non-profit). Single container works for dev; buckets/keys are bootstrapped via its CLI (`garage layout assign`, `bucket create`, `key create`) in an init step.
- **Pros:** Official compatibility table lists multipart (Create/UploadPart/Complete/ListParts/Abort), presigned URLs, `PutBucketCors` and lifecycle `AbortIncompleteMultipartUpload` + `Expiration` as implemented. Small footprint (~1 GB RAM class). Non-profit governance, no commercial upsell.
- **Cons:** AGPLv3 (irrelevant when running the unmodified image, but worth recording). No bundled web console. Bootstrap needs a scripted init step in Compose. Partial S3 surface (no versioning-dependent features — not needed here).

### Option B: RustFS
- Apache-2.0 Rust store positioned as a MinIO drop-in: S3 API on `:9000`, web console on `:9001`, single-node Docker image.
- **Pros:** Closest developer experience to MinIO (console, familiar ports). Permissive license. Claims multipart, presigned URLs and CORS support.
- **Cons:** Youngest option (~10 months old in mid-2026), corporate governance with a forming paid tier. Its issue tracker has open questions specifically about multipart-via-presigned-URLs (rustfs/rustfs#1635, #1270) — exactly the Phase 03 path — so compatibility must be proven by us.

### Option C: SeaweedFS
- Apache-2.0 distributed store (master + volume + filer + S3 gateway); a single-process `weed server -s3` mode exists for dev.
- **Pros:** Proven at scale (replaced MinIO as Kubeflow Pipelines' default). Permissive license. Scales horizontally if storage growth becomes a real concern ("Pontos de Atenção — Armazenamento").
- **Cons:** More moving parts and configuration than A/B for a single-node dev need. S3 gateway is one of several interfaces — S3 edge-case fidelity is less of a primary focus than for Garage/RustFS.

### Option D: Pinned last MinIO image
- Keep using the final published `minio/minio` image, frozen.
- **Pros:** Zero learning curve; most tutorials still target it.
- **Cons:** No security patches ever again; image availability is not guaranteed; builds a new foundation on an archived project. Listed only to rule out by name.

**Recommendation:** **Option A (Garage)** — it is the only candidate whose official documentation confirms every S3 feature the phase depends on (multipart, presigned URLs, CORS, and the `AbortIncompleteMultipartUpload` lifecycle rule that cleans abandoned 10 GB uploads), under governance with no commercial pull; the missing console and init script are one-time dev costs. RustFS is the fallback if a console matters more than proven presigned-multipart support. Because all code targets the S3 API through `@aws-sdk/client-s3`, the choice is reversible and does not constrain the production provider.

**Decision:** Option A (Garage)
**Libraries:** @aws-sdk/client-s3

**Revisions:**
- 2026-09-14 — Bucket lifecycle rule aborts incomplete multipart uploads after 1 day (AMB-3). Rationale: Standard preset (Recommended).

---

## TD-02: Storage Endpoint Topology (internal vs browser-facing presigned URLs)

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance"

**Context:** SigV4 presigned URLs sign the host. The API and worker run in containers and must reach storage by Compose service name (root `CLAUDE.md` rule: e.g., `http://storage:3900`), but a URL signed for `storage:3900` is unreachable from the browser, and rewriting its host invalidates the signature. The canonical storage env-key set is therefore a cross-component contract (Joi schema + `.env.example` + `compose.yaml` + bucket CORS origin). Depends on TD-01 only for the port/region values.

**Options:**

### Option A: Dual endpoint — internal for server operations, public for presigning
- `STORAGE_ENDPOINT` (e.g., `http://storage:3900`) configures the S3 client used for server-side operations (CreateMultipartUpload, Complete, HeadObject, worker reads/writes). `STORAGE_PUBLIC_ENDPOINT` (e.g., `http://localhost:3900` in dev) configures a second client used **only** by the presigner. Bucket CORS allows the FE origin and exposes `ETag` (the browser must read each part's ETag).
- **Pros:** Server traffic obeys the Docker networking rule. Browser URLs are valid and signed for the host the browser actually uses. Maps cleanly to production (internal VPC endpoint vs public/CDN hostname).
- **Cons:** Two S3 client instances and two env keys to keep consistent. Misconfiguring the public endpoint only surfaces as a browser-side 403 — needs an integration test that signs and PUTs through the public host.

### Option B: Single browser-reachable endpoint used everywhere
- Containers reach storage through `host.docker.internal:3900` (via `extra_hosts`, as `next-frontend/compose.yaml` already does), so one hostname works for both server and browser.
- **Pros:** One client, one key, simplest mental model.
- **Cons:** Directly violates the root `CLAUDE.md` Docker networking rule for server-to-server traffic. Routes API/worker bytes (worker reads of 10 GB objects) through the host gateway. Behaves differently across Docker Desktop / native Linux.

### Option C: Same-origin storage proxy through Next.js
- Next rewrites `/storage/*` to the storage service, so the browser uploads and streams same-origin (no CORS).
- **Pros:** No CORS configuration; storage host fully hidden.
- **Cons:** All 10 GB upload bodies and every streaming range request traverse the Next server — contradicts "sem impacto na performance" and the buffering behavior noted in the environment facts. Host rewriting also breaks presigned signatures unless the proxy re-signs.

**Recommendation:** **Option A (Dual endpoint)** — it is the only option that satisfies both the Docker service-name rule for server traffic and signature validity for browser traffic, and it mirrors how production separates internal and public storage hostnames. The second client is a few lines of configuration; the required safety net is an integration test that presigns via the public endpoint.

**Decision:** Option A (Dual endpoint)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Large-File Upload Protocol (10GB, resumable)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** "Pontos de Atenção" requires 10 GB uploads that do not degrade the system and can resume after connection failure. Under strict BFF (`next-frontend-config-base/TD-03`) any byte that goes to NestJS must pass through a Next Route Handler first, so the protocol choice decides whether 10 GB crosses two Node servers or none. Both subprojects are affected: the backend exposes the orchestration endpoints, the frontend implements the byte transfer and resume.

**Options:**

### Option A: Presigned S3 multipart, direct browser → storage
- Browser asks the API (via BFF) to initiate; the API creates the multipart upload and returns part URLs presigned against the public endpoint (TD-02). The browser PUTs parts directly to storage in parallel, collects ETags, and asks the API to complete. Resume = ask the API for already-uploaded parts (ListParts) and send only the missing ones.
- **Pros:** Zero upload bytes on Next or NestJS — only small JSON calls cross the BFF, so the Node servers are unaffected by upload volume. Native resume and part-level retry. Parallel parts improve throughput. Standard S3 flow, portable to any production provider.
- **Cons:** Requires bucket CORS and the dual-endpoint setup (TD-02). The browser client must manage parts, concurrency, retries and ETags (TD-04). Total size can't be enforced by the presigned URL alone — the API must validate the declared size at initiation and `HeadObject` size at completion.

### Option B: tus protocol served by NestJS (`@tus/server` + `@tus/s3-store`)
- NestJS mounts a tus endpoint; `S3Store` streams received chunks into S3 multipart parts. Browser uses `tus-js-client`/Uppy tus.
- **Pros:** Mature open resumable protocol with good client libraries. Upload lifecycle hooks (`onUploadFinish`) live in the API, so completion handling is server-side by construction.
- **Cons:** Every byte flows through NestJS — and, under strict BFF, through a Next Route Handler first (two Node hops, doubled bandwidth, CPU and memory pressure on both). Exposing the tus endpoint to the browser directly would violate `next-frontend-config-base/TD-03`. Multi-instance deployment needs a shared KV store for upload state (`RedisKvStore`).

### Option C: Single streamed multipart/form-data request through BFF → NestJS → storage
- Browser posts the file in one request; each hop streams it onward.
- **Pros:** Simplest client code (`<input type="file">` + one `fetch`).
- **Cons:** No resume — a dropped connection at 9 GB restarts from zero, failing an explicit requirement. Long-lived 10 GB requests hit proxy/timeout limits and hold a connection on two Node servers for the whole duration. Disqualified.

**Recommendation:** **Option A (Presigned S3 multipart, direct browser → storage)** — it is the only option that keeps upload bytes off both Node servers while providing resume, which is exactly the "sem impacto na performance" + "retomar em caso de falha" pair; it also realizes the presigned-storage path already anticipated in `next-frontend-config-base/TD-03`. tus solves resume well but forces 10 GB through the BFF and the API, which the strict-BFF model makes doubly expensive.

**Decision:** Option A (Presigned S3 multipart, direct browser → storage)*
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-09-14 — Upload ceiling fixed at 10 GiB (10 × 1024³ bytes); multipart part size 64 MiB; presigned part-URL TTL 1 h (AMB-3). Rationale: Balanced preset (Recommended).

---

## TD-04: Browser Upload Client

**Scope:** Frontend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Depends on TD-03. Under TD-03 Option A, the browser must slice the file, request presigned part URLs through the BFF, PUT parts with concurrency and retries, report progress, collect ETags, and resume after a reload. The UI must follow the project design system (shadcn `radix-nova`, custom icons — `next-frontend/CLAUDE.md`), so any bundled uploader UI would be unused. Under TD-03 Option B this TD collapses to "tus-js-client".

**Options:**

### Option A: Thin in-house multipart uploader module
- A client module (`Blob.slice` + `XMLHttpRequest` for per-part `upload.onprogress`) with a small concurrency pool, per-part retry with backoff, and resume state `{ videoId, fileFingerprint }` in `localStorage`; on resume it asks the API which parts exist. The API owns create/complete (TD-05).
- **Pros:** No dependency; exact fit with API-owned create/complete and server-generated object keys. Headless by construction — renders with project primitives. Testable as pure logic (part planning, retry policy) with Vitest.
- **Cons:** We own tricky edge cases (concurrent retries, ETag collection, tab close mid-part). Roughly a few hundred LOC plus tests, where a library offers battle-tested defaults.

### Option B: Uppy core + `@uppy/aws-s3` (headless, no Dashboard)
- Uppy manages files, concurrency, retries and progress; `shouldUseMultipart` enables multipart. In the current plugin, custom signing is a single `signRequest` callback — Uppy performs the S3 calls (including create/complete) from the browser using URLs the backend presigns.
- **Pros:** Mature retry/pause/resume machinery; crash recovery via Golden Retriever; well documented.
- **Cons:** Its model moves multipart create/complete to the browser, so the API no longer observes completion unless the client makes an extra call — fighting TD-05's server-owned completion. Default `generateObjectKey` is client-side (must be overridden and validated server-side). Pulls a sizeable library whose UI layer we won't use.

### Option C: `tus-js-client`
- Standard tus client with built-in resume via fingerprinted URL storage.
- **Pros:** Small, mature, resume out of the box.
- **Cons:** Only valid if TD-03 chooses Option B (tus). Listed for coherence of the dependency.

**Recommendation:** **Option A (Thin in-house multipart uploader)** — with TD-03 A the uploader's job is narrow (slice, PUT, retry, resume), and keeping create/complete on the API preserves server-side control of object keys, size validation and the processing trigger (TD-05); Uppy's current `signRequest` model inverts that ownership. If TD-03 swings to tus, choose Option C.

**Decision:** Option A (Thin in-house multipart uploader)

**Revisions:**
- 2026-09-14 — Phase 03 delivers the uploader as a next-frontend module plus BFF Route Handlers (initiate / sign parts / complete / media URLs) with no page mounting them; verification = uploader unit tests + BFF integration tests (MSW) + backend E2E against real storage; the upload screen lands in a later phase (AMB-2). Rationale: Uploader + BFF, no page (Recommended).
- 2026-09-14 — Uploader runs 4 concurrent 64 MiB parts with 3 retries per part and backoff (AMB-3). Rationale: Balanced preset (Recommended).

---

## TD-05: Upload Completion Signal & Draft Lifecycle

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** The video row must exist as a draft as soon as the upload starts, and processing must start automatically when the bytes are complete. Someone has to tell the system "upload finished" — the choice spans the FE uploader, the API, storage and the queue. The lifecycle states are also a contract read by the FE (upload progress UI now, management panel in Phase 04). Depends on TD-03.

**Options:**

### Option A: Client-driven completion endpoint (API-orchestrated)
- `initiate` creates the `Video` row (draft, status `uploading`) and the multipart upload in one API call. After the last part, the client calls `complete` with the part ETags; the API calls `CompleteMultipartUpload`, verifies size via `HeadObject`, moves status to `processing` and enqueues the job. Abandoned uploads are cleaned by a scheduled job (stale `uploading` drafts) plus the bucket `AbortIncompleteMultipartUpload` lifecycle rule.
- **Pros:** Single, synchronous, testable trigger owned by the API; no storage-provider eventing needed. Size/ownership validation happens before processing starts. Works identically on Garage and on any production S3.
- **Cons:** If the client disappears after the last part but before `complete`, the upload is orphaned until cleanup (acceptable: it is resumable — `complete` can be retried). Requires the cleanup job.

### Option B: Storage event notifications
- Storage emits an `ObjectCreated` event (webhook or queue) when the multipart upload completes; the API/worker reacts.
- **Pros:** Completion is detected even if the client vanishes. Decouples the client from the trigger.
- **Cons:** Event notification support is provider-specific (AWS routes through SNS/SQS/Lambda; self-hosted engines vary), so it becomes a portability constraint on TD-01 and production. The browser would call `CompleteMultipartUpload` itself (presigned), moving size/ownership validation after the fact. Adds an event pipeline to operate.

### Option C: Reconciliation poller
- The client only uploads; a scheduled job lists pending multipart uploads/objects and promotes finished ones.
- **Pros:** Provider-agnostic; tolerant of vanished clients.
- **Cons:** Processing starts with polling latency. Listing storage periodically is wasteful and scales with pending uploads. Still needs someone to call `CompleteMultipartUpload`.

**Recommendation:** **Option A (Client-driven completion endpoint)** — the API already owns initiation, so owning completion keeps validation, state transitions and enqueueing in one transactional place without coupling Phase 03 to provider-specific eventing. Proposed processing statuses for the contract: `uploading → processing → ready | failed`. Note: "rascunho" (draft) is the publication axis owned by Phase 04 ("Fluxo de rascunho → publicação"); Phase 03 only creates the row as draft and manages the processing axis.

**Decision:** Option A (Client-driven completion endpoint)
**Libraries:** @aws-sdk/client-s3

**Revisions:**
- 2026-09-14 — Drafts stuck in `uploading` are purged after 24 h; on processing failure the row keeps `processing_status = failed` + `failure_code` and the original object is deleted after 7 days (AMB-3). Rationale: Standard preset (Recommended).

---

## TD-06: Unique Public Video ID (URL identifier)

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** "Pontos de Atenção" asks for a short, unique URL that never conflicts. The ID shape is a contract across the `Video` entity, API routes, OpenAPI, FE routes (Phase 05 watch page), MSW fixtures and shareable links. Phase 04/05 add **unlisted** videos ("acessíveis apenas via link direto"), so IDs must not be enumerable. Entity rules keep UUID as the internal PK; this TD decides the public identifier.

**Options:**

### Option A: Random short ID (YouTube-style, 11-char base64url from 64 random bits)
- Generated with a CSPRNG at initiation, stored in a unique-indexed `public_id` column; on the (astronomically rare) unique-violation, regenerate and retry.
- **Pros:** Short, URL-safe, non-sequential and non-enumerable — safe for unlisted videos. The unique index guarantees "never conflicts". No coordination or counter.
- **Cons:** A second identifier alongside the UUID PK. Retry-on-conflict path must exist (trivial, but must be tested).

### Option B: Expose the UUID primary key
- URLs use the existing `id`.
- **Pros:** Zero extra column; uniqueness already guaranteed.
- **Cons:** 36-char URLs — contradicts "URL curta". Couples the public URL to the internal key forever.

### Option C: Encoded sequential number (Sqids/Hashids over a bigint)
- A sequence number encoded into a short reversible string.
- **Pros:** Very short IDs; deterministic; no collision handling.
- **Cons:** Reversible encodings are obfuscation, not secrecy — IDs are enumerable, which leaks unlisted videos and upload volume. Requires a sequence column plus an encoding alphabet/salt that can never change.

**Recommendation:** **Option A (Random 11-char base64url ID with unique index)** — it is the only option that is simultaneously short, collision-proof by constraint, and non-enumerable, the last property being required by the unlisted-video capability in Phases 04–05; the UUID stays as the internal PK per entity conventions.

**Decision:** Option A (Random 11-char base64url ID with unique index)

---

## TD-07: Background Job Queue

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** The architecture diagram leaves the Message Queue as "TBD". Jobs here are few but long (probe, thumbnail, possibly a remux of multi-GB files), need retries with backoff, failure visibility and progress, and are consumed by a separate worker (TD-08). Prior phases consistently favored official NestJS integrations (`@nestjs/config`, `@nestjs/jwt`, `@nestjs/throttler`).

**Options:**

### Option A: BullMQ + Redis (`@nestjs/bullmq`)
- Redis-backed queue; `@Processor` + `WorkerHost` classes with `concurrency`, `lockDuration`, `maxStalledCount`; retries/backoff, job progress, repeatable jobs (useful for TD-05 cleanup).
- **Pros:** Official NestJS integration and documentation. Rich job semantics out of the box (attempts, backoff, progress, stalled-job recovery, `job.extendLock` for long work). Dashboard available (Bull Board). Worker runs in any process that shares the Redis connection.
- **Cons:** Adds a Redis-compatible container to the stack. Enqueue is not atomic with the PostgreSQL write — mitigate with `jobId = videoId` (idempotent enqueue) and a status guard in the processor. Long jobs need `lockDuration`/lock extension tuned.

### Option B: pg-boss on the existing PostgreSQL
- Job queue stored in Postgres using `SKIP LOCKED`; retries with exponential backoff, dead-letter queues, concurrency, scheduling.
- **Pros:** No new infrastructure — PostgreSQL is already in the stack. Jobs live next to the data, enabling (with care) enqueueing in the same database.
- **Cons:** No official NestJS module — DI wiring, lifecycle and test helpers are ours. Sharing a TypeORM transaction with pg-boss requires custom adapter work. Queue polling adds load to the primary database.

### Option C: RabbitMQ (`@nestjs/microservices`)
- AMQP broker with the NestJS microservices transport.
- **Pros:** Mature broker; strong routing; official Nest transport.
- **Cons:** A message broker, not a job queue — retries with backoff, progress, delayed/repeatable jobs and stalled-job recovery must be built by hand. Heavier to operate than Redis for this workload.

**Recommendation:** **Option A (BullMQ + Redis via `@nestjs/bullmq`)** — it delivers the job semantics this phase needs (retries, progress, long-job locks, repeatable cleanup) through an official NestJS integration, matching the precedent set in Phases 01–02; the non-atomic enqueue is neutralized by idempotent job IDs. pg-boss is the credible alternative if avoiding a new container outweighs building the Nest integration ourselves. (Redis 8 is AGPL-licensed and Valkey is a BSD wire-compatible fork; the image choice is an implementation detail — verify BullMQ compatibility in `/plan-build` if Valkey is preferred.)

**Decision:** Option A (BullMQ + Redis via `@nestjs/bullmq`)
**Libraries:** @nestjs/bullmq, bullmq

**Revisions:**
- 2026-09-14 — Processing job runs with 3 attempts and exponential backoff (AMB-3). Rationale: Standard preset (Recommended).

---

## TD-08: Video Worker Deployment Topology

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** The C4 diagram draws the Video Worker (FFmpeg) as its own container that reads/writes storage and updates the DB. FFmpeg work is CPU- and I/O-heavy and must not degrade API latency. The worker needs the same `Video` entity, config namespaces and DB connection as the API. The choice shapes `compose.yaml`, Dockerfiles and the `nestjs-project` source layout.

**Options:**

### Option A: Same codebase, second entrypoint, separate container
- `nestjs-project` gains a worker entrypoint (`NestFactory.createApplicationContext(WorkerModule)` — no HTTP server) that registers only the processors. A `video-worker` Compose service runs it from an image with FFmpeg installed.
- **Pros:** Matches the C4 diagram. Shares entities, config, migrations and tests with zero duplication. CPU isolation from the API; scales independently (more worker replicas). FFmpeg is only installed where needed.
- **Cons:** Two processes/containers to run in dev. Module boundaries must keep HTTP-only providers out of the worker context.

### Option B: Processors inside the API process
- Register BullMQ processors in the API `AppModule`; FFmpeg installed in the API container.
- **Pros:** One process; simplest to start.
- **Cons:** FFmpeg child processes compete for CPU/disk with request handling in the same container — directly against "sem impacto na performance". Cannot scale processing independently. Contradicts the architecture diagram.

### Option C: Separate `video-worker/` subproject
- New top-level subproject with its own `package.json`, TypeORM config and entities.
- **Pros:** Strongest isolation; worker could later use another language/runtime.
- **Cons:** Duplicates the `Video` entity, config and DB wiring — schema drift risk between API and worker. New subproject tooling (lint, tests, Docker, CI) for no current benefit.

**Recommendation:** **Option A (Same codebase, second entrypoint, separate container)** — it realizes the diagram's isolated worker and protects API latency while keeping one source of truth for entities and config; Option C pays duplication costs for flexibility no phase needs.

**Decision:** Option A (Same codebase, second entrypoint, separate container)

---

## TD-09: Media Probing & Thumbnail Tooling

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Duration/metadata come from `ffprobe`; the thumbnail is one frame extracted by `ffmpeg`. How the binaries reach the worker is a cross-component choice (worker Dockerfile + worker code). `ffprobe`/`ffmpeg` can read directly from a presigned HTTP URL with range requests, so probing and frame extraction don't require downloading the whole 10 GB file. Depends on TD-08.

**Options:**

### Option A: System FFmpeg in the worker image + `child_process.spawn` wrapper
- Install `ffmpeg` via the OS package manager in the worker image; a small typed wrapper runs `ffprobe -print_format json -show_format -show_streams` and a single-frame `ffmpeg` extraction, with timeouts and stderr capture.
- **Pros:** No abandoned Node wrapper in the dependency tree; FFmpeg patched through the base image. Full control of arguments, timeouts and parsing. Wrapper is small and unit-testable (argument building, JSON parsing).
- **Cons:** FFmpeg version tied to the base image's distro. We write the (small) wrapper and its error handling.

### Option B: npm-bundled static binaries (`ffmpeg-static` / `ffprobe-static` style)
- Binaries pinned via `package.json`; spawned the same way as A.
- **Pros:** Exact binary version pinned with the lockfile; no Dockerfile change.
- **Cons:** Platform-specific binaries downloaded at install into the bind-mounted `node_modules`; licensing/maintenance of these packages must be verified; security updates depend on the package publisher.

### Option C: `fluent-ffmpeg`
- Fluent command-builder API over FFmpeg.
- **Pros:** Familiar API from many tutorials.
- **Cons:** Archived and deprecated since May 22, 2025 — no fixes, reported incompatibilities with recent FFmpeg. Rejected.

**Recommendation:** **Option A (System FFmpeg + spawn wrapper)** — the Node wrapper ecosystem has been abandoned, and FFmpeg's own CLI is the stable interface; installing it only in the worker image (TD-08 A) keeps the API image lean. Suggested thumbnail policy for `/plan-build`: one frame at ~10% of duration (clamped for very short videos), fixed width, stored next to the video under a server-generated key.

**Decision:** Option A (System FFmpeg + spawn wrapper)

**Revisions:**
- 2026-09-14 — Thumbnail: one JPEG frame 1280 px wide at 10% of duration, clamped for very short videos (AMB-3). Rationale: Standard preset (Recommended).

---

## TD-10: Accepted Input Formats & Normalization Policy

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Reprodução via streaming (sem necessidade de download completo)"

**Context:** Uploaded files may use containers/codecs browsers can't play (MKV, HEVC outside Safari, ProRes) or MP4s with the `moov` atom at the end (slow start over HTTP). Phase 03 requires playback via streaming, but its processing bullet only mentions metadata extraction — full transcoding of 10 GB inputs is CPU-hours of work. The policy constrains the FE (`accept` attribute, error messages), the worker, and TD-11. Depends on TD-09.

**Options:**

### Option A: Accept anything FFmpeg reads; always transcode to H.264/AAC MP4
- **Pros:** Every ready video plays in every browser; uniform output simplifies the player and future HLS work.
- **Cons:** CPU-hours per large upload, long time-to-ready, quality loss from re-encoding, doubled storage during processing. Goes well beyond the phase's "extração de duração e metadados" scope.

### Option B: Allowlist browser-playable formats; remux-only normalization
- Accept MP4/MOV (H.264 + AAC) and WebM (VP8/VP9/AV1 + Opus/Vorbis). The worker validates codecs via `ffprobe`; MP4s without faststart are remuxed (`-c copy -movflags +faststart`, no re-encode). Anything else ends `failed` with a domain error code (e.g., `UNSUPPORTED_CODEC`). The FE restricts the file picker and shows the failure reason.
- **Pros:** Processing stays fast (probe + optional stream copy); guarantees fast-starting, playable output for accepted files; clear user feedback for rejected ones.
- **Cons:** Some legitimate uploads are rejected (e.g., HEVC phone videos). A faststart remux still rewrites the whole file (I/O and temporary disk proportional to file size).

### Option C: Serve originals untouched
- **Pros:** Zero processing beyond metadata; fastest time-to-ready.
- **Cons:** No playability guarantee; `moov`-at-end files start slowly. Failures surface to viewers instead of the uploader.

**Recommendation:** **Option B (Allowlist + remux-only normalization)** — it guarantees streamable output within the phase's processing scope, fails early and visibly at the uploader instead of at the viewer, and leaves full transcoding (Option A) as a later capability if format rejection proves to be a real user pain.

**Decision:** Option B (Allowlist + remux-only normalization)

---

## TD-11: Streaming Delivery Format

**Scope:** Cross-layer

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** Playback must start without downloading the full file. The format decides storage layout, worker output and the FE player (native `<video>` vs a streaming library). The Phase 05 player needs only play/pause, volume and a progress bar. Depends on TD-10.

**Options:**

### Option A: Progressive playback over HTTP Range (single faststart file)
- The native `<video>` element requests byte ranges of one MP4/WebM; seeking issues new range requests. Faststart (TD-10) makes playback begin after the first range.
- **Pros:** Works in every browser with no player library. One object per video; no extra processing. Covers the Phase 05 controls natively.
- **Cons:** No adaptive bitrate — viewers on slow networks buffer at the file's single bitrate. Large files without CDN caching can be expensive to serve at scale.

### Option B: HLS adaptive streaming
- The worker transcodes a rendition ladder into segmented HLS; the FE uses native HLS (Safari) or `hls.js` elsewhere.
- **Pros:** Adaptive bitrate, better experience on poor networks, CDN-friendly segments.
- **Cons:** Requires full transcoding (contradicts TD-10 B), multiplies storage 2–3×, adds a player library, and turns processing into hours for 10 GB inputs.

**Recommendation:** **Option A (Progressive playback over HTTP Range)** — it satisfies "sem necessidade de download completo" natively with no transcoding or player dependency, consistent with TD-10 B; HLS can be added later as an additional output without changing the upload pipeline.

**Decision:** Option A (Progressive playback over HTTP Range)

---

## TD-12: Media Access Delivery (playback & download URLs)

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** The browser must fetch video bytes (range requests for streaming, full file for download) and thumbnails. Under strict BFF, the FE obtains data through Route Handlers; the bytes themselves should not traverse Node servers. Access rules evolve: drafts (Phase 03/04) and unlisted videos (Phase 04/05) must not be reachable by guessing; anonymous viewers must watch public videos (Phase 05). Depends on TD-02 (public endpoint) and TD-11.

**Options:**

### Option A: Private bucket + short-lived presigned GET URLs issued by the API
- The API (reached via BFF) checks visibility/status and returns presigned GET URLs for the video and thumbnail; downloads use a presigned URL with a `response-content-disposition: attachment` override.
- **Pros:** Bytes flow browser ↔ storage directly, with native Range support. Access decisions stay in the API per request — drafts/unlisted/deleted media are protected by construction. Same mechanism serves streaming and download.
- **Cons:** URLs expire — the expiry must outlast a viewing session, or the player must refresh the URL on a 403 during seeks. Presigned URLs defeat shared CDN caching unless the provider supports signed CDN URLs later. The `response-content-disposition` override must be verified against the TD-01 engine.

### Option B: Public-read objects with unguessable keys
- Ready media is world-readable; the API returns stable URLs.
- **Pros:** Stable, cache/CDN-friendly URLs; no expiry handling.
- **Cons:** No revocation — once shared, a URL stays valid after the video is unpublished, made unlisted or deleted. Drafts leak if keys are ever exposed. Pushes access control into key secrecy.

### Option C: Proxy through BFF Route Handler (and API) with Range support
- Route Handlers stream storage objects to the browser.
- **Pros:** Hides storage completely; full per-request authorization.
- **Cons:** Every streaming range and every multi-GB download crosses Node servers — contradicts the performance requirement and the reasoning behind TD-03. Disqualified at this scale.

**Recommendation:** **Option A (Private bucket + presigned GET URLs)** — it keeps bytes off Node servers while preserving per-request access control that Phases 04–05 depend on (drafts, unlisted, anonymous viewing); expiry is handled with a generous playback TTL plus a single refresh-on-403 in the player.

**Decision:** Option A (Private bucket + presigned GET URLs)
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-09-14 — Phase 03 media access is owner-only: only the owner may request playback/download URLs; any other caller receives `404 VIDEO_NOT_FOUND` so existence is not revealed; Phases 04–05 widen access (AMB-1). Rationale: Owner only, others 404 (Recommended).
- 2026-09-14 — Playback URL TTL 6 h; download URL TTL 15 min with `Content-Disposition: attachment` (AMB-3). Rationale: Balanced preset (Recommended).
- 2026-09-14 — The single refresh-on-403 in the player moves to Phase 05 (watch page); Phase 03 delivers URL issuance only (AMB-2). Rationale: Uploader + BFF, no page (Recommended).

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|----------------|--------|
| TD-01 | Backend | Object storage engine (S3-compatible) | A (Garage) | A (Garage) |
| TD-02 | Backend | Storage endpoint topology | A (Dual endpoint: internal + public presigner) |  A (Dual endpoint: internal + public presigner) |
| TD-03 | Cross-layer | Large-file upload protocol | A (Presigned S3 multipart, direct browser → storage) | A (Presigned S3 multipart, direct browser → storage) |
| TD-04 | Frontend | Browser upload client | A (Thin in-house multipart uploader) | A (Thin in-house multipart uploader) |
| TD-05 | Cross-layer | Upload completion signal & draft lifecycle | A (Client-driven completion endpoint) | A (Client-driven completion endpoint) |
| TD-06 | Cross-layer | Unique public video ID | A (Random 11-char base64url + unique index) | A (Random 11-char base64url + unique index)  |
| TD-07 | Backend | Background job queue | A (BullMQ + Redis via `@nestjs/bullmq`) | A (BullMQ + Redis via `@nestjs/bullmq`) |
| TD-08 | Backend | Video worker deployment topology | A (Same codebase, second entrypoint, separate container) |  (Same codebase, second entrypoint, separate container) |
| TD-09 | Backend | Media probing & thumbnail tooling | A (System FFmpeg + spawn wrapper) | A (System FFmpeg + spawn wrapper) |
| TD-10 | Cross-layer | Accepted input formats & normalization | B (Allowlist + remux-only) | B (Allowlist + remux-only) |
| TD-11 | Cross-layer | Streaming delivery format | A (Progressive over HTTP Range) | A (Progressive over HTTP Range) |
| TD-12 | Cross-layer | Media access delivery | A (Private bucket + presigned GET URLs) | A (Private bucket + presigned GET URLs) |

---

## Notes for downstream pipeline

- **Dependency chain:** TD-01 → TD-02 → TD-03 → TD-04 / TD-05; TD-07 → TD-08 → TD-09 → TD-10 → TD-11 → TD-12. If TD-03 swings to tus (B), TD-04 becomes C and TD-05's completion hook moves into `@tus/server`'s `onUploadFinish`; TD-02 then matters only for playback URLs. If TD-10 swings to A (transcode), revisit TD-11 (HLS becomes cheap to add) and the worker's lock/timeout tuning in TD-07.
- **Out of scope here (noted, not decided):** processing-status updates in the UI default to re-fetching the video via the BFF; a real-time channel (SSE/WebSocket) is not required by any Phase 03 bullet. The production storage provider and CDN are Phase 07 ("Ambiente de produção e deploy"). The draft → published transition is Phase 04.
- **Verification items for `/plan-build`:** (1) presigned `UploadPart` PUT from the browser through `STORAGE_PUBLIC_ENDPOINT` succeeds with CORS exposing `ETag` on the TD-01 engine; (2) presigned GET honors `response-content-disposition`; (3) the `AbortIncompleteMultipartUpload` lifecycle rule is applied at bucket bootstrap; (4) BullMQ `lockDuration` / lock extension covers the longest faststart remux of a 10 GB file.

Sources consulted during research:

- [MinIO's Community Edition Is Archived: Garage vs. SeaweedFS vs. RustFS Compared (bex.co)](https://bex.co/blog/2026/07/09/minio-death-garage-seaweedfs-rustfs) — MinIO CE timeline; license/governance comparison.
- [Garage — S3 compatibility reference](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/) — multipart, presigned URLs, CORS, lifecycle support.
- [RustFS — S3 protocol docs](https://docs.rustfs.com/en/administration/protocols/s3) and issues [#1635](https://github.com/rustfs/rustfs/issues/1635), [#1270](https://github.com/rustfs/rustfs/issues/1270) — presigned multipart questions.
- [Amazon S3 multipart upload limits](https://docs.aws.amazon.com/AmazonS3/latest/userguide/qfacts.html) — part size/count limits.
- AWS SDK for JavaScript v3 (Context7 `/aws/aws-sdk-js-v3`) — `getSignedUrl` default 900 s expiry, `UploadPartCommand`, `forcePathStyle` for custom endpoints.
- tus Node Server (Context7 `/tus/tus-node-server`) — `S3Store` part sizing, framework integration, shared KV for multi-instance.
- Uppy (Context7 `/websites/uppy_io`) — `@uppy/aws-s3` options and the `signRequest` migration (client performs S3 calls).
- NestJS Bull (Context7 `/nestjs/bull`) — `@Processor` options (`concurrency`, `lockDuration`, `maxStalledCount`), `job.extendLock`.
- [pg-boss](https://github.com/timgit/pg-boss) — Postgres `SKIP LOCKED` queue, retries/backoff, DLQ.
- [Redis AGPL license (InfoQ)](https://www.infoq.com/news/2025/05/redis-agpl-license) and [Redis vs Valkey 2026](https://dev.to/synsun/redis-vs-valkey-in-2026-what-the-license-fork-actually-changed-1kni) — licensing context for the Redis-compatible container.
- [fluent-ffmpeg repository (archived)](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg) and [Phasing out fluent-ffmpeg #1324](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg/issues/1324).
- `next-frontend/node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md` — Next 16 body buffering (10 MB default).
- In-repo: `docs/project-plan.md` (Fase 03 + Pontos de Atenção), `docs/diagrams/software-arch.mermaid`, all prior `docs/decisions/*.md`, `nestjs-project/compose.yaml`, `next-frontend/compose.yaml`, both `package.json` manifests, `.claude/rules/next-frontend-bff-api.md`, `.claude/rules/nestjs-entities.md`.
