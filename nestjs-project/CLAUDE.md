# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, Redis, object storage) — **never** start the NestJS application server or the video worker unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

`nestjs-api` only declares `depends_on` for `db` and `mailpit`, so bring up the whole stack (`docker compose up -d`) to get `redis`, `garage` and `garage-init` running as well.

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all long-running services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **Redis:** `docker compose exec redis redis-cli ping` — expect `PONG`
- **Garage bootstrap:** `docker compose ps -a garage-init` — expect `Exited (0)`. This one-shot container assigns the Garage node layout and creates the access key and the bucket. The API and the worker call the bucket at boot (`StorageService.onModuleInit`), so they do not start without a healthy Garage and bucket

Only start the NestJS dev server (`npm run start:dev`) or the video worker (`npm run start:worker:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev

# Run the video worker (watch mode) — in its own service
docker compose exec video-worker npm run start:worker:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — same `Dockerfile.dev` image (with `ffmpeg`) and the same bind mount as `nestjs-api`, no published port. It idles (`tail -f /dev/null`) until the worker is started with `docker compose exec`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `redis` — Redis 7 (BullMQ backend), port `6379`
- `garage` — Garage, S3-compatible object storage, S3 API on port `3900` (its admin API on `3903` is only reachable inside the Compose network)
- `garage-init` — one-shot bootstrap for `garage`; runs `scripts/garage-init.sh` against the admin API and exits
- `mailpit` — SMTP on port `1025`, web UI on port `8025`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Verify Redis is ready (runs inside the redis container)
docker compose exec redis redis-cli ping

# Check container logs
docker compose logs nestjs-api
docker compose logs video-worker
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

The video worker scripts run in the `video-worker` service instead (`docker compose exec video-worker …`):

```bash
npm run start:worker                     # nest start --entryFile worker
npm run start:worker:dev                 # Same, with hot-reload
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
docker compose exec redis redis-cli ping
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database (and, for the videos and queue suites, the same Redis queues). They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e -- --runInBand   # the script itself does not pass the flag
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables (and obliterate queues) concurrently.

Storage, queue and video-processing tests run against real infrastructure: `db`, `redis` and `garage` (with `garage-init` finished) must be up, and the FFmpeg tests use the real `ffmpeg`/`ffprobe` installed in the `nestjs-api` image. A running video worker consumes the same `video-processing` queue the tests enqueue into, so stop it before running the suite (`docker compose restart video-worker` kills the process and leaves the container idle). `src/database/migrations.integration-spec.ts` drops every managed table in the shared database in its `beforeAll` and re-applies the migrations in its `afterAll`. Tests that need a `@Processor` to consume jobs must call `module.init()` after `.compile()`, because the BullMQ worker only starts in `onModuleInit`. Presigned URLs are issued for `STORAGE_PUBLIC_ENDPOINT`, which is unreachable from inside the container, so these tests override it to `http://host.docker.internal:3900`.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, worker, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `start:worker`, `start:worker:dev`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.
- `transformIgnorePatterns: ["node_modules/(?!(@nestjs/bullmq|@nestjs/bull-shared)/)"]` — those two packages ship ESM only, so Jest must transform them; without it any file importing `@nestjs/bullmq` fails with `SyntaxError: Unexpected token 'export'`.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

### Storage and queue variables

Validated by the Joi schema in `src/config/env.validation.ts` and read by `src/config/storage.config.ts` and `src/config/queue.config.ts`. `.env.example` holds the development values.

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `STORAGE_ENDPOINT` | no | `http://garage:3900` | Server → storage traffic (Compose service name) |
| `STORAGE_PUBLIC_ENDPOINT` | no | `http://localhost:3900` | Browser-facing; used only to sign presigned URLs |
| `STORAGE_REGION` | no | `garage` | |
| `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY` | yes | — | Imported into Garage by `garage-init` |
| `STORAGE_BUCKET` | yes | — | Created by `garage-init` |
| `STORAGE_CORS_ORIGINS` | yes | — | Comma-separated browser origins allowed by the bucket CORS rule |
| `REDIS_HOST` | yes | — | `redis` in Compose |
| `REDIS_PORT` | no | `6379` | |

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`)
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module
- `AppModule` (HTTP API, entry `src/main.ts`) imports `AuthModule` and `VideosModule` on top of the global config and TypeORM setup. `StorageModule` and `QueueModule` are not registered in `AppModule`: `VideosModule` imports both
- `WorkerModule` (entry `src/worker.ts`) is a separate Nest application context with no HTTP server. It reuses `StorageModule`, `QueueModule` and the `Video` entity and hosts the background processors

### Videos, storage and queue

- `videos/videos.controller.ts` and `videos.service.ts` — the seven `/videos` endpoints (listed in the root `CLAUDE.md`). The controller has `@SkipThrottle()` and no route is `@Public()`. Every read goes through `findOwnedByPublicId`, which throws `VideoNotFoundException` for both a missing and a foreign video
- `videos/entities/video.entity.ts` and migration `database/migrations/1789680630228-CreateVideosTable.ts` — the `videos` table. `public_id` (11-char base64url from `public-id.util.ts`) is the external identifier. `upload_id` is `select: false`: load it with `findOwnedByPublicId(userId, publicId, { selectUploadId: true })`. `processing_status` (`uploading` | `processing` | `ready` | `failed`) and `publication_status` (`draft` only, for now) are plain strings, not enums
- `videos/videos.constants.ts` — 10 GiB max upload, 64 MiB parts, accepted content types, playback URL TTL 6 h, download URL TTL 15 min, stale-upload age 24 h, failed-original retention 7 days. Presigned part URLs last 1 h (constant in `videos.service.ts`)
- Object keys: `videos/{public_id}/original` (upload source), `videos/{public_id}/video.mp4`, `videos/{public_id}/thumbnail.jpg`
- Domain exceptions in `common/exceptions/domain.exception.ts`: `UPLOAD_TOO_LARGE` 413, `UNSUPPORTED_MEDIA_TYPE` 415, `VIDEO_NOT_FOUND` 404, `INVALID_PART_NUMBER` 400, `UPLOAD_NOT_IN_PROGRESS` 409, `UPLOAD_INCOMPLETE` 422, `VIDEO_NOT_READY` 409

**Storage** (`storage/storage.service.ts`):
- Two S3 clients, both `forcePathStyle: true` and `requestChecksumCalculation: 'WHEN_REQUIRED'` (with the SDK default, presigned part URLs embed a checksum placeholder that Garage rejects). `client` uses `STORAGE_ENDPOINT` for all server → storage calls; `publicClient` uses `STORAGE_PUBLIC_ENDPOINT` and is only used by `presignUploadPart` and `presignGetObject`
- `onModuleInit` idempotently applies the bucket CORS rule (origins from `STORAGE_CORS_ORIGINS`, methods `PUT`/`GET`/`HEAD`, exposes `ETag`) and a lifecycle rule that aborts incomplete multipart uploads after 1 day

**Queue** (`queue/queue.module.ts`, `queue/queue.constants.ts`):
- BullMQ connects to `REDIS_HOST`/`REDIS_PORT`. Queues: `video-processing` (default job options: 3 attempts, exponential backoff starting at 30 s) and `video-maintenance`. Job names: `process-video`, `purge-stale-uploads`. Names and the maintenance cron live in `queue.constants.ts`
- `ioredis` is a direct dependency on purpose: it is an optional peer of BullMQ 6, which needs it when `connection` is a `{ host, port }` object

**Worker** (`worker.ts`, `worker.module.ts`, `videos/processing/`):
- `VideoProcessingProcessor` consumes `process-video` (job id = video id; it does nothing unless the video is `processing`). It downloads the original, runs `ffprobe`, and accepts only H.264 video with AAC audio or no audio (`UNSUPPORTED_CODEC`; unreadable media or no video stream is `INVALID_MEDIA`, and both are non-retryable). It then remuxes with `-c copy -movflags +faststart` (no transcoding), extracts a JPEG thumbnail scaled to 1280 px wide, uploads both, marks the video `ready` and deletes the original
- On a final failure the `failed` handler sets `processing_status = 'failed'`, `failure_code` (the error message for non-retryable errors, otherwise `PROCESSING_FAILED`) and `failed_at`
- `worker.ts` upserts a job scheduler `purge-stale-uploads` on `video-maintenance` at bootstrap (cron `0 0 * * * *`, hourly). `VideoMaintenanceProcessor` then runs `VideoMaintenanceService`: it deletes `uploading` videos older than 24 h (aborting the multipart upload, then removing the row) and deletes the original object of `failed` videos older than 7 days (the row stays)
- `WorkerModule` registers `TypeOrmModule.forFeature([Video, User, Channel])`: TypeORM needs the metadata of every entity reachable through relations (`Video` → `User` → `Channel`), even though only `Video` is queried

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings; `unbound-method` is off in test files (`*.spec.ts`, `*.integration-spec.ts`, `*.e2e-spec.ts`) because `expect(mock.method)` on `jest.Mocked<T>` is a known false positive, and stays on for production code

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
