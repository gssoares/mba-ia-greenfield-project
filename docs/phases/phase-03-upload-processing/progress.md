# phase-03-upload-processing — Progress

**Status:** in_progress
**SIs:** 12/12 completed

_Scope of this /implement run: backend only (SI-03.1–SI-03.12), per user decision on 2026-09-17. SI-03.13–SI-03.23 (next-frontend) are out of scope for this run and not tracked here._

### SI-03.1 — Infra: Garage, Redis, video-worker e FFmpeg no Compose
- **Status:** completed
- **Tests:** no tests (infra) — 5 ACs verified manually via `docker compose ps`/`exec`/admin API, including a clean-volume recreation run
- **Observations:**
  - Garage bootstrap uses the Admin HTTP API (`http://garage:3903`, port not published to host) from a one-shot `garage-init` (`alpine:3.20` + curl/jq installed at container start) instead of the `garage` CLI's RPC protocol — avoids RPC-address resolution ambiguity across containers; verified end-to-end including a from-clean-volumes rerun.
  - `STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY` are fixed dev placeholder strings imported into Garage via `POST /v2/ImportKey` (not `garage key create`), so the key is deterministic and known ahead of time by `.env`/`.env.example`.
  - `rpc_secret` and `admin_token` in `garage.toml` are static dev-only values, not exposed as app-facing env vars — the plan's Technical action 5 only lists `STORAGE_*`/`REDIS_*` keys for `.env.example`, so these internal Garage secrets were kept out of that surface.
  - `nestjs-api`'s existing Docker image was stale (built before this SI) and `docker compose up -d` does not auto-rebuild on Dockerfile changes; had to run `docker compose build nestjs-api` explicitly to pick up ffmpeg. No action needed going forward since the image is now current.

### SI-03.2 — Módulo de storage S3 com endpoints interno e público
- **Status:** completed
- **Tests:** 14 passing (1 fix attempt)
- **Observations:**
  - AWS SDK v3's default `requestChecksumCalculation: 'WHEN_SUPPORTED'` bakes a CRC32 placeholder into presigned `UploadPartCommand` URLs; Garage rejects the real PUT body with `InvalidDigest` since the checksum doesn't match. Fixed by setting `requestChecksumCalculation: 'WHEN_REQUIRED'` on both S3Client instances in `StorageService` — confirmed via a Node repro script hitting Garage directly, then verified via context7 (aws-sdk-js-v3 flexible-checksums middleware source) before applying.
  - `StorageModule` is not wired into `AppModule` yet — it's only exported for `VideosModule` (SI-03.5) to import later, per the plan's technical action ordering. Its own tests bootstrap `StorageModule` standalone with `ConfigModule.forRoot({ load: [storageConfig] })`, not via the full app.
  - `STORAGE_CORS_ORIGINS` and `STORAGE_ACCESS_KEY_ID`/`STORAGE_SECRET_ACCESS_KEY`/`STORAGE_BUCKET` are Joi-required (no default) since they have no safe universal value; `STORAGE_ENDPOINT`/`STORAGE_PUBLIC_ENDPOINT`/`STORAGE_REGION` default to the dev Compose values, mirroring the existing `DB_*`/`MAIL_*` required-vs-defaulted split.

