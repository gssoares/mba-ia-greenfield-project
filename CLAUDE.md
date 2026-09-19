# CLAUDE.md

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with two main areas:

- `nestjs-project/` — Backend API (NestJS 11, TypeScript, Express) and its Docker Compose stack. Domain modules: `auth`, `users`, `channels`, `videos`. Infrastructure modules: `storage` (S3 client), `queue` (BullMQ), `mail`. Also hosts the video worker entrypoint (`src/worker.ts`).
- `docs/` — Project documentation, architecture diagrams, and planning.
- `next-frontend/` — Frontend (Next.js 16, React 19) with its own `CLAUDE.md`. It does not consume the videos endpoints yet (no upload UI).

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. The diagram is technology-agnostic (it still shows the queue as "TBD" and storage as "S3 or MinIO"); the concrete choices are listed below. Key containers:

- **Frontend** (Next.js) → calls API via REST; browsers upload to and stream from Object Storage directly, through presigned URLs issued by the API
- **API** (Nest.js, Compose service `nestjs-api`) → business rules, auth, reads/writes DB, opens multipart uploads in storage and signs presigned URLs, publishes jobs to queue, sends emails
- **Video Worker** (Compose service `video-worker`, entrypoint `nestjs-project/src/worker.ts`) → a Nest application context (no HTTP server) that consumes jobs from the queue, runs the `ffprobe`/`ffmpeg` binaries, updates DB and storage
- **Database** (PostgreSQL 17) → currently users, channels, auth tokens, videos (comments and likes are not implemented yet)
- **Object Storage** (Garage, S3-compatible, accessed with AWS SDK v3; Compose services `garage` and the one-shot `garage-init`, which assigns the node layout and creates the access key and bucket) → video files and thumbnails
- **Message Queue** (BullMQ on Redis 7, Compose service `redis`) → `video-processing` and `video-maintenance` queues
- **Email Service** (SMTP; Mailpit in development) → account confirmation and password recovery

## Video Upload & Processing (Phase 03, backend only)

Implemented in `nestjs-project/src/videos/` (module details in `nestjs-project/CLAUDE.md`). All endpoints require a JWT and are scoped to the owner: another user's video answers `404 VIDEO_NOT_FOUND`. There is no anonymous access to videos yet, no endpoint to list videos, and nothing changes `publication_status` (every video stays `draft`).

| Endpoint | Success | Purpose |
|----------|---------|---------|
| `POST /videos` | 201 | Body `{ filename, content_type, size_bytes }`. Pre-registers the video as a draft with a unique 11-char `public_id`, opens an S3 multipart upload, returns `part_size_bytes` and `part_count` |
| `POST /videos/:public_id/upload-parts` | 200 | Body `{ part_numbers }`. Returns one presigned PUT URL per part |
| `GET /videos/:public_id/upload-parts` | 200 | Lists parts already stored, so an interrupted upload can resume |
| `POST /videos/:public_id/upload-completion` | 202 | Body `{ parts: [{ part_number, etag }] }`. Completes the multipart upload, verifies the final size, marks the video `processing` and enqueues the processing job |
| `GET /videos/:public_id` | 200 | Processing status and extracted metadata |
| `GET /videos/:public_id/playback-url` | 200 | Presigned GET URL for progressive playback (only when `ready`, else `409 VIDEO_NOT_READY`) |
| `GET /videos/:public_id/download-url` | 200 | Presigned GET URL (only when `ready`) that requests `Content-Disposition: attachment; filename="<original name>.mp4"` through the `response-content-disposition` query parameter. Observed with Garage v2.4.1: the URL is accepted (`206` with Range) but the response carries no `Content-Disposition` header, so the download is not forced yet |

Limits: files up to 10 GiB, sent in 64 MiB parts; accepted content types are `video/mp4` and `video/quicktime`.

`processing_status` lifecycle: `uploading` → `processing` → `ready` | `failed` (with a `failure_code`). The worker never transcodes: it remuxes the upload to a faststart MP4 and extracts a JPEG thumbnail. The source file is deleted once the video is `ready`.

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db`, `REDIS_HOST=redis`, `STORAGE_ENDPOINT=http://garage:3900` (the Compose service names)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

**Exception — browser-facing values.** `STORAGE_PUBLIC_ENDPOINT` (`http://localhost:3900` in `.env.example`) and `STORAGE_CORS_ORIGINS` (`http://localhost:3001`) are consumed by the user's browser, not by a container, so they intentionally point at the host. The public endpoint is baked into every presigned URL (its host is part of the signature), while server-to-storage traffic uses `STORAGE_ENDPOINT`. Because `localhost:3900` is unreachable from inside a container, the integration and e2e tests override `STORAGE_PUBLIC_ENDPOINT` to `http://host.docker.internal:3900`, which works through `extra_hosts` (`host.docker.internal:host-gateway`) on `nestjs-api` and `video-worker`.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.


## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code 
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring, 
reviewing, etc.), decompose the request into its underlying subtasks and 
concerns, then identify which available skills match any of them and activate 
those skills.

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool to look up the relevant library APIs and official documentation.

Always:

- Check the installed library version in the project manifest
- Retrieve the corresponding documentation using context7
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.