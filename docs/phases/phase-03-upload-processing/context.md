---
kind: phase
name: phase-03-upload-processing
sources_mtime:
  docs/project-plan.md: "2026-09-13T18:11:14+01:00"
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-09-15T09:13:06+01:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-13T18:11:14+01:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-09-13T18:11:14+01:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-09-13T18:11:14+01:00"
  docs/phases/phase-02-auth/context.md: "2026-09-13T18:11:14+01:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-09-13T18:11:14+01:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-09-13T18:11:14+01:00"
  .claude/skills/testing-guide-next-frontend/SKILL.md: "2026-09-13T18:11:14+01:00"
  docs/phases/phase-03-upload-processing/library-refs.md: "2026-09-15T09:17:36+01:00"
---

# phase-03-upload-processing — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** _None explicitly named in the plan for this phase (no subproject paths and no `Subprojetos:` line)._

**Deferred subprojects:** _None._

**Sequencing notes:** "> Depende de: Fase 01, Fase 02". Phase intro sentence: "Upload de arquivos grandes sem travar o sistema, processamento automático do vídeo e geração de URL única."

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta — "> Depende de: Fase 01"
- **Phase 04:** Gerenciamento de Vídeos e Canal — "> Depende de: Fase 02, Fase 03"

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-upload-processing/TD-01 | phase | Backend | Object Storage Engine (S3-compatible) | decided | A (Garage) | @aws-sdk/client-s3 |
|     └─ Last revision: 2026-09-14 — Bucket lifecycle rule aborts incomplete multipart uploads after 1 day (AMB-3) | | | | | | |
| phase-03-upload-processing/TD-02 | phase | Backend | Storage Endpoint Topology (internal vs browser-facing… | decided | A (Dual endpoint) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-upload-processing/TD-03 | phase | Cross-layer | Large-File Upload Protocol (10GB, resumable) | decided | A (Presigned S3 multipart, direct browser → storage)\* | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
|     └─ Last revision: 2026-09-14 — Upload ceiling fixed at 10 GiB (10 × 1024³ bytes); multipart part size 64 MiB;… | | | | | | |
| phase-03-upload-processing/TD-04 | phase | Frontend | Browser Upload Client | decided | A (Thin in-house multipart uploader) | — |
|     └─ Last revision: 2026-09-14 — Uploader runs 4 concurrent 64 MiB parts with 3 retries per part and backoff… | | | | | | |
| phase-03-upload-processing/TD-05 | phase | Cross-layer | Upload Completion Signal & Draft Lifecycle | decided | A (Client-driven completion endpoint) | @aws-sdk/client-s3 |
|     └─ Last revision: 2026-09-14 — Drafts stuck in `uploading` are purged after 24 h; on processing failure… | | | | | | |
| phase-03-upload-processing/TD-06 | phase | Cross-layer | Unique Public Video ID (URL identifier) | decided | A (Random 11-char base64url ID with unique index) | — |
| phase-03-upload-processing/TD-07 | phase | Backend | Background Job Queue | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | @nestjs/bullmq, bullmq |
|     └─ Last revision: 2026-09-14 — Processing job runs with 3 attempts and exponential backoff (AMB-3) | | | | | | |
| phase-03-upload-processing/TD-08 | phase | Backend | Video Worker Deployment Topology | decided | A (Same codebase, second entrypoint, separate container) | — |
| phase-03-upload-processing/TD-09 | phase | Backend | Media Probing & Thumbnail Tooling | decided | A (System FFmpeg + spawn wrapper) | — |
|     └─ Last revision: 2026-09-14 — Thumbnail: one JPEG frame 1280 px wide at 10% of duration, clamped for very… | | | | | | |
| phase-03-upload-processing/TD-10 | phase | Cross-layer | Accepted Input Formats & Normalization Policy | decided | B (Allowlist + remux-only normalization) | — |
| phase-03-upload-processing/TD-11 | phase | Cross-layer | Streaming Delivery Format | decided | A (Progressive playback over HTTP Range) | — |
| phase-03-upload-processing/TD-12 | phase | Cross-layer | Media Access Delivery (playback & download URLs) | decided | A (Private bucket + presigned GET URLs) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
|     └─ Last revision: 2026-09-14 — The single refresh-on-403 in the player moves to Phase 05 (watch page)… | | | | | | |

_Source files:_

- phase-03-upload-processing — `docs/decisions/technical-decisions-phase-03-upload-processing.md` (scope_type: phase)

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-upload-processing/TD-01, phase-03-upload-processing/TD-02 |
| Serviço de processamento em segundo plano (filas) | phase-03-upload-processing/TD-07, phase-03-upload-processing/TD-08 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-upload-processing/TD-02, phase-03-upload-processing/TD-03, phase-03-upload-processing/TD-04 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-upload-processing/TD-05 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-upload-processing/TD-05, phase-03-upload-processing/TD-08, phase-03-upload-processing/TD-09, phase-03-upload-processing/TD-10 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-upload-processing/TD-08, phase-03-upload-processing/TD-09 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-upload-processing/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-upload-processing/TD-10, phase-03-upload-processing/TD-11, phase-03-upload-processing/TD-12 |
| Download do vídeo pelo usuário | phase-03-upload-processing/TD-12 |

## Decisions Detail

### phase-03-upload-processing/TD-01

**Recommendation:** it is the only candidate whose official documentation confirms every S3 feature the phase depends on (multipart, presigned URLs, CORS, and the `AbortIncompleteMultipartUpload` lifecycle rule that cleans abandoned 10 GB uploads), under governance with no commercial pull; the missing console and init script are one-time dev costs. RustFS is the fallback if a console matters more than proven presigned-multipart support. Because all code targets the S3 API through `@aws-sdk/client-s3`, the choice is reversible and does not constrain the production provider.
**Libraries:** @aws-sdk/client-s3

**Revisions:**
- 2026-09-14 — Bucket lifecycle rule aborts incomplete multipart uploads after 1 day (AMB-3). Rationale: Standard preset (Recommended).

### phase-03-upload-processing/TD-02

**Recommendation:** it is the only option that satisfies both the Docker service-name rule for server traffic and signature validity for browser traffic, and it mirrors how production separates internal and public storage hostnames. The second client is a few lines of configuration; the required safety net is an integration test that presigns via the public endpoint.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

### phase-03-upload-processing/TD-03

**Recommendation:** it is the only option that keeps upload bytes off both Node servers while providing resume, which is exactly the "sem impacto na performance" + "retomar em caso de falha" pair; it also realizes the presigned-storage path already anticipated in `next-frontend-config-base/TD-03`. tus solves resume well but forces 10 GB through the BFF and the API, which the strict-BFF model makes doubly expensive.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-09-14 — Upload ceiling fixed at 10 GiB (10 × 1024³ bytes); multipart part size 64 MiB; presigned part-URL TTL 1 h (AMB-3). Rationale: Balanced preset (Recommended).

### phase-03-upload-processing/TD-04

**Recommendation:** with TD-03 A the uploader's job is narrow (slice, PUT, retry, resume), and keeping create/complete on the API preserves server-side control of object keys, size validation and the processing trigger (TD-05); Uppy's current `signRequest` model inverts that ownership. If TD-03 swings to tus, choose Option C.
**Libraries:** —

**Revisions:**
- 2026-09-14 — Phase 03 delivers the uploader as a next-frontend module plus BFF Route Handlers (initiate / sign parts / complete / media URLs) with no page mounting them; verification = uploader unit tests + BFF integration tests (MSW) + backend E2E against real storage; the upload screen lands in a later phase (AMB-2). Rationale: Uploader + BFF, no page (Recommended).
- 2026-09-14 — Uploader runs 4 concurrent 64 MiB parts with 3 retries per part and backoff (AMB-3). Rationale: Balanced preset (Recommended).

### phase-03-upload-processing/TD-05

**Recommendation:** the API already owns initiation, so owning completion keeps validation, state transitions and enqueueing in one transactional place without coupling Phase 03 to provider-specific eventing. Proposed processing statuses for the contract: `uploading → processing → ready | failed`. Note: "rascunho" (draft) is the publication axis owned by Phase 04 ("Fluxo de rascunho → publicação"); Phase 03 only creates the row as draft and manages the processing axis.
**Libraries:** @aws-sdk/client-s3

**Revisions:**
- 2026-09-14 — Drafts stuck in `uploading` are purged after 24 h; on processing failure the row keeps `processing_status = failed` + `failure_code` and the original object is deleted after 7 days (AMB-3). Rationale: Standard preset (Recommended).

### phase-03-upload-processing/TD-06

**Recommendation:** it is the only option that is simultaneously short, collision-proof by constraint, and non-enumerable, the last property being required by the unlisted-video capability in Phases 04–05; the UUID stays as the internal PK per entity conventions.
**Libraries:** —

### phase-03-upload-processing/TD-07

**Recommendation:** it delivers the job semantics this phase needs (retries, progress, long-job locks, repeatable cleanup) through an official NestJS integration, matching the precedent set in Phases 01–02; the non-atomic enqueue is neutralized by idempotent job IDs. pg-boss is the credible alternative if avoiding a new container outweighs building the Nest integration ourselves. (Redis 8 is AGPL-licensed and Valkey is a BSD wire-compatible fork; the image choice is an implementation detail — verify BullMQ compatibility in `/plan-build` if Valkey is preferred.)
**Libraries:** @nestjs/bullmq, bullmq

**Revisions:**
- 2026-09-14 — Processing job runs with 3 attempts and exponential backoff (AMB-3). Rationale: Standard preset (Recommended).

### phase-03-upload-processing/TD-08

**Recommendation:** it realizes the diagram's isolated worker and protects API latency while keeping one source of truth for entities and config; Option C pays duplication costs for flexibility no phase needs.
**Libraries:** —

### phase-03-upload-processing/TD-09

**Recommendation:** the Node wrapper ecosystem has been abandoned, and FFmpeg's own CLI is the stable interface; installing it only in the worker image (TD-08 A) keeps the API image lean. Suggested thumbnail policy for `/plan-build`: one frame at ~10% of duration (clamped for very short videos), fixed width, stored next to the video under a server-generated key.
**Libraries:** —

**Revisions:**
- 2026-09-14 — Thumbnail: one JPEG frame 1280 px wide at 10% of duration, clamped for very short videos (AMB-3). Rationale: Standard preset (Recommended).

### phase-03-upload-processing/TD-10

**Recommendation:** it guarantees streamable output within the phase's processing scope, fails early and visibly at the uploader instead of at the viewer, and leaves full transcoding (Option A) as a later capability if format rejection proves to be a real user pain.
**Libraries:** —

### phase-03-upload-processing/TD-11

**Recommendation:** it satisfies "sem necessidade de download completo" natively with no transcoding or player dependency, consistent with TD-10 B; HLS can be added later as an additional output without changing the upload pipeline.
**Libraries:** —

### phase-03-upload-processing/TD-12

**Recommendation:** it keeps bytes off Node servers while preserving per-request access control that Phases 04–05 depend on (drafts, unlisted, anonymous viewing); expiry is handled with a generous playback TTL plus a single refresh-on-403 in the player.
**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

**Revisions:**
- 2026-09-14 — Phase 03 media access is owner-only: only the owner may request playback/download URLs; any other caller receives `404 VIDEO_NOT_FOUND` so existence is not revealed; Phases 04–05 widen access (AMB-1). Rationale: Owner only, others 404 (Recommended).
- 2026-09-14 — Playback URL TTL 6 h; download URL TTL 15 min with `Content-Disposition: attachment` (AMB-3). Rationale: Balanced preset (Recommended).
- 2026-09-14 — The single refresh-on-403 in the player moves to Phase 05 (watch page); Phase 03 delivers URL issuance only (AMB-2). Rationale: Uploader + BFF, no page (Recommended).

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.
**Libraries:** @nestjs/swagger
**Revisions:**
- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.
**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.
**Libraries:** —

### next-frontend-openapi-typing/TD-01

**Recommendation:** Three reinforcing reasons. (1) **Strict BFF makes the SDK surface valueless on the client.** Only Route Handlers ever call the upstream Nest; they already use `fetch` (Next 16's caching extensions sit on top of native `fetch`); a generated SDK adds a third client style to learn for zero functional gain. (2) **Types-first matches the rest of the FE foundation.** Env validation is Zod-derived types; component variants are `cva` types; both are TS-first with zero generated runtime. `paths` is the natural extension — one `.d.ts` file imported wherever the contract is touched. (3) **MSW typing is solved by the same `paths` symbol.** Hand-written handlers in `mocks/handlers.ts` type their resolver returns off `paths["/videos"]["get"]["responses"][200]`, giving the contract guarantee without orval/kubb's verbose generated handlers (which would be overridden per-test anyway). The marginal cost of adding `openapi-fetch` (~6KB, server-side only) is small enough that we recommend the **types + thin-client** pair, not types alone — `openapi-fetch` removes the `fetch(API_URL + path, { method, headers, body })` boilerplate in each Route Handler while staying within the BFF model. Options B/C/D may be revisited if (a) client-side data-fetching enters the stack with TanStack Query and per-endpoint hooks are wanted, or (b) the API grows beyond ~20 operations and per-call boilerplate becomes painful.
**Libraries:** openapi-typescript, openapi-fetch

### next-frontend-openapi-typing/TD-02

**Recommendation:** Three reasons. (1) **Preserves the compose-stack independence** that `next-frontend-config-base/TD-03` Context calls out as the current architecture — neither subproject's compose file references the other. (2) **Drift is eliminated structurally when paired with TD-03's CI freshness check** — the check runs the sync script and asserts no diff on either `openapi.json` or `types.gen.ts`, so a backend PR that forgets to re-sync fails CI with a clear message. (3) **The committed local file is a real artifact in PR review** — reviewers see the contract change in `next-frontend/openapi.json`'s diff at the same time as the backend change, doubling the visibility (an `openapi.json`-only diff in a feature PR is a red flag for accidental drift). Option A is acceptable as a pre-CI fallback; Option C is rejected because the cross-stack file dependency in `docker-compose.yaml` introduces coupling that the current architecture explicitly avoids, and the "no drift" gain over B is small once TD-03 lands.
**Libraries:** —

### next-frontend-openapi-typing/TD-03

**Recommendation:** It is the only option that makes contract drift _both_ visible (in PR diffs) _and_ impossible to merge accidentally (CI fail). The complexity premium over Option A is one CI step. Option B's "no committed artifacts" purity is poorly paid for in a monorepo where the cross-subproject build coupling becomes a real ergonomic cost, and it wastes the PR visibility that TD-02 Option B's committed `openapi.json` is specifically designed to deliver. Option A is acceptable as a temporary state until the CI pipeline lands; downgrading from C to A is reversible (just remove the CI step) but upgrading to C later requires explaining `types.gen.ts` history in a separate commit. Start at C. Apply the same script-and-check pattern to any future generated artifact (e.g., if `openapi-fetch` is wrapped, the wrapper file is hand-written; the only generated artifact remains `types.gen.ts`).
**Libraries:** —

### next-frontend-openapi-typing/TD-04

**Recommendation:** It is the only option that (i) handles pass-through and reshape with the same mechanism, (ii) gives a single grep target for "what shape does the BFF expose", and (iii) decouples Component imports from App Router file paths (Components import `from "@/lib/api/contracts"`, not `from "@/app/api/videos/route"`). Option B is theoretically minimal but fragile against Next's actual RSC/Client/Route-Handler typing; Option C scatters the contract surface and creates drift opportunities. The "long file" concern is bounded — for the scope of StreamTube, the BFF will likely have <30 contract aliases at peak; sectioning by feature header comments is sufficient. Make `lib/api/contracts.ts` the only file that imports `paths` from `types.gen.ts` (lintable later); every other consumer imports from `contracts.ts`.
**Libraries:** —

### next-frontend-openapi-typing/TD-05

**Recommendation:** Reasons: (1) **Determinism over auto-generation** — BFF integration tests assert on specific values; randomized fixtures are anti-helpful. (2) **Coherence with TD-01 recommendation** — `openapi-typescript`'s `paths` type is the single contract anchor; reusing it in MSW handlers means "spec ↔ handler ↔ assertion" is one type chain. (3) **Scale fit** — Phase 02 introduces few endpoints; the manual cost is negligible at this stage. If the API grows to dozens of endpoints and authoring overhead becomes real, this TD can be superseded with a Kubb-or-hey-api MSW plugin without touching TD-01's `paths` import sites (the generator just produces additional handler files; the existing manual handlers stay valid). Option B locks the project into a heavier TD-01 choice for marginal mock-authoring savings; Option C is Option A with an unnecessary detour.
**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions:... _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function... _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and... _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning... _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## UI Inventory

_Frontend-runtime only — no screen inventory needed for this phase.
Run /screen-inventory phase-03-upload-processing if a UI surface is added in a future revision._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

### next-frontend

| Artifact type | Required layers |
|---------------|-----------------|
| Page — sync RSC, static, no logic | None at component level; cover only if part of a critical flow → `*.e2e-spec.ts` |
| Page — sync RSC composing client children | Test client children directly; cover rendered page via `*.e2e-spec.ts` |
| Page — async RSC (`async function Page()` with `await`) | `*.e2e-spec.ts` only — Vitest cannot render it |
| Layout (`layout.tsx`) | None unless it adds logic (auth gate, conditional render); else via E2E |
| Client component (`"use client"`) with state/handlers | `*.test.tsx` — RTL + `jsdom` docblock, mock `next/navigation`, MSW for fetch |
| Feature component (server, composes primitives) | Skip unit; cover via the page's E2E |
| shadcn UI primitive (`components/ui/*`) | None — trust the library; cover via consumers |
| Icon (`components/icons/*`) | None |
| `lib/` utility / boundary module with branching or shape assumptions | `*.test.ts` |
| Custom hook (`hooks/*`) | `*.test.ts(x)` with `renderHook`, `jsdom` docblock |
| Route handler (`app/api/**/route.ts`) — proxy or with branching | `*.integration.test.ts` with MSW (+ `*.test.ts` for extracted pure logic) |
| Server action / middleware / error-loading-not-found / metadata | See guide — depends on type |