### SI-03.3 — Entidade Video, migration e gerador de ID público
- **Status:** completed
- **Tests:** 8 passing
- **Observations:**
  - Entity, migration (`1789680630228-CreateVideosTable`), `VideosModule`, `public-id.util.ts`, and the `User.videos` relation were already implemented on disk when this run started (context had been cleared mid-SI in a prior session); verified each against the plan's Data Model spec and Dependency Map before accepting them as-is, then ran the SI's tests fresh.
  - Pre-existing dev-DB condition, not introduced by this SI: the `migrations` bookkeeping table is empty even though `users`, `channels`, `refresh_tokens`, `verification_tokens`, and now `videos` all exist with schemas matching their respective migration files — classic `synchronize: true` residue (integration tests default to `synchronize: true` in `createTestDataSource` and run against the same dev DB). Confirmed via `npm run migration:run`, which fails with `relation "channels" already exists` (the phase-01 migration, not phase-03's). Recovery (drop tables, clear bookkeeping, regenerate/rerun migrations) spans phases 01–03 and is out of scope for this SI — flagging as a follow-up for the user rather than acting on it.

### SI-03.4 — Infra: módulo de filas BullMQ
- **Status:** completed
- **Tests:** 14 passing (1 fix attempt)
- **Observations:**
  - `@nestjs/bullmq@12.0.0` and `@nestjs/bull-shared` (its dependency) ship `"type": "module"` with `require` in `exports` also pointing at the ESM build — no CJS build exists. Jest's default `transformIgnorePatterns` (`["/node_modules/"]`) skips them, so any file importing `@nestjs/bullmq` failed with `SyntaxError: Unexpected token 'export'`. Fixed by adding `transformIgnorePatterns: ["node_modules/(?!(@nestjs/bullmq|@nestjs/bull-shared)/)"]` to both `package.json`'s `jest` block and `test/jest-e2e.json` (the e2e config was fixed proactively since upcoming SIs will exercise the queue over HTTP and would hit the same failure).
  - BullMQ v6 made `ioredis` an optional peer dependency: passing `connection: { host, port }` (a plain options object, as the plan's `useFactory` specifies) requires bullmq to auto-construct a client via `ioredis`, which throws `"BullMQ could not load the optional 'ioredis' package"` if it isn't installed. Installed `ioredis@^5.11.1` explicitly (not listed in the plan's Technical action 1, but a mandatory transitive runtime dependency for the exact connection pattern the plan specifies).
  - `REDIS_HOST` previously had a Joi `.default('redis')` (added when SI-03.1 wired the Compose `redis` service) rather than `.required()`; changed to `.required()` per this SI's explicit AC ("iniciar sem REDIS_HOST falha na validação"), mirroring the `STORAGE_*` required-credentials pattern. `REDIS_PORT` keeps its default (6379) since only `REDIS_HOST` is covered by the AC.
  - `videos.module.spec.ts` (from SI-03.3) started failing once `VideosModule` began importing `QueueModule` (technical action 5) because `BullModule.forRootAsync` needs `queueConfig.KEY` resolvable and a live Redis connection; updated its test module to load `ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] })` alongside the existing `TypeOrmModule.forRoot(...)`.

### SI-03.5 — Endpoint POST /videos (pré-cadastro e início do upload)
- **Status:** completed
- **Tests:** 13 passing (7 unit/integration + 6 e2e)
- **Observations:**
  - `VideosService.initiateUpload` mirrors the existing `ChannelsService` unique-violation-retry pattern (`isPgUniqueViolationOnColumn` checking Postgres code `23505` + `detail` substring), rather than wrapping the flow in `dataSource.transaction` — no multi-statement DB work is needed here, just `repository.save()`, matching the Tests row's "storage e repositório mockados" unit-test shape.
  - The multipart create/abort calls go straight through `storageService.client.send(new CreateMultipartUploadCommand(...))` / `AbortMultipartUploadCommand`, reusing the public `client`/`bucket` members `StorageService` already exposes (per SI-03.2) — no new `StorageService` methods were added, since this SI's technical actions only mention "the internal client", not new storage-layer methods.
  - Authored `test/videos.e2e-spec.ts` from the JIT test spec (`nestjs-project/specs/videos-upload-initiate.plan.md`), one `describe` with the 6 scenario blocks named exactly as the spec's scenario ids, mirroring `test/auth.e2e-spec.ts`'s local register+confirm+login helper (duplicated locally rather than extracted to a shared helper, matching the existing convention of no shared e2e helper file).
  - Response DTO (`VideoUploadResponseDto`) and request DTO (`CreateVideoUploadDto`) were split into separate files per the project's one-class-per-file DTO convention, even though the plan's technical action 1 bundles both under a single bullet.

### SI-03.6 — Endpoints de partes do upload (assinar e listar)
- **Status:** completed
- **Tests:** 25 passing (14 unit/integration + 11 e2e)
- **Observations:**
  - `findOwnedByPublicId` reads `upload_id` (a `select: false` column) via `createQueryBuilder(...).addSelect('video.upload_id')` rather than an explicit `select: [...]` array, since the caller needs the full entity plus one normally-hidden field — an explicit array would have required re-listing every other column.
  - `test/videos.e2e-spec.ts` and `src/videos/videos.service.integration-spec.ts` both needed `STORAGE_PUBLIC_ENDPOINT` overridden to `http://host.docker.internal:3900` (default is `http://localhost:3900`, unreachable from inside the `nestjs-api` container) to do a real `PUT` against the Garage-signed part URL — same technique `storage.service.integration-spec.ts` already used in SI-03.2. For the e2e file this meant mutating `process.env.STORAGE_PUBLIC_ENDPOINT` at module scope before `AppModule` compiles (restored in `afterAll` since `process.env` is a shared global across e2e spec files in the same Jest run).
  - `videos.e2e-spec.ts` grew via two new nested `describe` blocks (`POST .../upload-parts`, `GET .../upload-parts`) inside the existing top-level `describe('Videos (e2e)', ...)` rather than a new file — SI-03.6's Test Spec targets the same `target_file` as SI-03.5's, reusing the existing setup/helpers (`registerConfirmAndLogin`, `throttlerStorage`).
  - `rejects-when-not-uploading` transitions a video to `processing` via a direct `dataSource.query(UPDATE ...)` rather than a real completion flow, since `POST /videos/:public_id/upload-completion` (SI-03.7) doesn't exist yet.

### SI-03.7 — Endpoint de conclusão do upload e enfileiramento do processamento
- **Status:** completed
- **Tests:** 37 passing (0 fix attempts)
- **Observations:**
  - `VideosService` gained two new constructor dependencies (`DataSource`, `@InjectQueue(QUEUES.VIDEO_PROCESSING)`), so all pre-existing test doubles for it (both `Test.createTestingModule` blocks in `videos.service.spec.ts`, both manual `new VideosService(...)` constructions in `videos.service.integration-spec.ts`) needed matching provider/argument updates — a stub `{ transaction: jest.fn() }` and stub queue for unit tests, a real `DataSource` (already in scope) and a real `bullmq` `Queue` built directly from `queueConfig()` (mirroring the existing `new StorageService(storageConfig())` pattern) for integration tests.
  - The "parts must be exactly `1..part_count` in ascending order" validation (technical action 3) is enforced with a single strict check — `parts[i].part_number === i+1` for every index — which happens to reject both "incomplete list" and "out of order" in one pass, matching the unit Tests row's two named UPLOAD_INCOMPLETE scenarios without separate branches.
  - The DB transition (`upload_completed_at`, `upload_id = null`, `processing_status = 'processing'`) is wrapped in `dataSource.transaction(...)` per the plan's technical action 3 even though it is a single `UPDATE` statement — no other write happens alongside it in this SI, so the transaction boundary exists purely to match the plan text and to be a ready extension point, not because atomicity is at risk today.
  - Integration and e2e completion tests use a small (1024-byte) single-part video rather than reusing the `PART_SIZE_BYTES`-sized (64 MiB) fixture the other SIs use, since the multipart minimum-part-size rule (5 MiB) only applies to non-final parts — a single-part upload has no such floor, so this keeps the real-Garage round trip fast.
  - `test/videos.e2e-spec.ts` gained a `videoProcessingQueue` handle (`app.get(getQueueToken(QUEUES.VIDEO_PROCESSING))`) obliterated in the shared `beforeEach` (alongside the existing table/throttler cleanup) so queue state never leaks between tests in this file, including ones from SI-03.5/3.6 that don't touch the queue.

### SI-03.8 — Endpoint GET /videos/:public_id (status e metadados)
- **Status:** completed
- **Tests:** 40 passing (0 fix attempts)
- **Observations:**
  - `getOwnedVideo` calls `findOwnedByPublicId` without `{ selectUploadId: true }` since the response DTO never surfaces `upload_id` — the default query (which excludes the `select: false` column) is already correct.
  - `duration_seconds` is stored as a Postgres `numeric` mapped to `string | null` on the entity (`sizeBytesTransformer`-style precision preservation); the DTO mapping does `parseFloat` only when non-null, matching the same null-safe pattern `processed_at?.toISOString() ?? null` uses for the nullable timestamp.
  - E2E `ready`/`failed` scenarios seed state with a direct `dataSource.query('UPDATE videos SET ...')` rather than driving a real upload+worker flow, per the JIT spec's own setup note — the worker (SI-03.9) doesn't exist yet, and this endpoint's contract only cares about reading whatever the row currently holds.

### SI-03.9 — Worker: entrypoint e processamento do vídeo
- **Status:** completed
- **Tests:** 16 passing (2 fix attempts)
- **Observations:**
  - `src/worker.ts`, `src/worker.module.ts`, `src/worker.module.integration-spec.ts`, and all four files under `src/videos/processing/` were already implemented on disk when this run started (same context-cleared-mid-SI pattern as SI-03.3); verified each against the plan's Technical actions, Events/Messages spec, and Data Model before accepting them, then ran the SI's tests fresh — 5 of 16 failed on the first run.
  - Fix 1/2: `worker.module.ts` registered only `TypeOrmModule.forFeature([Video])`; TypeORM needs every entity reachable via a registered entity's relations to be present in the same connection to build inverse-relation metadata, even when no repository for it is injected. `Video` → `User` → `Channel` is the full chain (`Channel` only points back to `User`, closing the graph), so fixed to `TypeOrmModule.forFeature([Video, User, Channel])`. Surfaced across two fix-loop iterations (one entity per attempt) since each fix revealed the next hop's identical error shape.
  - Fix 2/2: `video-processing.processor.integration-spec.ts`'s `beforeAll` called `Test.createTestingModule({...}).compile()` but never `.init()` — `@nestjs/bullmq`'s `BullRegistrar.onModuleInit()` (which discovers `@Processor` classes and starts their underlying BullMQ `Worker`) only runs via `NestApplicationContext.init()`, which plain `.compile()` never calls. Without it, no worker ever consumed the jobs the tests added, so all 4 tests timed out waiting for status transitions that could never happen. Fixed by adding `await module.init();` right after `.compile()`. This is a reusable gotcha for any future integration test that exercises a `@Processor`/`WorkerHost` outside a full `createNestApplication()` + `app.init()` E2E setup.
  - `onFailed`'s guard (`processing_status: 'processing'` in the `update()` where-clause) and `process()`'s early-return for non-`processing` videos together satisfy the "repeated job for an already-`ready` video doesn't alter the row" AC without any extra idempotency bookkeeping beyond the status column itself.

### SI-03.10 — Endpoints de URL de reprodução e download
- **Status:** completed
- **Tests:** 64 passing (0 fix attempts)
- **Observations:**
  - Reused the existing `StorageService.presignGetObject(key, expiresInSeconds, contentDisposition?)` (added in SI-03.2, unused until now) instead of calling `getSignedUrl`/`GetObjectCommand` directly in `VideosService`, per the plan's own "reuse existing StorageService methods" precedent from SI-03.5 — the method already implements exactly the signature the plan's technical actions describe.
  - `sanitizedDownloadFilename` strips the original extension, removes `"` and control characters, then appends `.mp4` unconditionally (the file is always a remuxed MP4 regardless of the source container) — covered by a dedicated unit test with a filename containing a quote character.
  - JIT e2e spec's setup note ("seeded directly with a real object uploaded to that key, when the worker path is exercised elsewhere") was taken literally: `test/videos.e2e-spec.ts` gained a `seedReadyVideo` helper that PUTs a real 2 KiB object to `videos/{public_id}/video.mp4` via `StorageService` and updates the row directly, rather than driving a real upload through the actual `video-worker` container (already covered by SI-03.9's own integration tests).

### SI-03.11 — Job de manutenção: expurgo de uploads abandonados e de originais com falha
- **Status:** completed
- **Tests:** 8 passing (1 fix attempt)
- **Observations:**
  - `AbortMultipartUploadCommand` on an already-gone upload (aborted independently by the bucket's own lifecycle rule from SI-03.1, or a prior run of this job) is wrapped in try/catch-and-log so the row deletion still proceeds — matches the "background task" catch-and-log exception in `nestjs-services.md`. `DeleteObjectCommand` needed no such guard since S3/Garage delete is idempotent by design (204 on a missing key, no error).
  - Added a `SCHEDULES` export to `queue.constants.ts` (`PURGE_STALE_UPLOADS_CRON: '0 0 * * * *'`) so `worker.ts`'s bootstrap and `worker.module.integration-spec.ts`'s extended test reference the same literal instead of duplicating the cron pattern.
  - Fix (1 attempt): `Queue.getJobSchedulers()` in the installed `bullmq@^6.3.6` returns objects shaped `{ key, name, next, pattern, ... }`, not `{ id, ... }` — the scheduler-idempotency test's filter used `s.id`, which never matched (confirmed by reading the installed package's source directly, not docs/training data, since this is a fast-moving BullMQ v6 API). Fixed to `s.key`.
  - The scheduler idempotency test calls `queue.upsertJobScheduler(...)` directly against the real `video-maintenance` queue instance obtained from the compiled `WorkerModule`, rather than importing/executing `worker.ts`'s side-effecting bootstrap script — it exercises the same BullMQ idempotency guarantee (keyed by scheduler id) that a real worker restart relies on, without needing a second full `NestFactory.createApplicationContext` call in-process.

### SI-03.12 — Regenerar o artefato OpenAPI com os endpoints de vídeos
- **Status:** completed
- **Tests:** no tests (artefato gerado; verificado manualmente contra as ACs — ver observações)
- **Observations:**
  - `@ApiTags('videos')` (classe) e `@ApiBearerAuth('access-token')` (por método, em todos os 7 endpoints) já estavam presentes no `VideosController` desde as SIs 03.5–03.10 — a convenção do projeto (per `nestjs-controllers.md` e o exemplo canônico `auth.controller.ts`) é `@ApiBearerAuth` por método, não na classe, então a ação técnica 1 já estava satisfeita; nenhuma mudança necessária no controller.
  - `npm run openapi:export` (ts-node, fora do pipeline `nest build`) falhava por um gap de type-safety pré-existente em `storage.config.ts` (SI-03.2): `accessKeyId`/`secretAccessKey`/`bucket` eram tipados `string | undefined` a partir de `process.env.X` direto, mesmo sendo Joi-required — divergindo da convenção já usada em `auth.config.ts` (`process.env.JWT_SECRET!`). Corrigido para usar `!` nos três campos, alinhando com a convenção existente. Sem esse fix, nem `openapi:export` nem `npx tsc --noEmit` completavam.
  - Mais relevante: `CreateVideoUploadDto`, `SignUploadPartsDto` e `CompleteUploadDto` (os 3 DTOs de request que não tinham `@ApiProperty()` explícito, confiando no plugin `@nestjs/swagger` do `nest-cli.json` para inferir a partir dos decorators do `class-validator`) geravam `properties: {}` vazio no artefato — o plugin do CLI só roda durante `nest build`/`nest start`, não durante `ts-node` puro. Isso violava diretamente a AC 3 da própria SI ("part_numbers" era citado explicitamente como exemplo esperado). Corrigido adicionando `@ApiProperty()` explícito a cada campo desses 3 DTOs (incluindo o `CompletedPartDto` interno de `CompleteUploadDto`), no mesmo estilo já usado pelos DTOs de resposta (`example: ...`, `type: [Tipo]` para arrays de objeto).
  - Verificado programaticamente (script Node ad-hoc, não commitado): as 7 operações em `/videos*` documentam todos os status de erro esperados com `$ref: '#/components/schemas/ApiErrorEnvelope'`; `npm run openapi:export` rodado duas vezes seguidas não gera diff no artefato.
  - Estes fixes (storage.config.ts + 3 DTOs) tecnicamente tocam código de SIs anteriores (03.2, 03.5, 03.6, 03.7) já marcadas como completas, mas eram bloqueadores diretos e mecânicos (apenas tipagem/decorators, sem mudança de comportamento) para a própria ação técnica 2 desta SI e para o `tsc --noEmit` exigido no Definition of Done — corrigidos em vez de escalados, dado o escopo estritamente de type-safety/OpenAPI.
