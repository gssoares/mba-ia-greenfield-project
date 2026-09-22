---
kind: phase
name: phase-03-upload-processing
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-upload-processing/context.md: "2026-09-15T09:17:59+01:00"
  docs/phases/phase-03-upload-processing/library-refs.md: "2026-09-15T09:17:36+01:00"
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-09-15T09:13:06+01:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-09-13T18:11:14+01:00"
  docs/decisions/technical-decisions-next-frontend-openapi-typing.md: "2026-09-13T18:11:14+01:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar upload de até 10GB funcional sem impacto na performance (armazenamento de vídeos e thumbnails, pré-cadastro automático do vídeo como rascunho ao iniciar o upload), processamento automático em segundo plano via filas (extração de duração e metadados e geração automática de thumbnail), URL única por vídeo sem conflito, e reprodução via streaming e download do vídeo pelo usuário.

---

## Step Implementations

### SI-03.1 — Infra: Garage, Redis, video-worker e FFmpeg no Compose

**Description:** Adicionar ao `nestjs-project/compose.yaml` o object storage Garage (com bootstrap one-shot), o Redis das filas e o serviço `video-worker`, e instalar FFmpeg na imagem de desenvolvimento — pré-requisitos de infraestrutura de todos os SIs de storage, fila e processamento.

**Technical actions:**

1. Adicionar o serviço `garage` (S3 API na porta `3900`, `garage.toml` montado, volumes de meta/data) e o serviço one-shot `garage-init`, que aplica o layout do nó, cria a access key e o bucket e concede a key ao bucket — Garage não traz console nem script de init (per `phase-03-upload-processing/TD-01`).
2. Adicionar o serviço `redis` (porta `6379`, healthcheck `redis-cli ping`) (per `phase-03-upload-processing/TD-07`).
3. Adicionar o serviço `video-worker` com o mesmo build (`Dockerfile.dev`) e bind mount do `nestjs-api`, ocioso por padrão como o `nestjs-api` (`tail -f /dev/null`), com `depends_on` em `db` (`service_healthy`), `redis` (`service_healthy`) e `garage-init` (`service_completed_successfully`); adicionar `extra_hosts: ["host.docker.internal:host-gateway"]` em `nestjs-api` e `video-worker` para que URLs assinadas contra o endpoint público sejam alcançáveis de dentro dos containers nos testes (per `phase-03-upload-processing/TD-08`, `TD-02`).
4. Instalar `ffmpeg` no `Dockerfile.dev` — a imagem de desenvolvimento é compartilhada por `nestjs-api` e `video-worker`, então a suíte Jest (que roda no `nestjs-api`) exercita o FFmpeg real; a imagem de produção exclusiva do worker descrita em `phase-03-upload-processing/TD-09` fica fora do escopo da Phase 03.
5. Adicionar ao `.env.example` as chaves `STORAGE_ENDPOINT=http://garage:3900`, `STORAGE_PUBLIC_ENDPOINT=http://localhost:3900`, `STORAGE_REGION`, `STORAGE_ACCESS_KEY_ID`, `STORAGE_SECRET_ACCESS_KEY`, `STORAGE_BUCKET`, `STORAGE_CORS_ORIGINS=http://localhost:3001`, `REDIS_HOST=redis`, `REDIS_PORT=6379` — hosts internos usam o nome do serviço do Compose (regra de Docker networking do `CLAUDE.md` raiz).

**Tests:** _(empty — Infra)_

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` lista `garage`, `redis` e `video-worker` como `running` e `garage-init` como encerrado com exit code `0`.
- `docker compose exec redis redis-cli ping` retorna `PONG`.
- O bucket configurado em `STORAGE_BUCKET` existe no Garage e aceita a access key de `STORAGE_ACCESS_KEY_ID`.
- `docker compose exec nestjs-api ffmpeg -version` e `docker compose exec video-worker ffprobe -version` terminam com exit code `0`.
- `docker compose up -d` a partir de um ambiente limpo recria bucket e key sem intervenção manual.

---

### SI-03.2 — Módulo de storage S3 com endpoints interno e público

**Description:** Criar o `StorageModule` com configuração tipada, dois clientes S3 (endpoint interno para tráfego servidor→storage, endpoint público só para assinar URLs usadas pelo browser) e a configuração do bucket (CORS + lifecycle) aplicada no bootstrap — base de todos os SIs de upload, processamento e entrega de mídia.

**Technical actions:**

1. Instalar `@aws-sdk/client-s3` e `@aws-sdk/s3-request-presigner` em `^3.1132.0` (mesma versão nos dois pacotes) — todo acesso ao storage usa a API S3, o que mantém a escolha do Garage reversível (per `phase-03-upload-processing/TD-01`).
2. Criar `src/config/storage.config.ts` (`registerAs('storage', …)`) com `endpoint`, `publicEndpoint`, `region`, `accessKeyId`, `secretAccessKey`, `bucket` e `corsOrigins`, e adicionar as chaves `STORAGE_*` ao schema Joi em `src/config/env.validation.ts` (convenção herdada de `phase-01-configuracao-base/TD-02`, `TD-03`).
3. Criar `src/storage/storage.module.ts` e `src/storage/storage.service.ts` com dois `S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } })` — `forcePathStyle: true` é obrigatório porque o Garage não tem DNS wildcard para buckets. O interno (`STORAGE_ENDPOINT`) executa `CreateMultipartUploadCommand`, `ListPartsCommand`, `CompleteMultipartUploadCommand`, `AbortMultipartUploadCommand`, `HeadObjectCommand`, `GetObjectCommand`, `PutObjectCommand` e `DeleteObjectCommand`; o público (`STORAGE_PUBLIC_ENDPOINT`) é usado apenas por `presignUploadPart(key, uploadId, partNumber, expiresInSeconds)` e `presignGetObject(key, expiresInSeconds, contentDisposition?)`, ambos via `getSignedUrl(publicClient, command, { expiresIn })` com `expiresIn` sempre explícito — o default do SDK é 900 s e o host do endpoint entra na assinatura (per `phase-03-upload-processing/TD-02`).
4. No `onModuleInit` do `StorageService`, aplicar ao bucket de forma idempotente `PutBucketCorsCommand` (origens de `STORAGE_CORS_ORIGINS`, métodos `PUT`/`GET`/`HEAD`, `ExposeHeaders: ['ETag']` — o uploader lê o `ETag` de cada parte) e `PutBucketLifecycleConfigurationCommand` com uma regra `{ ID: 'abort-incomplete-multipart', Status: 'Enabled', Filter: { Prefix: '' }, AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 } }` (per `phase-03-upload-processing/TD-01` revisão).
5. Nos setups de teste integration/e2e, sobrescrever `STORAGE_PUBLIC_ENDPOINT=http://host.docker.internal:3900` — hostname distinto do interno, para que os testes provem que URLs assinadas pelo endpoint público são aceitas pelo storage (safety net de `phase-03-upload-processing/TD-02`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageModule` | Unit: compilation test | `src/storage/storage.module.spec.ts` |
| `StorageService` | Integration: multipart real no Garage — `CreateMultipartUploadCommand`, `presignUploadPart` pelo endpoint público + `PUT` HTTP, `ListPartsCommand`, `CompleteMultipartUploadCommand`, `HeadObjectCommand` com o `ContentLength` esperado | `src/storage/storage.service.integration-spec.ts` |
| `StorageService` | Integration: configuração do bucket — CORS expõe `ETag`; lifecycle contém `AbortIncompleteMultipartUpload` com `DaysAfterInitiation: 1`; `presignGetObject` repassa o `expiresIn` recebido | `src/storage/storage.service.integration-spec.ts` |
| `env.validation` | Integration: boot falha quando uma chave `STORAGE_*` obrigatória está ausente | `src/config/env.validation.integration-spec.ts` (existente, estendido) |

**Dependencies:** SI-03.1 — Garage, bucket e chaves de ambiente precisam existir.

**Acceptance criteria:**

- `presignUploadPart` retorna uma URL cujo host é o de `STORAGE_PUBLIC_ENDPOINT`, e um `PUT` nessa URL é aceito pelo Garage com `200` e header `ETag`.
- Uma URL emitida por `presignUploadPart` com `expiresInSeconds = 3600` traz `X-Amz-Expires=3600` na query string.
- Após o boot da aplicação, `GetBucketCors` retorna a origem `http://localhost:3001` com `ETag` em `ExposeHeaders`.
- Após o boot da aplicação, `GetBucketLifecycleConfiguration` retorna uma regra `AbortIncompleteMultipartUpload` com `DaysAfterInitiation: 1`.
- Iniciar a aplicação sem `STORAGE_BUCKET` falha na validação de ambiente com mensagem citando a chave.
- Reiniciar a aplicação não duplica nem quebra a configuração do bucket.

---

### SI-03.3 — Entidade Video, migration e gerador de ID público

