---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.7
target_file: test/videos.e2e-spec.ts
---

# POST /videos/:public_id/upload-completion Test Plan

## Application Overview

This endpoint is the bridge between upload and processing: it closes the multipart upload in storage, verifies the final object size server-side, transitions the video to `processing` in a single transaction, and enqueues the `process-video` job idempotently (keyed by the video id).

## Test Scenarios

### 1. POST /videos/:public_id/upload-completion

**Setup:** same bootstrap as `videos-upload-initiate.plan.md` §1, plus a video created via `POST /videos` and driven to `uploading` with all parts already `PUT` to the real Garage storage via signed URLs (as in `videos-upload-parts.plan.md` §2.1), so completion has real ETags to submit.

#### 1.1. completes-upload-and-enqueues-processing

**Covers AC:** #1, #2, #3
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. POST /videos/:public_id/upload-completion do owner com todas as partes em ordem crescente e seus `etag`
    - expect: `202` com `{ "public_id": "…", "processing_status": "processing" }`
  2. Lê a linha do vídeo no banco
    - expect: `processing_status = 'processing'`, `upload_completed_at` preenchido e `upload_id` nulo
  3. Consulta o objeto `videos/{public_id}/original` no storage
    - expect: existe e tem tamanho igual a `size_bytes`
  4. Inspeciona a fila `video-processing` no Redis
    - expect: contém um job `process-video` cujo id é o `id` do vídeo e cujo payload é `{ "videoId": "<id>" }`

#### 1.2. rejects-incomplete-parts

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. POST /videos/:public_id/upload-completion do owner omitindo a parte 2 de um vídeo com `part_count: 2`
    - expect: `422` com `error: "UPLOAD_INCOMPLETE"`
    - expect: o vídeo continua com `processing_status = 'uploading'`

#### 1.3. rejects-repeated-completion

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. Repete a conclusão de um upload já concluído com sucesso
    - expect: `409` com `error: "UPLOAD_NOT_IN_PROGRESS"`
    - expect: nenhum segundo job é criado na fila `video-processing` para este vídeo

#### 1.4. rejects-non-owner-with-not-found

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. POST /videos/:public_id/upload-completion autenticado como um segundo usuário (não o owner)
    - expect: `404` com `error: "VIDEO_NOT_FOUND"`
