---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.5
target_file: test/videos.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` is the entry point of the upload flow: it validates the declared file (size and content type), pré-cadastra the video as a `draft` row owned by the caller, and opens a multipart upload against the object storage, returning the `public_id` and part-count the client needs to drive the rest of the upload.

## Test Scenarios

### 1. POST /videos

**Setup:** `beforeAll` boots `AppModule` via `Test.createTestingModule()` with the global `ValidationPipe` and exception filters applied manually (mirrors `test/auth.e2e-spec.ts`); `beforeEach` truncates all tables via `cleanAllTables(dataSource)` and registers + authenticates a test user to obtain an `access_token`.

#### 1.1. creates-draft-video-and-opens-multipart-upload

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. POST /videos autenticado com `{ "filename": "clip.mp4", "size_bytes": 104857600, "content_type": "video/mp4" }`
    - expect: `201` com `public_id` de 11 caracteres, `processing_status: "uploading"`, `part_size_bytes: 67108864` e `part_count: 2`
  2. Lê a linha criada na tabela `videos`
    - expect: `publication_status = 'draft'`, `user_id` igual ao do chamador autenticado e `upload_id` preenchido (não nulo)

#### 1.2. rejects-file-above-10gb

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. POST /videos autenticado com `size_bytes: 10737418241` (10 GiB + 1 byte)
    - expect: `413` com `error: "UPLOAD_TOO_LARGE"`
    - expect: nenhuma linha em `videos` referencia um multipart upload aberto no storage para esta requisição (nenhum `CreateMultipartUploadCommand` bem-sucedido persistido)

#### 1.3. rejects-unsupported-content-type

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. POST /videos autenticado com `content_type: "video/x-matroska"`
    - expect: `415` com `error: "UNSUPPORTED_MEDIA_TYPE"`

#### 1.4. rejects-missing-filename

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. POST /videos autenticado sem o campo `filename`
    - expect: `400` com `error: "VALIDATION_ERROR"`

#### 1.5. rejects-missing-access-token

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. POST /videos sem header `Authorization`
    - expect: `401`

#### 1.6. allows-burst-of-eleven-requests-without-rate-limiting

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. Envia 11 requisições `POST /videos` autenticadas do mesmo cliente em menos de 60 segundos
    - expect: nenhuma das 11 respostas é `429`