**Description:** Criar a entidade `Video` (tabela `videos`) com a relação `User` 1:N, a migration correspondente e o gerador de `public_id` — persistência compartilhada pela API e pelo worker.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com os campos, tipos, constraints e índices de `### Data Model → Video` (`@Entity('videos')`, PK uuid, `public_id` único, `upload_id` com `select: false`, `@CreateDateColumn`/`@UpdateDateColumn`) e `@ManyToOne(() => User, (user) => user.videos)` + `@JoinColumn({ name: 'user_id' })` (per `phase-03-upload-processing/TD-05`, `TD-06`).
2. Adicionar `@OneToMany(() => Video, (video) => video.user)` `videos: Video[]` em `src/users/entities/user.entity.ts` — os dois lados da relação ficam declarados.
3. Criar `src/videos/public-id.util.ts` — `generatePublicId()` retorna 11 caracteres base64url derivados de `crypto.randomBytes(8)` (per `phase-03-upload-processing/TD-06`).
4. Criar `src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])`, registrar `VideosModule` em `AppModule` e incluir `Video` onde as entidades são declaradas (`TypeOrmModule.forRootAsync` e `src/database/data-source.ts`).
5. Gerar a migration `CreateVideosTable` com `docker compose exec nestjs-api npm run migration:generate` no diretório de migrations configurado em `src/database/data-source.ts` e aplicá-la com `docker compose exec nestjs-api npm run migration:run` (convenção herdada de `phase-01-configuracao-base/TD-04`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: `public_id` duplicado viola a constraint única; defaults `publication_status = 'draft'` e `processing_status = 'uploading'`; `upload_id` ausente em queries padrão (`select: false`); `user_id` obrigatório | `src/videos/entities/video.entity.integration-spec.ts` |
| `generatePublicId` | Unit: 11 caracteres no alfabeto base64url (`[A-Za-z0-9_-]`), sem repetição em 1000 chamadas | `src/videos/public-id.util.spec.ts` |
| `VideosModule` | Unit: compilation test | `src/videos/videos.module.spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `npm run migration:run` cria a tabela `videos` com índice único em `public_id`, índices em `user_id`, `(processing_status, created_at)` e `failed_at`, e FK `user_id → users.id`.
- Inserir dois vídeos com o mesmo `public_id` falha com violação de unicidade.
- Um vídeo salvo apenas com os campos obrigatórios fica com `publication_status = 'draft'` e `processing_status = 'uploading'`.
- Buscar um vídeo sem `select` explícito não retorna `upload_id`.
- `npm run migration:revert` remove a tabela `videos` sem alterar `users` e `channels`.

---

### SI-03.4 — Infra: módulo de filas BullMQ

**Description:** Registrar BullMQ sobre Redis via `@nestjs/bullmq` com as filas `video-processing` e `video-maintenance` e as opções padrão de retry — infraestrutura compartilhada entre o produtor (API) e os consumidores (worker).

**Technical actions:**

1. Instalar `@nestjs/bullmq` em `^12.0.0` e `bullmq` em `^6.3.6` — os peer dependencies do `@nestjs/bullmq@12` aceitam `@nestjs/common`/`@nestjs/core` `^11` e `bullmq` `^6`, compatíveis com o NestJS 11 do projeto (per `phase-03-upload-processing/TD-07`).
2. Criar `src/config/queue.config.ts` (`registerAs('queue', …)`) com `redisHost` e `redisPort`, e adicionar `REDIS_HOST` e `REDIS_PORT` ao schema Joi em `src/config/env.validation.ts` (convenção herdada de `phase-01-configuracao-base/TD-02`, `TD-03`).
3. Criar `src/queue/queue.constants.ts` com `QUEUES = { VIDEO_PROCESSING: 'video-processing', VIDEO_MAINTENANCE: 'video-maintenance' } as const` e `JOBS = { PROCESS_VIDEO: 'process-video', PURGE_STALE_UPLOADS: 'purge-stale-uploads' } as const` (nomes de `### Events/Messages`).
4. Criar `src/queue/queue.module.ts` com `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory: (config: ConfigType<typeof queueConfig>) => ({ connection: { host: config.redisHost, port: config.redisPort } }) })` e `BullModule.registerQueue` das duas filas; `video-processing` com `defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 30_000 } }` (per `phase-03-upload-processing/TD-07` revisão).
5. Exportar `BullModule` a partir de `QueueModule` e importar `QueueModule` em `VideosModule` — o módulo registra filas, mas nenhuma classe `@Processor`, para que o processo da API nunca consuma jobs (per `phase-03-upload-processing/TD-08`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `QueueModule` | Integration: compila contra o Redis real e expõe as filas `video-processing` e `video-maintenance` via `getQueueToken` | `src/queue/queue.module.integration-spec.ts` |
| `env.validation` | Integration: boot falha quando `REDIS_HOST` está ausente | `src/config/env.validation.integration-spec.ts` (existente, estendido) |

**Dependencies:** SI-03.1 — Redis precisa estar ativo; SI-03.3 — `VideosModule` precisa existir.

**Acceptance criteria:**

- Com o Redis ativo, a aplicação inicia e `getJobCounts()` da fila `video-processing` responde sem erro.
- Um job adicionado à fila `video-processing` sem opções explícitas herda `attempts: 3` e backoff `exponential` com `delay: 30000`.
- Iniciar a aplicação sem `REDIS_HOST` falha na validação de ambiente com mensagem citando a chave.
- Com a API iniciada e um job em `video-processing`, o job continua em `waiting` enquanto nenhum worker está ativo.

---

### SI-03.5 — Endpoint POST /videos (pré-cadastro e início do upload)

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-upload-initiate.plan.md`
**Authorization:** Authenticated (guard global `JwtAuthGuard`)

**Description:** Expor o endpoint que valida o arquivo declarado, pré-cadastra o vídeo como rascunho e abre o multipart upload no storage — início de todo upload e origem do `public_id`.

**Technical actions:**

1. Criar `src/videos/videos.constants.ts` com `MAX_UPLOAD_BYTES = 10737418240`, `PART_SIZE_BYTES = 67108864` e `ACCEPTED_CONTENT_TYPES = ['video/mp4', 'video/quicktime'] as const` (per `phase-03-upload-processing/TD-03` revisão, `TD-10`), `src/videos/dto/create-video-upload.dto.ts` (`filename`, `size_bytes`, `content_type`, validados com class-validator per `phase-02-auth/TD-06`) e o DTO de resposta com os campos de `### API Contracts → POST /videos`.
2. Adicionar `VideoUploadTooLargeException` (`UPLOAD_TOO_LARGE`, 413) e `UnsupportedVideoContentTypeException` (`UNSUPPORTED_MEDIA_TYPE`, 415) em `src/common/exceptions/domain.exception.ts` (per `### Error Catalog`).
3. Criar `VideosService.initiateUpload(userId, dto)` em `src/videos/videos.service.ts`: rejeita tamanho acima de `MAX_UPLOAD_BYTES` e tipo fora de `ACCEPTED_CONTENT_TYPES`, gera o `public_id` (nova tentativa em violação de unicidade), abre o multipart com `CreateMultipartUploadCommand({ Bucket, Key: 'videos/{public_id}/original', ContentType })` pelo cliente interno e persiste o `Video` com o `UploadId` retornado em `upload_id`, `source_object_key` e `processing_status = 'uploading'`; se o save falhar, executa `AbortMultipartUploadCommand` com o mesmo `UploadId` (per `phase-03-upload-processing/TD-03`, `TD-05`, `TD-06`).
4. Criar `src/videos/videos.controller.ts` com `@Controller('videos')` e `@SkipThrottle()` na classe (rate limiting segue restrito à autenticação, per `phase-02-auth/TD-08`), e `@Post()` retornando `201` com o shape de `### API Contracts → POST /videos`, usando `@CurrentUser()` (`user.sub` como owner) e `@ApiOperation` / `@ApiBody` / `@ApiResponse` para 201, 400, 401, 413 e 415 com o envelope de `src/common/openapi/api-error-envelope.dto.ts` (per `openapi-docs-nestjs/TD-01` revisão).
5. Importar `StorageModule` e registrar `VideosService` e `VideosController` em `VideosModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: `UPLOAD_TOO_LARGE` acima do limite; `UNSUPPORTED_MEDIA_TYPE` fora da allowlist; cálculo de `part_count`; nova tentativa de `public_id` em colisão; `AbortMultipartUploadCommand` com o `UploadId` quando o save falha (storage e repositório mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration: cria a linha em `videos` e o multipart upload real no Garage com `source_object_key = videos/{public_id}/original`; o `upload_id` gravado é aceito por `ListPartsCommand` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2 — `StorageService` para abrir o multipart; SI-03.3 — entidade `Video` e `generatePublicId`.

**Acceptance criteria:**

- `POST /videos` autenticado com `{ "filename": "clip.mp4", "size_bytes": 104857600, "content_type": "video/mp4" }` retorna `201` com `public_id` de 11 caracteres, `processing_status: "uploading"`, `part_size_bytes: 67108864` e `part_count: 2`.
- O vídeo criado tem `publication_status = 'draft'`, `user_id` igual ao do chamador e `upload_id` preenchido.
- `POST /videos` com `size_bytes: 10737418241` retorna `413` com `error: "UPLOAD_TOO_LARGE"` e não abre multipart upload no storage.
- `POST /videos` com `content_type: "video/x-matroska"` retorna `415` com `error: "UNSUPPORTED_MEDIA_TYPE"`.
- `POST /videos` sem `filename` retorna `400` com `error: "VALIDATION_ERROR"`.
- `POST /videos` sem access token retorna `401`.
- 11 requisições `POST /videos` do mesmo cliente em menos de 60 s não recebem `429`.

---

### SI-03.6 — Endpoints de partes do upload (assinar e listar)

**Route:** POST /videos/:public_id/upload-parts · GET /videos/:public_id/upload-parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner (non-owner recebe `404 VIDEO_NOT_FOUND`)

**Description:** Expor a assinatura de URLs de partes e a listagem das partes já armazenadas — o que permite ao browser enviar bytes direto ao storage e retomar um upload interrompido.

**Technical actions:**

1. Criar `src/videos/dto/sign-upload-parts.dto.ts` (`part_numbers`: array de inteiros únicos, 1+ entradas, per `phase-02-auth/TD-06`) e os DTOs de resposta de `### API Contracts → POST|GET /videos/:public_id/upload-parts`.
2. Adicionar `VideoNotFoundException` (`VIDEO_NOT_FOUND`, 404), `InvalidPartNumberException` (`INVALID_PART_NUMBER`, 400) e `UploadNotInProgressException` (`UPLOAD_NOT_IN_PROGRESS`, 409) em `src/common/exceptions/domain.exception.ts`.
3. Criar `VideosService.findOwnedByPublicId(userId, publicId, options)` — busca por `public_id` (selecionando `upload_id` explicitamente quando pedido) e lança `VIDEO_NOT_FOUND` tanto para vídeo inexistente quanto para outro owner (per `phase-03-upload-processing/TD-12` revisão).
4. Criar `VideosService.signUploadParts(userId, publicId, partNumbers)` — exige `processing_status = 'uploading'`, recalcula `part_count` a partir de `size_bytes` e `PART_SIZE_BYTES`, valida o intervalo e assina cada parte com `getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 })`, retornando `expires_at` (per `phase-03-upload-processing/TD-02`, `TD-03` revisão) — e `VideosService.listUploadedParts(userId, publicId)` via `ListPartsCommand({ Bucket, Key, UploadId })` no cliente interno, mapeando `Parts[]` (`PartNumber`, `ETag`, `Size`) para `part_number`, `etag` e `size_bytes` (per `phase-03-upload-processing/TD-04`).
5. Adicionar ao `VideosController` `@Post(':public_id/upload-parts')` com `@HttpCode(200)` e `@Get(':public_id/upload-parts')`, com `@ApiOperation` / `@ApiParam` / `@ApiBody` / `@ApiResponse` para 200, 400, 401, 404 e 409 (per `openapi-docs-nestjs/TD-01` revisão).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findOwnedByPublicId` / `signUploadParts` / `listUploadedParts` | Unit: `VIDEO_NOT_FOUND` para outro owner e para `public_id` inexistente; `UPLOAD_NOT_IN_PROGRESS` fora de `uploading`; `INVALID_PART_NUMBER` fora de `1..part_count`; `expiresIn: 3600` repassado ao presign; mapeamento de `Parts[]` para snake_case (storage e repositório mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.signUploadParts` + `listUploadedParts` | Integration: assina a parte 1, faz `PUT` real no Garage pelo endpoint público e a listagem retorna `part_number`, `etag` e `size_bytes` dessa parte | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5 — vídeo em `uploading` com `upload_id` e `VideosController` existentes.

**Acceptance criteria:**

- `POST /videos/:public_id/upload-parts` do owner com `{ "part_numbers": [1, 2] }` retorna `200` com duas entradas em `parts`, cada `url` apontando para o host de `STORAGE_PUBLIC_ENDPOINT` e `expires_at` uma hora após a emissão.
- Um `PUT` de 64 MiB na `url` da parte 1 é aceito pelo storage, e em seguida `GET /videos/:public_id/upload-parts` retorna `part_number: 1` com `etag` e `size_bytes: 67108864`.
- `POST /videos/:public_id/upload-parts` com `{ "part_numbers": [3] }` para um vídeo com `part_count: 2` retorna `400` com `error: "INVALID_PART_NUMBER"`.
- Os dois endpoints chamados por outro usuário autenticado retornam `404` com `error: "VIDEO_NOT_FOUND"`, com o mesmo corpo de um `public_id` inexistente.
- Os dois endpoints para um vídeo em `processing` retornam `409` com `error: "UPLOAD_NOT_IN_PROGRESS"`.

---

### SI-03.7 — Endpoint de conclusão do upload e enfileiramento do processamento

**Route:** POST /videos/:public_id/upload-completion
**Test Specs:** see `nestjs-project/specs/videos-upload-completion.plan.md`
**Authorization:** Owner (non-owner recebe `404 VIDEO_NOT_FOUND`)

**Description:** Expor o sinal de conclusão do upload, que fecha o multipart no storage, valida o objeto final, move o vídeo para `processing` e enfileira o processamento — a ponte entre upload e worker.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` (`parts`: array de `{ part_number: integer, etag: string não vazia }`, per `phase-02-auth/TD-06`) e o DTO de resposta de `### API Contracts → POST /videos/:public_id/upload-completion`.
2. Adicionar `UploadIncompleteException` (`UPLOAD_INCOMPLETE`, 422) em `src/common/exceptions/domain.exception.ts`.
3. Criar `VideosService.completeUpload(userId, publicId, parts)`: exige `processing_status = 'uploading'`; exige que `parts` seja exatamente `1..part_count` em ordem crescente; conclui com `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }] } })` pelo cliente interno (erro do storage → `UPLOAD_INCOMPLETE`); confere com `HeadObjectCommand({ Bucket, Key })` que `ContentLength` é igual a `size_bytes` — a URL assinada de parte não limita o tamanho total, então esta é a garantia de tamanho no servidor (divergência → `DeleteObjectCommand` e `UPLOAD_INCOMPLETE`); em uma transação grava `upload_completed_at`, zera `upload_id` e muda `processing_status` para `'processing'` (per `phase-03-upload-processing/TD-03`, `TD-05`).
4. Após o commit, adicionar à fila `video-processing` (`@InjectQueue(QUEUES.VIDEO_PROCESSING)`) com `queue.add(JOBS.PROCESS_VIDEO, { videoId }, { jobId: videoId })` — um `add` com `jobId` já existente é ignorado, o que torna o enqueue idempotente; tentativas e backoff vêm do `defaultJobOptions` da fila (per `phase-03-upload-processing/TD-07`).
5. Adicionar ao `VideosController` `@Post(':public_id/upload-completion')` com `@HttpCode(202)` e `@ApiOperation` / `@ApiParam` / `@ApiBody` / `@ApiResponse` para 202, 400, 401, 404, 409 e 422 (per `openapi-docs-nestjs/TD-01` revisão).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: `UPLOAD_INCOMPLETE` para lista incompleta, fora de ordem, rejeitada pelo storage e com `ContentLength` divergente (`DeleteObjectCommand` executado); `UPLOAD_NOT_IN_PROGRESS` fora de `uploading`; `queue.add` só após a transição, com `jobId` igual ao `id` do vídeo (storage, repositório e fila mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration: multipart real no Garage concluído → linha em `processing` com `upload_completed_at`, objeto original com o tamanho declarado e job `process-video` no Redis com id igual ao do vídeo; segundo `add` com o mesmo `jobId` não cria job duplicado | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.4 — fila `video-processing` registrada; SI-03.6 — `findOwnedByPublicId`, partes assinadas e exceções de estado.

**Acceptance criteria:**

- `POST /videos/:public_id/upload-completion` do owner com todas as partes em ordem crescente e seus `etag` retorna `202` com `{ "public_id": "…", "processing_status": "processing" }`.
- Após o `202`, o vídeo tem `processing_status = 'processing'`, `upload_completed_at` preenchido e `upload_id` nulo, e `videos/{public_id}/original` existe no storage com tamanho igual a `size_bytes`.
- Após o `202`, a fila `video-processing` contém um job `process-video` cujo id é o `id` do vídeo e cujo payload é `{ "videoId": "<id>" }`.
- `POST /videos/:public_id/upload-completion` sem a parte 2 de um vídeo com `part_count: 2` retorna `422` com `error: "UPLOAD_INCOMPLETE"`, e o vídeo continua em `uploading`.
- Repetir a conclusão de um upload já concluído retorna `409` com `error: "UPLOAD_NOT_IN_PROGRESS"` e não cria um segundo job.
- A chamada por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`.

---

### SI-03.8 — Endpoint GET /videos/:public_id (status e metadados)

**Route:** GET /videos/:public_id
**Test Specs:** see `nestjs-project/specs/videos-detail.plan.md`
**Authorization:** Owner (non-owner recebe `404 VIDEO_NOT_FOUND`)

**Description:** Expor ao owner o estado de processamento e os metadados extraídos do vídeo — é por aqui que o cliente acompanha `uploading → processing → ready | failed` depois do `202` de conclusão.

**Technical actions:**

1. Criar `src/videos/dto/video-response.dto.ts` com exatamente os campos de `### API Contracts → GET /videos/:public_id` — sem `id`, `user_id`, `upload_id` nem object keys, já que o UUID é só identificador interno (per `phase-03-upload-processing/TD-06`).
2. Criar `VideosService.getOwnedVideo(userId, publicId)` reutilizando `findOwnedByPublicId` e mapeando a entidade para o DTO (`duration_seconds` numérico convertido para `number`) (per `phase-03-upload-processing/TD-05`, `TD-12` revisão).
3. Adicionar ao `VideosController` `@Get(':public_id')` com `@ApiOperation` / `@ApiParam` / `@ApiResponse` para 200, 401 e 404 (per `openapi-docs-nestjs/TD-01` revisão).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getOwnedVideo` | Unit: mapeamento completo para o DTO, `duration_seconds` como `number`, omissão de `id`, `user_id`, `upload_id` e object keys; `VIDEO_NOT_FOUND` para outro owner (repositório mockado) | `src/videos/videos.service.spec.ts` |

**Dependencies:** SI-03.6 — `findOwnedByPublicId` e `VideoNotFoundException`.

**Acceptance criteria:**

- `GET /videos/:public_id` do owner para um vídeo recém-criado retorna `200` com `processing_status: "uploading"`, `publication_status: "draft"`, `failure_code: null` e `duration_seconds: null`.
- `GET /videos/:public_id` para um vídeo em `ready` retorna `duration_seconds`, `width`, `height`, `video_codec` e `processed_at` preenchidos.
- `GET /videos/:public_id` para um vídeo em `failed` retorna o `failure_code` gravado pelo worker.
- O corpo da resposta não contém `id`, `user_id`, `upload_id`, `source_object_key`, `video_object_key` nem `thumbnail_object_key`.
- A chamada por outro usuário autenticado retorna `404` com `error: "VIDEO_NOT_FOUND"`, e sem access token retorna `401`.

---

### SI-03.9 — Worker: entrypoint e processamento do vídeo

**Description:** Criar o segundo entrypoint do mesmo codebase e o processor da fila `video-processing`, que extrai metadados, valida codecs, remuxa para MP4 faststart e gera a thumbnail — a capability de processamento automático após o upload.

**Technical actions:**

1. Criar `src/worker.ts` (`NestFactory.createApplicationContext(WorkerModule)`, sem servidor HTTP) e `src/worker.module.ts` importando configuração, TypeORM, `StorageModule`, `QueueModule`, o repositório de `Video` e os processors — as classes `@Processor` são registradas só aqui; adicionar os scripts `start:worker` e `start:worker:dev` ao `package.json` (per `phase-03-upload-processing/TD-08`).
2. Criar `src/videos/processing/ffmpeg.service.ts` — wrapper sobre `spawn` com `probe(file)` (ffprobe em JSON), `remuxFaststart(input, output)` (`-c copy -movflags +faststart`) e `extractThumbnail(input, output, seconds)` (`-frames:v 1 -vf scale=1280:-2`); exit code diferente de zero vira erro tipado com o stderr. Por rodar em processo filho, o event loop do worker fica livre e o lock do job continua sendo renovado durante um remux longo (per `phase-03-upload-processing/TD-09`, `TD-11`).
3. Criar `src/videos/processing/media-policy.ts` — `assertSupportedMedia(probe)` lança `UnrecoverableError` de `bullmq` com `INVALID_MEDIA` quando não há stream de vídeo legível e com `UNSUPPORTED_CODEC` quando o vídeo não é `h264` ou o áudio existe e não é `aac` — o job vai direto para `failed`, ignorando as tentativas restantes; `thumbnailTimestamp(duration)` retorna `min(0.10 × duration, max(duration − 0.1, 0))` (per `phase-03-upload-processing/TD-10`, `TD-09` revisão).
4. Criar `src/videos/processing/video-processing.processor.ts` — `@Processor(QUEUES.VIDEO_PROCESSING)` estendendo `WorkerHost`, com `async process(job)` executando os passos 1–5 de `### Events/Messages → process-video`: ignora vídeos fora de `processing`; baixa o original com `GetObjectCommand` para um diretório temporário; aplica a política; remuxa; gera a thumbnail; envia `video.mp4` e `thumbnail.jpg` com `PutObjectCommand`; grava keys, metadados, `processing_status = 'ready'` e `processed_at`; apaga o original com `DeleteObjectCommand`; limpa o diretório temporário em `finally`.
5. No mesmo processor, `@OnWorkerEvent('failed')` trata a falha definitiva — erro `UnrecoverableError` ou `job.attemptsMade >= job.opts.attempts` — gravando `processing_status = 'failed'`, `failure_code` (`UNSUPPORTED_CODEC`, `INVALID_MEDIA` ou `PROCESSING_FAILED`) e `failed_at`, mantendo o original; o evento `stalled` é registrado em log (per `phase-03-upload-processing/TD-05` revisão, `TD-07` revisão).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `media-policy` | Unit: `UnrecoverableError` com `INVALID_MEDIA` sem stream de vídeo; `UnrecoverableError` com `UNSUPPORTED_CODEC` para `vp9` e para áudio `opus`; aceita `h264`+`aac` e `h264` sem áudio; `thumbnailTimestamp` com clamp para durações curtas | `src/videos/processing/media-policy.spec.ts` |
| `FfmpegService` | Integration: FFmpeg real sobre fixture gerada no setup (`ffmpeg -f lavfi` com `h264`/`aac`) — campos do probe, saída remuxada com `moov` antes de `mdat`, thumbnail JPEG com 1280 px de largura | `src/videos/processing/ffmpeg.service.integration-spec.ts` |
| `VideoProcessingProcessor` | Integration: DB + Garage + Redis reais — fluxo até `ready` (keys, metadados, original apagado); codec não suportado vai a `failed` com `UNSUPPORTED_CODEC` em uma única tentativa; falha genérica recuperável só vira `PROCESSING_FAILED` após a 3ª tentativa; job de vídeo já `ready` não altera a linha | `src/videos/processing/video-processing.processor.integration-spec.ts` |
| `WorkerModule` | Integration: compila contra Redis, Postgres e Garage reais e registra o processor | `src/worker.module.integration-spec.ts` |

**Dependencies:** SI-03.1 — FFmpeg na imagem e serviço `video-worker`; SI-03.2 — `StorageService`; SI-03.3 — entidade `Video`; SI-03.4 — fila `video-processing` e constantes.

**Acceptance criteria:**

- `docker compose exec video-worker npm run start:worker:dev` inicia o worker sem abrir porta HTTP e consome a fila `video-processing`.
- Depois de `POST /videos/:public_id/upload-completion` de um MP4 `h264`/`aac`, o vídeo chega a `ready` com `duration_seconds`, `width`, `height`, `video_codec: "h264"`, `audio_codec: "aac"` e `processed_at` preenchidos.
- Depois do processamento, `videos/{public_id}/video.mp4` e `videos/{public_id}/thumbnail.jpg` existem no storage e `videos/{public_id}/original` não existe mais.
- O `video.mp4` gerado tem o átomo `moov` antes de `mdat`, e o `thumbnail.jpg` tem 1280 px de largura.
- Um upload com vídeo `vp9` termina em `failed` com `failure_code = 'UNSUPPORTED_CODEC'` e `failed_at` preenchido após uma única tentativa (`attemptsMade: 1`), mantendo o original.
- Um job repetido para um vídeo já em `ready` termina sem alterar a linha nem os objetos.

---

### SI-03.10 — Endpoints de URL de reprodução e download

**Route:** GET /videos/:public_id/playback-url · GET /videos/:public_id/download-url
**Test Specs:** see `nestjs-project/specs/videos-media-urls.plan.md`
**Authorization:** Owner (non-owner recebe `404 VIDEO_NOT_FOUND`)

**Description:** Emitir URLs assinadas de curta duração para reprodução progressiva e download do vídeo processado — as capabilities de streaming e download, sem que bytes de mídia passem pelos servidores Node.

**Technical actions:**

1. Adicionar a `src/videos/videos.constants.ts` `PLAYBACK_URL_TTL_SECONDS = 21600` e `DOWNLOAD_URL_TTL_SECONDS = 900` (per `phase-03-upload-processing/TD-12` revisão) e criar `src/videos/dto/media-url-response.dto.ts` com `url` e `expires_at`.
2. Adicionar `VideoNotReadyException` (`VIDEO_NOT_READY`, 409) em `src/common/exceptions/domain.exception.ts`.
3. Criar `VideosService.getPlaybackUrl(userId, publicId)` — reutiliza `findOwnedByPublicId`, exige `processing_status = 'ready'` e emite `getSignedUrl(publicClient, new GetObjectCommand({ Bucket, Key: video_object_key }), { expiresIn: PLAYBACK_URL_TTL_SECONDS })`; o storage atende a URL com suporte a `Range`, o que dá a reprodução progressiva (per `phase-03-upload-processing/TD-11`, `TD-12`).
4. Criar `VideosService.getDownloadUrl(userId, publicId)` — mesmas regras, `expiresIn: DOWNLOAD_URL_TTL_SECONDS` e `ResponseContentDisposition: 'attachment; filename="<original_filename sem extensão>.mp4"'` no `GetObjectCommand`, com o nome sanitizado (aspas e caracteres de controle removidos); o storage devolve esse valor como header `Content-Disposition` (per `phase-03-upload-processing/TD-12` revisão).
5. Adicionar ao `VideosController` `@Get(':public_id/playback-url')` e `@Get(':public_id/download-url')` com `@ApiOperation` / `@ApiParam` / `@ApiResponse` para 200, 401, 404 e 409 (per `openapi-docs-nestjs/TD-01` revisão).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPlaybackUrl` / `getDownloadUrl` | Unit: `VIDEO_NOT_READY` para `uploading`, `processing` e `failed`; `expiresIn` de 21600 e 900 repassados ao presign; `ResponseContentDisposition` com o filename sanitizado; `VIDEO_NOT_FOUND` para outro owner (storage e repositório mockados) | `src/videos/videos.service.spec.ts` |
| `VideosService.getPlaybackUrl` / `getDownloadUrl` | Integration: vídeo `ready` no Garage — `GET` na URL de reprodução com `Range: bytes=0-1023` retorna `206` com 1024 bytes; a URL de download responde com `Content-Disposition: attachment` | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.8 — `findOwnedByPublicId` e padrão de rotas do owner; SI-03.9 — vídeos `ready` com `video_object_key`.

**Acceptance criteria:**

- `GET /videos/:public_id/playback-url` do owner para um vídeo `ready` retorna `200` com `url` no host de `STORAGE_PUBLIC_ENDPOINT`, `X-Amz-Expires=21600` na query string e `expires_at` seis horas após a emissão.
- Um `GET` na `url` de reprodução com `Range: bytes=0-1023` retorna `206 Partial Content` com 1024 bytes.
- `GET /videos/:public_id/download-url` retorna `200` com `expires_at` 15 minutos após a emissão, e um `GET` nessa `url` para um vídeo enviado como `clip.mov` responde com `Content-Disposition: attachment; filename="clip.mp4"`.
- Os dois endpoints para um vídeo em `processing` retornam `409` com `error: "VIDEO_NOT_READY"`.
- Os dois endpoints chamados por outro usuário autenticado retornam `404` com `error: "VIDEO_NOT_FOUND"`.

---

### SI-03.11 — Job de manutenção: expurgo de uploads abandonados e de originais com falha

**Description:** Criar o job agendado da fila `video-maintenance` que remove rascunhos presos em `uploading` e apaga originais de vídeos com falha após o período de retenção — impede acúmulo de lixo no banco e no storage.

**Technical actions:**

1. Adicionar a `src/videos/videos.constants.ts` `STALE_UPLOAD_MAX_AGE_HOURS = 24` e `FAILED_ORIGINAL_RETENTION_DAYS = 7`, e criar `src/videos/processing/video-maintenance.service.ts` com `purgeStaleUploads(now)` — vídeos em `uploading` com `created_at` anterior a 24 h têm o multipart abortado com `AbortMultipartUploadCommand` (quando `upload_id` existe; upload já inexistente é ignorado) e a linha removida (per `phase-03-upload-processing/TD-05` revisão).
2. Adicionar `deleteExpiredFailedOriginals(now)` ao mesmo service — vídeos em `failed` com `failed_at` anterior a 7 dias têm `source_object_key` apagado com `DeleteObjectCommand` (objeto já inexistente é ignorado), mantendo a linha e o `failure_code` (per `phase-03-upload-processing/TD-05` revisão).
3. Criar `src/videos/processing/video-maintenance.processor.ts` — `@Processor(QUEUES.VIDEO_MAINTENANCE)` estendendo `WorkerHost`, cujo `process(job)` executa as duas rotinas no job `purge-stale-uploads` (per `### Events/Messages → purge-stale-uploads`).
4. No bootstrap do worker, registrar a agenda com `queue.upsertJobScheduler('purge-stale-uploads', { pattern: '0 0 * * * *' }, { name: JOBS.PURGE_STALE_UPLOADS, data: {} })` na fila `video-maintenance` — o upsert é chaveado pelo id do scheduler, então reinícios atualizam a mesma agenda em vez de duplicá-la; substitui a API legada de jobs repetíveis do BullMQ v6 (per `phase-03-upload-processing/TD-07`).
5. Registrar `VideoMaintenanceService` e `VideoMaintenanceProcessor` em `WorkerModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoMaintenanceService` | Integration: DB + Garage reais — rascunho `uploading` de 25 h tem o multipart abortado e a linha removida, o de 23 h permanece; `failed` com `failed_at` de 8 dias perde o original e mantém a linha, o de 6 dias fica intacto; vídeos `ready` não são tocados; segunda execução seguida não gera erro | `src/videos/processing/video-maintenance.service.integration-spec.ts` |
| `WorkerModule` (agenda) | Integration: após dois bootstraps seguidos, `getJobSchedulers()` da fila `video-maintenance` retorna exatamente um scheduler `purge-stale-uploads` com o padrão horário | `src/worker.module.integration-spec.ts` (estendido) |

**Dependencies:** SI-03.9 — `WorkerModule` e entrypoint do worker.

**Acceptance criteria:**

- Um vídeo em `uploading` criado há mais de 24 h deixa de existir em `videos` após a execução do job, e seu multipart upload não aparece mais no storage.
- Um vídeo em `uploading` criado há menos de 24 h continua existindo após a execução do job.
- Um vídeo em `failed` com `failed_at` há mais de 7 dias fica sem o objeto `videos/{public_id}/original`, mas a linha continua com `processing_status = 'failed'` e o mesmo `failure_code`.
- Vídeos em `ready` e vídeos em `failed` há menos de 7 dias não são alterados pelo job.
- Reiniciar o worker mantém um único scheduler `purge-stale-uploads` na fila `video-maintenance`.

---

### SI-03.12 — Regenerar o artefato OpenAPI com os endpoints de vídeos

**Description:** Fechar a documentação dos endpoints de vídeos e regenerar o `openapi.json` exportado — a fonte de contrato que o `next-frontend` consome.

**Technical actions:**

1. Adicionar `@ApiTags('videos')` e `@ApiBearerAuth()` na classe `VideosController`, completando os decoradores por endpoint adicionados em SI-03.5 a SI-03.10 (per `openapi-docs-nestjs/TD-01` revisão).
2. Rodar `docker compose exec nestjs-api npm run openapi:export` (`src/openapi-export.ts`) e commitar o `openapi.json` regenerado (per `openapi-docs-nestjs/TD-02`).
3. Conferir no artefato que os schemas de request/response dos 7 endpoints usam os nomes de campo de `### API Contracts` e que cada operação documenta os status de erro com o envelope `{ statusCode, error, message }` (per `phase-02-auth/TD-07`).

**Tests:** _(empty — artefato gerado; o contrato é verificado pela sincronização e pelo `tsc` do next-frontend em SI-03.13)_

**Dependencies:** SI-03.5, SI-03.6, SI-03.7, SI-03.8, SI-03.10 — todos os endpoints de vídeos precisam existir.

**Acceptance criteria:**

- O `openapi.json` exportado contém `/videos` (post), `/videos/{public_id}` (get), `/videos/{public_id}/upload-parts` (get e post), `/videos/{public_id}/upload-completion` (post), `/videos/{public_id}/playback-url` (get) e `/videos/{public_id}/download-url` (get).
- Cada uma dessas operações declara os status de erro listados em `### API Contracts` com o schema do envelope de erro.
- Os schemas de request e response usam os nomes de campo snake_case de `### API Contracts` (por exemplo `size_bytes`, `part_numbers`, `processing_status`, `expires_at`).
- Rodar `npm run openapi:export` duas vezes seguidas sem mudança de código não gera diff no artefato.

---

### SI-03.13 — Sincronizar o contrato de vídeos no next-frontend

**Description:** Trazer o `openapi.json` regenerado para o `next-frontend`, regenerar os tipos, expor os aliases de vídeos e criar fixtures e handlers MSW tipados — base de contrato para as rotas BFF e o uploader.

**Technical actions:**

1. Rodar `bash scripts/sync-openapi.sh` na raiz do repositório (host) para atualizar `next-frontend/openapi.json` (per `next-frontend-openapi-typing/TD-02`).
2. Rodar `docker compose exec next-frontend npm run openapi:types` para regenerar `lib/api/types.gen.ts` e commitar `openapi.json` e `types.gen.ts` juntos (per `next-frontend-openapi-typing/TD-01`, `TD-03`).
3. Acrescentar a `lib/api/contracts.ts`, sob um cabeçalho de seção `videos`, aliases pass-through sobre `paths` para os 7 endpoints: `CreateVideoUploadDto`, `VideoUpload`, `SignUploadPartsDto`, `SignedUploadParts`, `UploadedParts`, `CompleteUploadDto`, `UploadCompletion`, `Video` e `MediaUrl` (per `next-frontend-openapi-typing/TD-04`).
4. Criar `mocks/factories/videos.ts` com builders determinísticos `buildVideoUpload`, `buildSignedUploadParts`, `buildUploadedParts`, `buildUploadCompletion`, `buildVideo` e `buildMediaUrl`.
5. Criar `mocks/handlers/videos.ts` com um handler por `(method, path)` dos 7 endpoints upstream em `${env.API_URL}/videos…`, corpos tipados via `paths`, e acrescentar o spread de `videos` em `mocks/handlers/index.ts` (per `next-frontend-openapi-typing/TD-05`).

**Tests:** _(empty — contrato e fixtures; gated por `tsc --noEmit` e pelo CI de freshness; comportamento testado em SI-03.21 a SI-03.23)_

**Dependencies:** SI-03.12 — `openapi.json` do backend com os endpoints de vídeos.

**Acceptance criteria:**

- `next-frontend/openapi.json` e `lib/api/types.gen.ts` contêm os 7 paths de vídeos, e rerodar a sincronização e a geração de tipos não produz diff.
- `lib/api/contracts.ts` exporta os 9 aliases de vídeos listados, e nenhum arquivo fora de `lib/api/contracts.ts` e `mocks/` importa `paths`.
- `mocks/handlers/index.ts` inclui os handlers de vídeos, e a suíte Vitest existente continua passando.
- `docker compose exec next-frontend npx tsc --noEmit` termina com exit code `0`.

---

### SI-03.14 — Formatos aceitos e limite de tamanho no cliente (Setup)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-upload-processing/TD-10 — Accepted Input Formats & Normalization Policy`

**Technical actions:**

1. Criar `next-frontend/lib/upload/constants.ts` com o snippet de Setup byte a byte (`ACCEPTED_CONTENT_TYPES` e `MAX_UPLOAD_BYTES = 10737418240`) (per `phase-03-upload-processing/TD-10`, `TD-03` revisão).
2. Criar `next-frontend/lib/upload/validate-upload-file.ts` — `validateUploadFile(file)` retorna um resultado tipado (`ok`, `unsupported_type` ou `too_large`) sem nenhuma chamada de rede, para que o uploader falhe cedo antes de `POST /api/videos` (per `phase-03-upload-processing/TD-10`).

**Dependencies:** —

**Tests:** _(empty — Setup SI; smoke-gated by AC; behavior tests live in Migration + Verification SIs)_

**Acceptance criteria:**

- `lib/upload/constants.ts` contém `ACCEPTED_CONTENT_TYPES = ["video/mp4", "video/quicktime"] as const` e `MAX_UPLOAD_BYTES = 10737418240`, idênticos ao spec.
- `validateUploadFile` retorna `unsupported_type` para um arquivo `video/x-matroska` e `too_large` para um arquivo de 10737418241 bytes, sem executar `fetch`.
- `docker compose exec next-frontend npx tsc --noEmit` termina com exit code `0`.

---

### SI-03.15 — Identificador público nas rotas BFF de vídeos (Setup)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-upload-processing/TD-06 — Unique Public Video ID (URL identifier)`

**Technical actions:**

1. Criar `next-frontend/lib/api/videos-proxy.ts` com o shape comum das rotas BFF de vídeos: lê a sessão com `getSession()` (`lib/auth/session.ts`); sem sessão retorna `401` sem chamar o upstream; com sessão executa a chamada `upstream` com `Authorization: Bearer ${session.accessToken}` dentro de `withRefresh` (`lib/auth/refresh.ts`) e devolve status e corpo do upstream sem reshape, com erros tipados como `ApiErrorEnvelope` (per `phase-02-auth-frontend/TD-01`, `TD-03`, `TD-05`, `next-frontend-openapi-typing/TD-01`).
2. Criar `next-frontend/app/api/videos/route.ts` (`POST`) encaminhando para `POST /videos` pelo helper, com o corpo tipado por `CreateVideoUploadDto` de `@/lib/api/contracts` (per `next-frontend-openapi-typing/TD-04`).
3. Criar `next-frontend/app/api/videos/[publicId]/route.ts` (`GET`) encaminhando para `GET /videos/{public_id}` com o segmento `publicId` repassado sem alteração, conforme o snippet de Setup (per `phase-03-upload-processing/TD-06`).

**Dependencies:** SI-03.13 — tipos regenerados, aliases de `contracts.ts` e handlers MSW de vídeos.

**Tests:** _(empty — Setup SI; smoke-gated by AC; behavior tests live in Migration + Verification SIs)_

**Acceptance criteria:**

- `POST /api/videos` sem sessão retorna `401` e nenhuma requisição chega ao upstream.
- `POST /api/videos` com sessão encaminha `POST /videos` com `Authorization: Bearer <accessToken>` e devolve o `201` do upstream com o corpo inalterado.
- `GET /api/videos/{publicId}` encaminha para `/videos/{publicId}` com o mesmo valor de `publicId`, e nenhuma resposta dessas rotas contém o `id` UUID do vídeo.
- `docker compose exec next-frontend npx tsc --noEmit` termina com exit code `0`.

---

### SI-03.16 — Upload multipart direto ao storage (Setup)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-upload-processing/TD-03 — Large-File Upload Protocol (10GB, resumable)`

**Technical actions:**

1. Criar `next-frontend/app/api/videos/[publicId]/upload-parts/route.ts` com `GET` (→ `GET /videos/{public_id}/upload-parts`) e `POST` (→ `POST /videos/{public_id}/upload-parts`, corpo tipado por `SignUploadPartsDto`) usando `lib/api/videos-proxy.ts` (per `phase-03-upload-processing/TD-03`, `TD-04` revisão).
2. Criar `next-frontend/lib/upload/multipart-uploader.ts` com a primitiva de envio de parte do snippet de Setup, byte a byte: `fetch(part.url, { method: "PUT", body: file.slice(start, end) })` direto ao storage e leitura de `res.headers.get("ETag")` — bytes de parte nunca passam por `app/api/**` (per `phase-03-upload-processing/TD-03`).
3. Calcular o intervalo de bytes de cada parte a partir do `part_size_bytes` devolvido por `POST /api/videos` (parte `n` = `[(n − 1) × part_size_bytes, min(n × part_size_bytes, file.size))`), sem constante de tamanho de parte no cliente (per `### API Contracts → POST /videos`).

**Dependencies:** SI-03.15 — helper `videos-proxy.ts`; SI-03.2 — CORS do bucket expõe `ETag` ao browser.

**Tests:** _(empty — Setup SI; smoke-gated by AC; behavior tests live in Migration + Verification SIs)_

**Acceptance criteria:**

- `GET` e `POST /api/videos/{publicId}/upload-parts` sem sessão retornam `401`; com sessão encaminham ao endpoint upstream correspondente e devolvem status e corpo inalterados.
- `lib/upload/multipart-uploader.ts` contém `fetch(part.url, { method: "PUT", body: file.slice(start, end) })` e `res.headers.get("ETag")`, idênticos ao spec.
- Para `part_size_bytes: 67108864` e um arquivo de 100 MiB, a parte 2 cobre os bytes `[67108864, 104857600)`.
- `docker compose exec next-frontend npx tsc --noEmit` termina com exit code `0`.

---

### SI-03.17 — Sinal de conclusão do upload no cliente (Setup)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-upload-processing/TD-05 — Upload Completion Signal & Draft Lifecycle`

**Technical actions:**

1. Criar `next-frontend/app/api/videos/[publicId]/upload-completion/route.ts` (`POST`) encaminhando para `POST /videos/{public_id}/upload-completion` com o corpo tipado por `CompleteUploadDto`, usando `lib/api/videos-proxy.ts` (per `phase-03-upload-processing/TD-05`, `TD-04` revisão).
2. Adicionar a `next-frontend/lib/upload/multipart-uploader.ts` a chamada de conclusão do snippet de Setup, byte a byte: `fetch(\`/api/videos/${publicId}/upload-completion\`, { method: "POST", body: JSON.stringify({ parts }) })`, com `parts` no formato `[{ part_number, etag }]` em ordem crescente de `part_number` (per `phase-03-upload-processing/TD-05`).
3. Tratar o `202` como fim do trabalho do uploader, expondo `publicId` e `processing_status: "processing"` a quem o chamou; o estado seguinte é lido por `GET /api/videos/{publicId}` (per `phase-03-upload-processing/TD-05`).

**Dependencies:** SI-03.16 — `multipart-uploader.ts` e partes enviadas com `ETag`.

**Tests:** _(empty — Setup SI; smoke-gated by AC; behavior tests live in Migration + Verification SIs)_

**Acceptance criteria:**

- `POST /api/videos/{publicId}/upload-completion` sem sessão retorna `401`; com sessão encaminha ao upstream e devolve `202`, `409` ou `422` com o corpo inalterado.
- `lib/upload/multipart-uploader.ts` envia a conclusão para `/api/videos/{publicId}/upload-completion` com `{ parts }` ordenado por `part_number`.
- `docker compose exec next-frontend npx tsc --noEmit` termina com exit code `0`.

---

### SI-03.18 — Cliente de upload multipart no browser (Setup)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-upload-processing/TD-04 — Browser Upload Client`

**Technical actions:**

1. Adicionar a `next-frontend/lib/upload/multipart-uploader.ts` as constantes do snippet de Setup, byte a byte: `PART_CONCURRENCY = 4` e `MAX_PART_RETRIES = 3` (per `phase-03-upload-processing/TD-04` revisão).
2. Implementar `uploadVideo(file, { onProgress })` seguindo a ordem do snippet: `validateUploadFile` (SI-03.14) → `POST /api/videos` → `GET /api/videos/{publicId}/upload-parts` (pula partes já armazenadas) → `POST /api/videos/{publicId}/upload-parts` para as partes faltantes → `PUT` das partes → conclusão (SI-03.17); e `resumeUpload(file, publicId, { onProgress })`, que entra no fluxo a partir da listagem de partes (per `phase-03-upload-processing/TD-04`).
3. Assinar as partes em lotes de até `PART_CONCURRENCY` imediatamente antes de enviá-las, para que nenhuma URL fique ociosa perto do TTL de 1 h, e manter no máximo `PART_CONCURRENCY` `PUT` simultâneos (per `phase-03-upload-processing/TD-03` revisão, `TD-04` revisão).
4. Repetir cada parte que falhar até `MAX_PART_RETRIES` vezes com backoff exponencial; uma parte que esgotar as tentativas rejeita o upload e a conclusão não é chamada (per `phase-03-upload-processing/TD-04` revisão).
5. Emitir `onProgress({ uploadedBytes, totalBytes })` a cada parte concluída, contando as partes já armazenadas encontradas na retomada.

**Dependencies:** SI-03.14 — `validateUploadFile`; SI-03.17 — rota e chamada de conclusão em `multipart-uploader.ts`.

**Tests:** _(empty — Setup SI; smoke-gated by AC; behavior tests live in Migration + Verification SIs)_

**Acceptance criteria:**

- `lib/upload/multipart-uploader.ts` contém `export const PART_CONCURRENCY = 4;` e `export const MAX_PART_RETRIES = 3;`, idênticos ao spec.
- Um upload novo chama, nesta ordem, `POST /api/videos`, `GET /api/videos/{publicId}/upload-parts`, `POST /api/videos/{publicId}/upload-parts`, os `PUT` de parte e `POST /api/videos/{publicId}/upload-completion`.
- Em nenhum momento há mais de 4 requisições `PUT` de parte em andamento.
- `resumeUpload` de um vídeo cujas partes 1 e 2 já estão armazenadas envia `PUT` apenas das partes restantes.
- `docker compose exec next-frontend npx tsc --noEmit` termina com exit code `0`.

---

### SI-03.19 — Rota BFF de URL de reprodução (Setup)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-upload-processing/TD-11 — Streaming Delivery Format`

**Technical actions:**

1. Criar `next-frontend/app/api/videos/[publicId]/playback-url/route.ts` (`GET`) encaminhando para `GET /videos/{public_id}/playback-url` via `lib/api/videos-proxy.ts` e devolvendo `{ url, expires_at }` (tipado por `MediaUrl`) sem reshape — a `url` é destinada a um `<video src={url}>` nativo, sem biblioteca de player (per `phase-03-upload-processing/TD-11`).
2. Garantir que a rota apenas repassa a URL: nenhum `fetch` para a própria URL de mídia e nenhum player construído na Phase 03 (per `phase-03-upload-processing/TD-12` revisão — refresh-on-403 fica para a Phase 05).

**Dependencies:** SI-03.15 — helper `videos-proxy.ts` e rota `[publicId]`.

**Tests:** _(empty — Setup SI; smoke-gated by AC; behavior tests live in Migration + Verification SIs)_

**Acceptance criteria:**

- `GET /api/videos/{publicId}/playback-url` sem sessão retorna `401`; com sessão encaminha ao upstream e devolve `200 { url, expires_at }`, `404` ou `409` com o corpo inalterado.
- A rota não faz requisição à `url` de mídia retornada.
- `docker compose exec next-frontend npx tsc --noEmit` termina com exit code `0`.

---

### SI-03.20 — Rota BFF de URL de download (Setup)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-upload-processing/TD-12 — Media Access Delivery (playback & download URLs)`

**Technical actions:**

1. Criar `next-frontend/app/api/videos/[publicId]/download-url/route.ts` (`GET`) encaminhando para `GET /videos/{public_id}/download-url` via `lib/api/videos-proxy.ts` e devolvendo `{ url, expires_at }` (tipado por `MediaUrl`) sem reshape (per `phase-03-upload-processing/TD-12`).
2. Garantir, conforme o snippet de Setup, que o browser navega para a `url` direto no storage — a rota nunca faz proxy dos bytes de mídia e não faz `fetch` para a `url` (per `phase-03-upload-processing/TD-12`).

**Dependencies:** SI-03.15 — helper `videos-proxy.ts` e rota `[publicId]`.

**Tests:** _(empty — Setup SI; smoke-gated by AC; behavior tests live in Migration + Verification SIs)_

**Acceptance criteria:**

- `GET /api/videos/{publicId}/download-url` sem sessão retorna `401`; com sessão encaminha ao upstream e devolve `200 { url, expires_at }`, `404` ou `409` com o corpo inalterado.
- A rota não faz requisição à `url` de mídia retornada e não transmite bytes de vídeo.
- `docker compose exec next-frontend npx tsc --noEmit` termina com exit code `0`.

---

### SI-03.21 — Cliente de upload (Verification)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-upload-processing/TD-04 — Browser Upload Client` → Verificação (Unit também de `TD-03`, `TD-05` e `TD-10`)

**Technical actions:**

1. Criar `next-frontend/lib/upload/__tests__/multipart-uploader.test.ts` com MSW interceptando as rotas `/api/videos/**` e o host das URLs assinadas de storage — cobre o limite de 4 `PUT` simultâneos, 3 novas tentativas por parte seguidas de rejeição sem conclusão, retomada que pula partes armazenadas, corpo de conclusão em ordem crescente com `etag`, intervalos de bytes derivados de `part_size_bytes` e registro do `ETag` de cada parte (per Verificação de `phase-03-upload-processing/TD-03`, `TD-04`, `TD-05`).
2. Criar `next-frontend/lib/upload/__tests__/validate-upload-file.test.ts` — `unsupported_type` e `too_large` sem nenhuma requisição, `ok` para `video/mp4` dentro do limite (per Verificação de `phase-03-upload-processing/TD-10`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `lib/upload/multipart-uploader.ts` (verification surface) | Unit per testing-guide-next-frontend § "Utilities & boundary modules" — concorrência, retry/backoff, retomada, corpo de conclusão, intervalos de bytes e `ETag` (MSW para rede) | `lib/upload/__tests__/multipart-uploader.test.ts` |
| `lib/upload/validate-upload-file.ts` | Unit per testing-guide-next-frontend § "Utilities & boundary modules" — rejeição antecipada por tipo e tamanho | `lib/upload/__tests__/validate-upload-file.test.ts` |

**Dependencies:** SI-03.14, SI-03.16, SI-03.17, SI-03.18

**Acceptance criteria:**

- `docker compose exec next-frontend npm test -- lib/upload` passa com os dois arquivos de teste.
- Com uma parte que falha 4 vezes seguidas, `uploadVideo` rejeita e nenhuma requisição chega a `/api/videos/{publicId}/upload-completion`.
- Com 10 partes a enviar, o número de `PUT` simultâneos observado nunca passa de 4.
- Os testes não fazem requisição de rede real (qualquer requisição não interceptada falha com `"request unhandled"`).

---

### SI-03.22 — Rotas BFF do fluxo de upload (Verification)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-upload-processing/TD-04 — Browser Upload Client` → Verificação (Integration também de `TD-05`, `TD-06` e `TD-10`)

**Technical actions:**

1. Criar `next-frontend/app/api/videos/__tests__/route.integration.test.ts` — `POST` sem sessão retorna `401` sem chamar o upstream; com sessão encaminha `POST /videos` com `Authorization` e corpo; repassa `201`, `400`, `413 UPLOAD_TOO_LARGE` e `415 UNSUPPORTED_MEDIA_TYPE` sem alteração; um `401` do upstream dispara um único refresh via `withRefresh` e a chamada é repetida (per Verificação de `phase-03-upload-processing/TD-04`, `TD-10`; `phase-02-auth-frontend/TD-03`).
2. Criar `next-frontend/app/api/videos/[publicId]/upload-parts/__tests__/route.integration.test.ts` — `GET` e `POST` encaminham ao path upstream com o mesmo `publicId` recebido e repassam `200`, `400 INVALID_PART_NUMBER`, `404 VIDEO_NOT_FOUND` e `409 UPLOAD_NOT_IN_PROGRESS` (per Verificação de `phase-03-upload-processing/TD-04`, `TD-06`).
3. Criar `next-frontend/app/api/videos/[publicId]/upload-completion/__tests__/route.integration.test.ts` — encaminha o corpo `{ parts }` e repassa `202`, `409 UPLOAD_NOT_IN_PROGRESS` e `422 UPLOAD_INCOMPLETE` (per Verificação de `phase-03-upload-processing/TD-05`).

Sessão configurada nos testes seguindo o padrão existente em `app/api/auth/logout/__tests__/route.integration.test.ts`; respostas upstream vindas de `mocks/handlers/videos.ts`, sobrescritas por caso com `server.use(...)`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `app/api/videos/route.ts` | Integration per testing-guide-next-frontend § "Route handlers" — Route Handler chamado como função, MSW como upstream | `app/api/videos/__tests__/route.integration.test.ts` |
| `app/api/videos/[publicId]/upload-parts/route.ts` | Integration per testing-guide-next-frontend § "Route handlers" | `app/api/videos/[publicId]/upload-parts/__tests__/route.integration.test.ts` |
| `app/api/videos/[publicId]/upload-completion/route.ts` | Integration per testing-guide-next-frontend § "Route handlers" | `app/api/videos/[publicId]/upload-completion/__tests__/route.integration.test.ts` |

**Dependencies:** SI-03.15, SI-03.16, SI-03.17

**Acceptance criteria:**

- `docker compose exec next-frontend npm test -- app/api/videos` passa com os três arquivos de teste.
- Sem sessão, as três rotas retornam `401` e o MSW não registra nenhuma requisição ao upstream.
- Para cada código de erro upstream coberto (`400`, `404`, `409`, `413`, `415`, `422`), a resposta da rota tem o mesmo status e o mesmo corpo `{ statusCode, error, message }`.
- Um `401` do upstream seguido de refresh bem-sucedido resulta em exatamente uma chamada a `/auth/refresh` e na resposta da segunda tentativa.

---

### SI-03.23 — Rotas BFF de leitura e mídia (Verification)

**Frontend Runtime spec:** see `## Technical Specifications` → `### Frontend Runtime` → `#### phase-03-upload-processing/TD-12 — Media Access Delivery (playback & download URLs)` → Verificação (Integration também de `TD-06` e `TD-11`)

**Technical actions:**

1. Criar `next-frontend/app/api/videos/[publicId]/__tests__/route.integration.test.ts` — `GET` sem sessão retorna `401` sem chamar o upstream; com sessão encaminha para `/videos/{public_id}` com o mesmo `publicId` recebido e repassa `200` e `404 VIDEO_NOT_FOUND` sem alteração (per Verificação de `phase-03-upload-processing/TD-06`).
2. Criar `next-frontend/app/api/videos/[publicId]/playback-url/__tests__/route.integration.test.ts` — repassa `200 { url, expires_at }`, `404 VIDEO_NOT_FOUND` e `409 VIDEO_NOT_READY`, e não faz requisição à `url` de mídia (per Verificação de `phase-03-upload-processing/TD-11`).
3. Criar `next-frontend/app/api/videos/[publicId]/download-url/__tests__/route.integration.test.ts` — repassa `200 { url, expires_at }`, `404 VIDEO_NOT_FOUND` e `409 VIDEO_NOT_READY`, e não faz requisição à `url` de mídia (per Verificação de `phase-03-upload-processing/TD-12`).

Sessão configurada nos testes seguindo o padrão existente em `app/api/auth/logout/__tests__/route.integration.test.ts`; respostas upstream vindas de `mocks/handlers/videos.ts`, sobrescritas por caso com `server.use(...)`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `app/api/videos/[publicId]/route.ts` | Integration per testing-guide-next-frontend § "Route handlers" — Route Handler chamado como função, MSW como upstream | `app/api/videos/[publicId]/__tests__/route.integration.test.ts` |
| `app/api/videos/[publicId]/playback-url/route.ts` | Integration per testing-guide-next-frontend § "Route handlers" | `app/api/videos/[publicId]/playback-url/__tests__/route.integration.test.ts` |
| `app/api/videos/[publicId]/download-url/route.ts` | Integration per testing-guide-next-frontend § "Route handlers" | `app/api/videos/[publicId]/download-url/__tests__/route.integration.test.ts` |

**Dependencies:** SI-03.15, SI-03.19, SI-03.20

**Acceptance criteria:**

- `docker compose exec next-frontend npm test -- app/api/videos` passa com os três arquivos de teste desta SI.
- Sem sessão, as três rotas retornam `401` e o MSW não registra nenhuma requisição ao upstream.
- `playback-url` e `download-url` repassam `409` com `error: "VIDEO_NOT_READY"` e o mesmo corpo do upstream.
- Durante os testes de `playback-url` e `download-url`, o MSW não registra nenhuma requisição ao host da `url` de mídia retornada.

---

## Technical Specifications

### Data Model

#### Video

Table `videos` (`@Entity('videos')`), module `VideosModule`.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated — internal identifier (per `phase-03-upload-processing/TD-06`: "the UUID stays as the internal PK") |
| public_id | varchar(11) | unique, not null — random 11-char base64url, generated server-side on draft creation (per `phase-03-upload-processing/TD-06`) |
| user_id | uuid | FK → `users.id`, not null — owner (media access is owner-only in Phase 03, per `phase-03-upload-processing/TD-12` revision) |
| publication_status | varchar(16) | not null, default `'draft'` — Phase 03 only writes `draft`; the publication axis is owned by Phase 04 (per `phase-03-upload-processing/TD-05`) |
| processing_status | varchar(16) | not null, default `'uploading'` — one of `uploading`, `processing`, `ready`, `failed` (per `phase-03-upload-processing/TD-05`) |
| failure_code | varchar(64) | nullable — set when `processing_status = failed` (per `phase-03-upload-processing/TD-05` revision) |
| original_filename | varchar(255) | not null — filename declared at initiation; used for the download `Content-Disposition` |
| content_type | varchar(100) | not null — declared MIME type, validated against the TD-10 allowlist at initiation |
| size_bytes | bigint | not null — declared size, `1 ≤ size_bytes ≤ 10737418240` (10 GiB, per `phase-03-upload-processing/TD-03` revision) |
| source_object_key | varchar(255) | not null — server-generated object key of the uploaded original (per `phase-03-upload-processing/TD-04`) |
| upload_id | varchar(255) | nullable, `select: false` — S3 multipart `UploadId` returned by `CreateMultipartUploadCommand` (`@aws-sdk/client-s3`); set on initiation, cleared on completion or abort |
| video_object_key | varchar(255) | nullable — object key of the remuxed, faststart MP4 (set when `processing_status = ready`) |
| thumbnail_object_key | varchar(255) | nullable — object key of the JPEG thumbnail, stored next to the video (per `phase-03-upload-processing/TD-09`) |
| duration_seconds | numeric(10,3) | nullable — from ffprobe |
| width | integer | nullable — from ffprobe |
| height | integer | nullable — from ffprobe |
| video_codec | varchar(32) | nullable — from ffprobe |
| audio_codec | varchar(32) | nullable — from ffprobe; null when the file has no audio stream |
| upload_completed_at | timestamptz | nullable — set when the completion endpoint succeeds |
| processed_at | timestamptz | nullable — set when `processing_status` becomes `ready` |
| failed_at | timestamptz | nullable — set when `processing_status` becomes `failed`; drives the 7-day original deletion |
| created_at | timestamptz | `@CreateDateColumn()` |
| updated_at | timestamptz | `@UpdateDateColumn()` |

**Object key layout** (all server-generated, private bucket per `phase-03-upload-processing/TD-12`):
- `videos/{public_id}/original` — upload target (`source_object_key`)
- `videos/{public_id}/video.mp4` — remuxed output (`video_object_key`)
- `videos/{public_id}/thumbnail.jpg` — thumbnail (`thumbnail_object_key`)

**Relations:** `User` has many `Video` (one-to-many) — `@OneToMany(() => Video, (video) => video.user)` on `User`, `@ManyToOne(() => User, (user) => user.videos)` + `@JoinColumn({ name: 'user_id' })` on `Video`.
**Indexes:** unique on `public_id`; index on `user_id`; composite index on `(processing_status, created_at)` (stale-draft purge scan); index on `failed_at` (failed-original cleanup scan).
**Migration:** `CreateVideosTable` generated via the TypeORM CLI (inherited convention: TypeORM `data-source.ts` factory from `phase-01-configuracao-base/TD-04`).

### API Contracts

All endpoints below are authenticated (existing JWT access-token guard from `phase-02-auth`) and use the inherited error envelope `{ statusCode, error, message }` (per `phase-02-auth/TD-07`). Request/response field names follow the existing snake_case DTO convention. Every endpoint carries explicit `@ApiOperation` / `@ApiResponse` / `@ApiBody` / `@ApiParam` decorators (per `openapi-docs-nestjs/TD-01` revision). Non-owners receive `404 VIDEO_NOT_FOUND` on every `:public_id` route (per `phase-03-upload-processing/TD-12` revision).

**Storage calls behind these endpoints** (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, per `phase-03-upload-processing/TD-01`, `TD-02`):
- Two `S3Client` instances, both `forcePathStyle: true` (Garage has no wildcard bucket DNS): the **internal** client (`STORAGE_ENDPOINT`, Compose service name) sends every server-side command; the **public** client (`STORAGE_PUBLIC_ENDPOINT`) is used **only** by `getSignedUrl` — the endpoint host is part of the signature, so signing with the internal client would hand the browser an unreachable or invalid URL (per `phase-03-upload-processing/TD-02`).
- `getSignedUrl(client, command, { expiresIn })` defaults to 900 s when `expiresIn` is omitted — every presign below passes `expiresIn` explicitly.
- S3 multipart limits relevant to the 10 GiB / 64 MiB configuration: part size ≥ 5 MiB except the last part, `PartNumber` in `1..10000`; 10 GiB ÷ 64 MiB = 160 parts maximum.

#### POST /videos (SI-03.5)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- filename: string, required — 1–255 characters
- size_bytes: integer, required — ≥ 1
- content_type: string, required — see Validation Rules

**Response 201:**
- public_id: string — 11-char base64url
- processing_status: string — `"uploading"`
- part_size_bytes: integer — `67108864` (64 MiB, per `phase-03-upload-processing/TD-03` revision)
- part_count: integer — `ceil(size_bytes / part_size_bytes)`
- created_at: string (ISO-8601)

**Side effects:** creates the `videos` row (`publication_status = draft`, `processing_status = uploading`) and opens the multipart upload with `CreateMultipartUploadCommand({ Bucket, Key: 'videos/{public_id}/original', ContentType })` on the internal client, persisting the returned `UploadId` as `upload_id` (per `phase-03-upload-processing/TD-02`, `TD-03`, `TD-05`). If the row save fails, the upload is aborted with `AbortMultipartUploadCommand`.

**Error responses:**
- 400 VALIDATION_ERROR: when the request body fails schema validation
- 401: when the access token is missing or invalid (existing guard)
- 413 UPLOAD_TOO_LARGE: when `size_bytes` > `10737418240` (10 GiB)
- 415 UNSUPPORTED_MEDIA_TYPE: when `content_type` is outside the allowlist

---

#### POST /videos/:public_id/upload-parts (SI-03.6)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- part_numbers: integer[], required — 1 to `part_count` entries, unique, each in `1..part_count`

**Response 200:**
- parts: array of
  - part_number: integer
  - url: string — `getSignedUrl(publicClient, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 })`, signed against the browser-facing storage endpoint (per `phase-03-upload-processing/TD-02`)
  - expires_at: string (ISO-8601) — issued-at + 1 h (per `phase-03-upload-processing/TD-03` revision)

**Side effects:** none — signing is a local computation; no request reaches storage. The browser `PUT`s each part to `url` and reads the `ETag` response header, which requires the bucket CORS rule to expose `ETag` (per `phase-03-upload-processing/TD-02`).

**Error responses:**
- 400 VALIDATION_ERROR: when the request body fails schema validation
- 400 INVALID_PART_NUMBER: when a part number is outside `1..part_count`
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or the caller is not the owner
- 409 UPLOAD_NOT_IN_PROGRESS: when `processing_status` is not `uploading`

---

#### GET /videos/:public_id/upload-parts (SI-03.6)

Lists the parts already stored for the in-progress multipart upload so the uploader can resume (per `phase-03-upload-processing/TD-04`). Backed by `ListPartsCommand({ Bucket, Key, UploadId })` on the internal client, mapping `Parts[]` (`PartNumber`, `ETag`, `Size`) to the response.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- parts: array of
  - part_number: integer
  - etag: string
  - size_bytes: integer

**Error responses:**
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or the caller is not the owner
- 409 UPLOAD_NOT_IN_PROGRESS: when `processing_status` is not `uploading`

---

#### POST /videos/:public_id/upload-completion (SI-03.7)

**Request headers:**
- Authorization: Bearer {access_token}
- Content-Type: application/json

**Request body:**
- parts: array, required — exactly `part_count` entries, ascending by `part_number`
  - part_number: integer, required
  - etag: string, required

**Response 202:**
- public_id: string
- processing_status: string — `"processing"`

**Side effects:** `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ ETag, PartNumber }] } })` on the internal client; then `HeadObjectCommand({ Bucket, Key })` verifies `ContentLength` equals `size_bytes` — a presigned part URL cannot cap total size, so this check is the server-side size guarantee (per `phase-03-upload-processing/TD-03`). On success sets `upload_completed_at`, clears `upload_id`, moves `processing_status` to `processing` and enqueues `process-video` (see Events/Messages) — validation, state transition and enqueue live in one service method (per `phase-03-upload-processing/TD-05`); the enqueue uses the video `id` as job ID so a retried enqueue is idempotent (per `phase-03-upload-processing/TD-07`).

**Error responses:**
- 400 VALIDATION_ERROR: when the request body fails schema validation
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or the caller is not the owner
- 409 UPLOAD_NOT_IN_PROGRESS: when `processing_status` is not `uploading`
- 422 UPLOAD_INCOMPLETE: when the part list does not cover `1..part_count`, storage rejects the completion, or the stored object size differs from `size_bytes`

---

#### GET /videos/:public_id (SI-03.8)

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- public_id: string
- publication_status: string — `"draft"`
- processing_status: string — `"uploading" | "processing" | "ready" | "failed"`
- failure_code: string | null
- original_filename: string
- content_type: string
- size_bytes: integer
- duration_seconds: number | null
- width: integer | null
- height: integer | null
- video_codec: string | null
- audio_codec: string | null
- created_at: string (ISO-8601)
- processed_at: string (ISO-8601) | null

**Error responses:**
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or the caller is not the owner

---

#### GET /videos/:public_id/playback-url (SI-03.10)

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- url: string — `getSignedUrl(publicClient, new GetObjectCommand({ Bucket, Key: video_object_key }), { expiresIn: 21600 })`; the object is served with HTTP Range support for progressive playback (per `phase-03-upload-processing/TD-11`, `TD-12`)
- expires_at: string (ISO-8601) — issued-at + 6 h (per `phase-03-upload-processing/TD-12` revision)

**Error responses:**
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or the caller is not the owner
- 409 VIDEO_NOT_READY: when `processing_status` is not `ready`

---

#### GET /videos/:public_id/download-url (SI-03.10)

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- url: string — `getSignedUrl(publicClient, new GetObjectCommand({ Bucket, Key: video_object_key, ResponseContentDisposition: 'attachment; filename="<name>.mp4"' }), { expiresIn: 900 })`; storage echoes `ResponseContentDisposition` as the `Content-Disposition` response header (filename derived from `original_filename`, extension `.mp4`) (per `phase-03-upload-processing/TD-12` revision)
- expires_at: string (ISO-8601) — issued-at + 15 min (per `phase-03-upload-processing/TD-12` revision)

**Error responses:**
- 401: when the access token is missing or invalid
- 404 VIDEO_NOT_FOUND: when the video does not exist or the caller is not the owner
- 409 VIDEO_NOT_READY: when `processing_status` is not `ready`

---

#### Validation Rules — videos

- `filename`: required string, 1–255 characters.
- `size_bytes`: required integer ≥ 1; values above `10737418240` (10 × 1024³ bytes) are rejected by the service with `413 UPLOAD_TOO_LARGE`, not by the DTO (per `phase-03-upload-processing/TD-03` revision).
- `content_type`: required string; the service accepts only `video/mp4` and `video/quicktime`, otherwise `415 UNSUPPORTED_MEDIA_TYPE`. Derived from `phase-03-upload-processing/TD-10` (allowlist + remux-only) combined with `TD-11` (progressive playback, no transcoding): only containers that can be remuxed losslessly into a browser-playable MP4 are accepted. The worker enforces the codec side of the allowlist (`h264` video; `aac` audio or no audio stream) and fails the video with `failure_code = UNSUPPORTED_CODEC` otherwise.
- `part_numbers[]` / `parts[].part_number`: integers in `1..part_count`; `part_count` is recomputed server-side from the stored `size_bytes` and the fixed 64 MiB part size — never trusted from the client.
- `parts[].etag`: required non-empty string, passed through to storage verbatim.

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ (401) | ✓ (caller becomes the owner) | — |
| POST /videos/:public_id/upload-parts | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ |
| GET /videos/:public_id/upload-parts | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ |
| POST /videos/:public_id/upload-completion | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ |
| GET /videos/:public_id | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ |
| GET /videos/:public_id/playback-url | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ |
| GET /videos/:public_id/download-url | ✗ (401) | ✗ (404 VIDEO_NOT_FOUND) | ✓ |

- Media access is owner-only in Phase 03; non-owners get `404 VIDEO_NOT_FOUND` so existence is not revealed. Phases 04–05 widen access (per `phase-03-upload-processing/TD-12` revision).
- The `next-frontend` BFF routes under `/api/videos/**` mirror this matrix: without a session they return 401 without calling upstream; with a session they forward the access token and pass upstream 404/409 responses through (per `phase-02-auth-frontend/TD-01`, `TD-03`).
- Presigned storage URLs carry no app credentials; their only protection is the signature + TTL (per `phase-03-upload-processing/TD-12`). The bucket stays private — no public-read policy.

### Error Catalog

Existing envelope `{ statusCode, error, message }` (per `phase-02-auth/TD-07`). New HTTP codes are added as `DomainException` subclasses next to the existing ones in `nestjs-project/src/common/exceptions/domain.exception.ts`.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `public_id` does not exist, or the caller is not the owner (per `phase-03-upload-processing/TD-12` revision) |
| UPLOAD_TOO_LARGE | 413 | `POST /videos` with `size_bytes` > `10737418240` (10 GiB) |
| UNSUPPORTED_MEDIA_TYPE | 415 | `POST /videos` with `content_type` outside `video/mp4`, `video/quicktime` |
| INVALID_PART_NUMBER | 400 | `POST /videos/:public_id/upload-parts` with a part number outside `1..part_count` |
| UPLOAD_NOT_IN_PROGRESS | 409 | upload-parts or upload-completion called when `processing_status` ≠ `uploading` |
| UPLOAD_INCOMPLETE | 422 | upload-completion whose parts do not cover `1..part_count`, rejected by storage (`CompleteMultipartUploadCommand` error), or whose stored size (`HeadObjectCommand` `ContentLength`) ≠ `size_bytes` |
| VIDEO_NOT_READY | 409 | playback-url or download-url called when `processing_status` ≠ `ready` |

**`failure_code` values** (stored on the row by the worker, never returned as HTTP errors; exposed through `GET /videos/:public_id`):

| failure_code | Trigger | Retried? |
|--------------|---------|----------|
| UNSUPPORTED_CODEC | ffprobe reports a video codec other than `h264`, or an audio codec other than `aac` (per `phase-03-upload-processing/TD-10`) | No — thrown as a BullMQ `UnrecoverableError`, fails on the first attempt |
| INVALID_MEDIA | ffprobe cannot read the file, or it has no video stream | No — thrown as a BullMQ `UnrecoverableError` |
| PROCESSING_FAILED | remux, thumbnail or storage step still failing after 3 attempts (per `phase-03-upload-processing/TD-07` revision) | Yes — up to 3 attempts |

### Events/Messages

Queues run on BullMQ + Redis via `@nestjs/bullmq` + `bullmq` (per `phase-03-upload-processing/TD-07`). Producers live in `nestjs-api`; consumers live in the `video-worker` container, a second entrypoint of the same `nestjs-project` codebase (per `phase-03-upload-processing/TD-08`). New queue and Redis settings go in `src/config/queue.config.ts` + `env.validation.ts` (inherited convention).

**Wiring (`@nestjs/bullmq`):**
- `BullModule.forRootAsync({ imports: [ConfigModule], inject: [queueConfig.KEY], useFactory })` returns `{ connection: { host, port } }` from the `queue` namespace — `REDIS_HOST` is the Compose service name, never `localhost` (inherited `ConfigType` / `registerAs` convention from `phase-01-configuracao-base/TD-03`).
- `BullModule.registerQueue({ name: 'video-processing', defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay } } })` and `BullModule.registerQueue({ name: 'video-maintenance' })` — shared by producer and consumer modules (per `phase-03-upload-processing/TD-07` revision).
- Producers inject queues with `@InjectQueue(name)`. Consumers are `@Processor(name, workerOptions)` classes extending `WorkerHost` with `async process(job)`, registered **only** in the worker's root module — the API module registers the queues but no `@Processor` class, so the API process never consumes jobs (per `phase-03-upload-processing/TD-08`).

#### process-video (queue `video-processing`)

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideosService` (upload-completion flow) — `queue.add('process-video', { videoId }, { jobId: videoId })` (per `phase-03-upload-processing/TD-05`, `TD-07`)
**Consumer:** `VideoProcessingProcessor` in `video-worker` (per `phase-03-upload-processing/TD-08`)
**Trigger:** `POST /videos/:public_id/upload-completion` succeeds.
**Delivery semantics:** at-least-once (per `phase-03-upload-processing/TD-07`):
- `jobId = videoId` — adding a job whose ID already exists is ignored, so a retried enqueue collapses into the original job.
- 3 attempts with exponential backoff, inherited from the queue's `defaultJobOptions` (per `phase-03-upload-processing/TD-07` revision).
- Policy failures (`UNSUPPORTED_CODEC`, `INVALID_MEDIA`) are thrown as `UnrecoverableError` from `bullmq`, which moves the job straight to the failed set and skips the remaining attempts.
- **Locks and stalled jobs:** the worker holds a lock for `lockDuration` (default 30 s) and renews it every `lockRenewTime` (≈ half of `lockDuration`); a lock that is not renewed marks the job stalled and it is processed again. FFmpeg runs in a child process (`spawn`, per `phase-03-upload-processing/TD-09`), so the Node event loop stays free and renewal keeps working through a multi-GB remux. `maxStalledCount` (default 1) caps stalled restarts; the `stalled` event is logged.
- The processor is idempotent: it exits without work unless `processing_status = processing`, so a stalled-job replay or duplicate delivery never reprocesses a `ready` or `failed` video.

**Processing steps** (system FFmpeg invoked through a `spawn` wrapper, per `phase-03-upload-processing/TD-09`):
1. Download `videos/{public_id}/original` through the internal storage client (`GetObjectCommand`) to a temp directory.
2. `ffprobe` → `duration_seconds`, `width`, `height`, `video_codec`, `audio_codec`. Outside the codec allowlist → `failure_code = UNSUPPORTED_CODEC`; unreadable / no video stream → `INVALID_MEDIA` (both thrown as `UnrecoverableError`).
3. Remux without re-encoding into a faststart MP4 (`ffmpeg -i original -c copy -movflags +faststart video.mp4`) so playback can start before the full download (per `phase-03-upload-processing/TD-10`, `TD-11`).
4. Thumbnail: one JPEG frame 1280 px wide at 10% of the duration, clamped for very short videos (`ffmpeg -ss {t} -i video.mp4 -frames:v 1 -vf scale=1280:-2 thumbnail.jpg`, `t = min(0.10 × duration, max(duration − 0.1, 0))`) (per `phase-03-upload-processing/TD-09` revision).
5. Upload `video.mp4` and `thumbnail.jpg` to `videos/{public_id}/` (`PutObjectCommand`), set `video_object_key`, `thumbnail_object_key`, metadata columns, `processing_status = ready`, `processed_at`; delete the original object (`DeleteObjectCommand` — the remux is lossless, so it is no longer needed).
6. On the final failure (`UnrecoverableError`, or the 3rd attempt failing): `processing_status = failed`, `failure_code`, `failed_at`; the original object stays for 7 days (see `purge-stale-uploads`).

#### purge-stale-uploads (queue `video-maintenance`, scheduled)

**Payload:**

```json
{}
```

**Producer:** job scheduler upserted when `video-worker` starts — `queue.upsertJobScheduler('purge-stale-uploads', { pattern: '0 0 * * * *' }, { name: 'purge-stale-uploads', data: {} })`, running hourly. `upsertJobScheduler` is keyed by the scheduler ID, so worker restarts update the one schedule instead of adding duplicates; it replaces the legacy repeatable-job API in BullMQ v6 (per `phase-03-upload-processing/TD-07`: "repeatable cleanup")
**Consumer:** `VideoMaintenanceProcessor` in `video-worker`
**Trigger:** hourly schedule.
**Delivery semantics:** at-least-once; every step is idempotent (deleting an already-deleted object, an already-aborted upload or an already-removed row is a no-op).

**Work:**
1. Rows with `processing_status = uploading` and `created_at` older than 24 h → `AbortMultipartUploadCommand` (when `upload_id` is set) and delete the row (per `phase-03-upload-processing/TD-05` revision).
2. Rows with `processing_status = failed` and `failed_at` older than 7 days → `DeleteObjectCommand` on `videos/{public_id}/original`; the row keeps `failure_code` (per `phase-03-upload-processing/TD-05` revision).
3. Backstop: the bucket lifecycle rule (`PutBucketLifecycleConfigurationCommand` with `AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 }`, applied at bucket bootstrap) aborts incomplete multipart uploads independently of this job (per `phase-03-upload-processing/TD-01` revision).

### Frontend Runtime

#### phase-03-upload-processing/TD-03 — Large-File Upload Protocol (10GB, resumable)

**Pattern:** "it is the only option that keeps upload bytes off both Node servers while providing resume, which is exactly the "sem impacto na performance" + "retomar em caso de falha" pair; it also realizes the presigned-storage path already anticipated in `next-frontend-config-base/TD-03`." Revision 2026-09-14: upload ceiling 10 GiB (10 × 1024³ bytes); part size 64 MiB; presigned part-URL TTL 1 h.

**Setup:**

```ts
// next-frontend/lib/upload/multipart-uploader.ts
// Part bytes go browser → storage directly; the BFF only relays the small JSON orchestration calls.
const res = await fetch(part.url, { method: "PUT", body: file.slice(start, end) });
const etag = res.headers.get("ETag"); // requires bucket CORS to expose ETag (SI-03.2)
```

**Aplicação:** logic-only phase — applies to every future upload surface in `next-frontend`; in Phase 03 the only consumer is the uploader module (`lib/upload/`). Part PUTs never go through `app/api/**`. The presigned URLs come from the backend (`@aws-sdk/s3-request-presigner`); the frontend adds no storage library.

**Migração:** _No existing files require refactor — Setup SI is the only application of this pattern in the current phase._

**Verificação:**
- **Unit:** uploader test intercepts the storage PUT URLs with MSW and asserts part byte ranges match `part_size_bytes` and that each part's `ETag` is recorded.
- **Integration:** backend E2E presigns via the browser-facing endpoint and PUTs a part to real Garage (the safety net named in `phase-03-upload-processing/TD-02`).
- **E2E:** _not applicable in Phase 03 (no page)._
- **Regression guards:** existing BFF auth integration tests keep passing (no change to `app/api/auth/**`).

#### phase-03-upload-processing/TD-04 — Browser Upload Client

**Pattern:** "with TD-03 A the uploader's job is narrow (slice, PUT, retry, resume), and keeping create/complete on the API preserves server-side control of object keys, size validation and the processing trigger (TD-05); Uppy's current `signRequest` model inverts that ownership." Revisions 2026-09-14: delivered as a `next-frontend` module plus BFF Route Handlers (initiate / sign parts / complete / media URLs) with no page mounting them; verification = uploader unit tests + BFF integration tests (MSW) + backend E2E against real storage; 4 concurrent 64 MiB parts with 3 retries per part and backoff.

**Setup:**

```ts
// next-frontend/lib/upload/multipart-uploader.ts
export const PART_CONCURRENCY = 4;
export const MAX_PART_RETRIES = 3; // exponential backoff between retries
// POST /api/videos → GET /api/videos/{publicId}/upload-parts (resume: skip stored parts)
// → POST /api/videos/{publicId}/upload-parts (sign missing parts) → PUT parts
// → POST /api/videos/{publicId}/upload-completion { parts } (ascending by part_number)
```

BFF Route Handlers (all pass-through, one shape — upstream call through the typed `openapi-fetch` client with the session access token and transparent refresh, upstream status and body returned unchanged; per `next-frontend-openapi-typing/TD-01`, `phase-02-auth-frontend/TD-01`, `TD-03`, `TD-05`):

| Route file | Methods | Upstream |
|------------|---------|----------|
| `app/api/videos/route.ts` | POST | `POST /videos` |
| `app/api/videos/[publicId]/route.ts` | GET | `GET /videos/:public_id` |
| `app/api/videos/[publicId]/upload-parts/route.ts` | GET, POST | `GET`/`POST /videos/:public_id/upload-parts` |
| `app/api/videos/[publicId]/upload-completion/route.ts` | POST | `POST /videos/:public_id/upload-completion` |
| `app/api/videos/[publicId]/playback-url/route.ts` | GET | `GET /videos/:public_id/playback-url` |
| `app/api/videos/[publicId]/download-url/route.ts` | GET | `GET /videos/:public_id/download-url` |

Request/response types come from `lib/api/contracts.ts` aliases over the regenerated `paths` (per `next-frontend-openapi-typing/TD-04`).

**Aplicação:** logic-only phase — the uploader module and the six routes above are the whole Phase 03 frontend surface; the upload screen that mounts the uploader lands in a later phase and consumes them as-is.

**Migração:** _No existing files require refactor — Setup SI is the only application of this pattern in the current phase._

**Verificação:**
- **Unit:** `lib/upload/__tests__/multipart-uploader.test.ts` — never more than 4 PUTs in flight; a part failing 3 times rejects the upload and completion is not called; resume skips parts returned by `GET upload-parts`; completion body lists every part ascending with its `etag`.
- **Integration:** `app/api/videos/**/__tests__/*.integration.test.ts` with `mocks/handlers/videos.ts` typed via `paths` (per `next-frontend-openapi-typing/TD-05`) — each route forwards method/path/body upstream, passes status and body through (201/200/202 and 404/409/413/415/422 envelopes), and returns 401 without calling upstream when there is no session.
- **E2E:** _not applicable in Phase 03 (no page)._
- **Regression guards:** existing `mocks/` handler barrel and auth route integration tests keep passing after `videos.ts` is added.

#### phase-03-upload-processing/TD-05 — Upload Completion Signal & Draft Lifecycle

**Pattern:** "the API already owns initiation, so owning completion keeps validation, state transitions and enqueueing in one transactional place without coupling Phase 03 to provider-specific eventing. Proposed processing statuses for the contract: `uploading → processing → ready | failed`."

**Setup:**

```ts
// next-frontend/lib/upload/multipart-uploader.ts
await fetch(`/api/videos/${publicId}/upload-completion`, {
  method: "POST",
  body: JSON.stringify({ parts }), // [{ part_number, etag }] ascending
}); // 202 → processing_status "processing"; later state read via GET /api/videos/{publicId}
```

**Aplicação:** logic-only phase — the uploader treats `202` as the end of its job; any future status display reads `processing_status` (`uploading | processing | ready | failed`) and `failure_code` from `GET /api/videos/{publicId}`.

**Migração:** _No existing files require refactor — Setup SI is the only application of this pattern in the current phase._

**Verificação:**
- **Unit:** completion is called exactly once, only after every part succeeded.
- **Integration:** `upload-completion` route passes `202`, `409 UPLOAD_NOT_IN_PROGRESS` and `422 UPLOAD_INCOMPLETE` through unchanged.
- **E2E:** _not applicable in Phase 03 (no page)._
- **Regression guards:** none beyond the TD-04 guards.

#### phase-03-upload-processing/TD-06 — Unique Public Video ID (URL identifier)

**Pattern:** "it is the only option that is simultaneously short, collision-proof by constraint, and non-enumerable, the last property being required by the unlisted-video capability in Phases 04–05; the UUID stays as the internal PK per entity conventions."

**Setup:**

```ts
// next-frontend/app/api/videos/[publicId]/route.ts
// `publicId` is the 11-char base64url `public_id`, forwarded verbatim to /videos/:public_id.
// The internal UUID never appears in any BFF response or route.
```

**Aplicação:** logic-only phase — every `app/api/videos/[publicId]/**` route; future video URLs in the UI use the same identifier.

**Migração:** _No existing files require refactor — Setup SI is the only application of this pattern in the current phase._

**Verificação:**
- **Unit:** _none._
- **Integration:** the MSW handler asserts the upstream path contains the exact `publicId` received by the route.
- **E2E:** _not applicable in Phase 03 (no page)._
- **Regression guards:** none.

#### phase-03-upload-processing/TD-10 — Accepted Input Formats & Normalization Policy

**Pattern:** "it guarantees streamable output within the phase's processing scope, fails early and visibly at the uploader instead of at the viewer, and leaves full transcoding (Option A) as a later capability if format rejection proves to be a real user pain."

**Setup:**

```ts
// next-frontend/lib/upload/constants.ts
export const ACCEPTED_CONTENT_TYPES = ["video/mp4", "video/quicktime"] as const;
export const MAX_UPLOAD_BYTES = 10737418240; // 10 × 1024³
```

**Aplicação:** logic-only phase — the uploader rejects files outside `ACCEPTED_CONTENT_TYPES` or above `MAX_UPLOAD_BYTES` before any network call; the API stays authoritative (`413`/`415`) and the codec check happens in the worker (`failure_code = UNSUPPORTED_CODEC`).

**Migração:** _No existing files require refactor — Setup SI is the only application of this pattern in the current phase._

**Verificação:**
- **Unit:** an oversized file or an unsupported MIME type rejects without calling `/api/videos`.
- **Integration:** `POST /api/videos` passes `413 UPLOAD_TOO_LARGE` and `415 UNSUPPORTED_MEDIA_TYPE` through.
- **E2E:** _not applicable in Phase 03 (no page)._
- **Regression guards:** none.

#### phase-03-upload-processing/TD-11 — Streaming Delivery Format

**Pattern:** "it satisfies "sem necessidade de download completo" natively with no transcoding or player dependency, consistent with TD-10 B; HLS can be added later as an additional output without changing the upload pipeline."

**Setup:**

```ts
// next-frontend/app/api/videos/[publicId]/playback-url/route.ts
// Returns { url, expires_at }; `url` is meant for a native <video src={url}> (no player library).
// No player is built in Phase 03 (moved to Phase 05 per TD-12 revision).
```

**Aplicação:** logic-only phase — the future watch page (Phase 05) consumes `playback-url` with a native `<video>` element; Phase 03 delivers only the URL route.

**Migração:** _No existing files require refactor — Setup SI is the only application of this pattern in the current phase._

**Verificação:**
- **Unit:** _none._
- **Integration:** `playback-url` route passes `200 { url, expires_at }` and `409 VIDEO_NOT_READY` through.
- **E2E:** _not applicable in Phase 03 (no page)._ Backend E2E asserts a `Range` request on the presigned URL returns `206 Partial Content` from Garage.
- **Regression guards:** none.

#### phase-03-upload-processing/TD-12 — Media Access Delivery (playback & download URLs)

**Pattern:** "it keeps bytes off Node servers while preserving per-request access control that Phases 04–05 depend on (drafts, unlisted, anonymous viewing); expiry is handled with a generous playback TTL plus a single refresh-on-403 in the player." Revisions 2026-09-14: owner-only access with `404 VIDEO_NOT_FOUND` for everyone else; playback URL TTL 6 h; download URL TTL 15 min with `Content-Disposition: attachment`; the refresh-on-403 in the player moves to Phase 05.

**Setup:**

```ts
// next-frontend/app/api/videos/[publicId]/download-url/route.ts
// Pass-through of { url, expires_at }. The browser navigates to `url` directly against storage;
// media bytes are never proxied through the BFF.
```

**Aplicação:** logic-only phase — `playback-url` and `download-url` routes only; the refresh-on-403 behavior belongs to the Phase 05 player.

**Migração:** _No existing files require refactor — Setup SI is the only application of this pattern in the current phase._

**Verificação:**
- **Unit:** _none._
- **Integration:** both routes pass `200`, `404 VIDEO_NOT_FOUND` and `409 VIDEO_NOT_READY` through and never fetch the media URL themselves.
- **E2E:** _not applicable in Phase 03 (no page)._ Backend E2E asserts the download URL response carries `Content-Disposition: attachment` and that a non-owner gets 404.
- **Regression guards:** none.

---

## Dependency Map

```text
SI-03.1 (root — infraestrutura Compose)
├── SI-03.2 — depends on SI-03.1 (Garage e chaves de ambiente)
│   └── SI-03.5 — depends on SI-03.2 + SI-03.3 (storage e entidade)
│       └── SI-03.6 — depends on SI-03.5 (vídeo em uploading e controller)
│           ├── SI-03.7 — depends on SI-03.6 + SI-03.4 (partes assinadas e fila)
│           └── SI-03.8 — depends on SI-03.6 (findOwnedByPublicId)
│               └── SI-03.10 — depends on SI-03.8 + SI-03.9 (rotas do owner e vídeos ready)
├── SI-03.4 — depends on SI-03.1 + SI-03.3 (Redis e VideosModule)
└── SI-03.9 — depends on SI-03.1 + SI-03.2 + SI-03.3 + SI-03.4 (FFmpeg, storage, entidade e fila)
    └── SI-03.11 — depends on SI-03.9 (WorkerModule)
SI-03.3 (root — entidade Video)
SI-03.12 — depends on SI-03.5 + SI-03.6 + SI-03.7 + SI-03.8 + SI-03.10 (todos os endpoints de vídeos)
└── SI-03.13 — depends on SI-03.12 (openapi.json regenerado)
    └── SI-03.15 — depends on SI-03.13 (tipos, aliases e handlers MSW)
        ├── SI-03.16 — depends on SI-03.15 + SI-03.2 (helper BFF e CORS expondo ETag)
        │   └── SI-03.17 — depends on SI-03.16 (multipart-uploader.ts)
        │       └── SI-03.18 — depends on SI-03.17 + SI-03.14 (conclusão e validação de arquivo)
        │           └── SI-03.21 — depends on SI-03.14 + SI-03.16 + SI-03.17 + SI-03.18 (verificação do uploader)
        ├── SI-03.19 — depends on SI-03.15 (helper BFF)
        ├── SI-03.20 — depends on SI-03.15 (helper BFF)
        ├── SI-03.22 — depends on SI-03.15 + SI-03.16 + SI-03.17 (verificação das rotas de upload)
        └── SI-03.23 — depends on SI-03.15 + SI-03.19 + SI-03.20 (verificação das rotas de leitura e mídia)
SI-03.14 (root — formatos aceitos no cliente)
```

---

## Deliverables

- [ ] SI-03.1 — Infra: Garage, Redis, video-worker e FFmpeg no Compose
- [ ] SI-03.2 — Módulo de storage S3 com endpoints interno e público
- [ ] SI-03.3 — Entidade Video, migration e gerador de ID público
- [ ] SI-03.4 — Infra: módulo de filas BullMQ
- [ ] SI-03.5 — Endpoint POST /videos (pré-cadastro e início do upload)
- [ ] SI-03.6 — Endpoints de partes do upload (assinar e listar)
- [ ] SI-03.7 — Endpoint de conclusão do upload e enfileiramento do processamento
- [ ] SI-03.8 — Endpoint GET /videos/:public_id (status e metadados)
- [ ] SI-03.9 — Worker: entrypoint e processamento do vídeo
- [ ] SI-03.10 — Endpoints de URL de reprodução e download
- [ ] SI-03.11 — Job de manutenção: expurgo de uploads abandonados e de originais com falha
- [ ] SI-03.12 — Regenerar o artefato OpenAPI com os endpoints de vídeos
- [ ] SI-03.13 — Sincronizar o contrato de vídeos no next-frontend
- [ ] SI-03.14 — Formatos aceitos e limite de tamanho no cliente (Setup)
- [ ] SI-03.15 — Identificador público nas rotas BFF de vídeos (Setup)
- [ ] SI-03.16 — Upload multipart direto ao storage (Setup)
- [ ] SI-03.17 — Sinal de conclusão do upload no cliente (Setup)
- [ ] SI-03.18 — Cliente de upload multipart no browser (Setup)
- [ ] SI-03.19 — Rota BFF de URL de reprodução (Setup)
- [ ] SI-03.20 — Rota BFF de URL de download (Setup)
- [ ] SI-03.21 — Cliente de upload (Verification)
- [ ] SI-03.22 — Rotas BFF do fluxo de upload (Verification)
- [ ] SI-03.23 — Rotas BFF de leitura e mídia (Verification)

**Full test suites:**

- [ ] Backend unit + integration tests pass (`cd nestjs-project && docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Backend E2E tests pass (`cd nestjs-project && docker compose exec nestjs-api npm run test:e2e`)
- [ ] Backend type/compilation checks pass (`cd nestjs-project && docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Backend lint passes (`cd nestjs-project && docker compose exec nestjs-api npm run lint`)
- [ ] Frontend tests pass (`cd next-frontend && docker compose exec next-frontend npm test`)
- [ ] Frontend type/compilation checks pass (`cd next-frontend && docker compose exec next-frontend npx tsc --noEmit`)
- [ ] Frontend lint passes (`cd next-frontend && docker compose exec next-frontend npm run lint`)
- [ ] OpenAPI contract is fresh (`bash scripts/sync-openapi.sh` + `cd next-frontend && docker compose exec next-frontend npm run openapi:types` produce no diff)
