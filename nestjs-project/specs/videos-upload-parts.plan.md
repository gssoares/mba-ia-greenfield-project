---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.6
target_file: test/videos.e2e-spec.ts
---

# POST|GET /videos/:public_id/upload-parts Test Plan

## Application Overview

These endpoints let the browser drive a multipart upload directly against the object storage: `POST .../upload-parts` signs presigned `PUT` URLs for the requested part numbers, and `GET .../upload-parts` lists the parts already stored (via the storage's real `ListPartsCommand`), which is what makes an interrupted upload resumable.

## Test Scenarios

### 1. POST /videos/:public_id/upload-parts

**Setup:** same bootstrap as `videos-upload-initiate.plan.md` §1 (AppModule + global pipes/filters, `cleanAllTables`, authenticated test user); additionally, each test first calls `POST /videos` to create a video in `uploading` with a known `part_count`.

#### 1.1. signs-requested-part-urls

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. POST /videos/:public_id/upload-parts do owner com `{ "part_numbers": [1, 2] }` para um vídeo com `part_count: 2`
    - expect: `200` com duas entradas em `parts`
    - expect: cada `url` aponta para o host de `STORAGE_PUBLIC_ENDPOINT`
    - expect: `expires_at` de cada parte é uma hora após a emissão

#### 1.2. rejects-part-number-outside-range

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. POST /videos/:public_id/upload-parts com `{ "part_numbers": [3] }` para um vídeo com `part_count: 2`
    - expect: `400` com `error: "INVALID_PART_NUMBER"`

#### 1.3. rejects-non-owner-with-not-found

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. POST /videos/:public_id/upload-parts autenticado como um segundo usuário (não o owner)
    - expect: `404` com `error: "VIDEO_NOT_FOUND"`, mesmo corpo de um `public_id` inexistente
  2. GET /videos/:public_id/upload-parts autenticado como o mesmo segundo usuário
    - expect: `404` com `error: "VIDEO_NOT_FOUND"`

#### 1.4. rejects-when-not-uploading

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. POST /videos/:public_id/upload-parts do owner para um vídeo cujo `processing_status` é `processing`
    - expect: `409` com `error: "UPLOAD_NOT_IN_PROGRESS"`
  2. GET /videos/:public_id/upload-parts do owner para o mesmo vídeo
    - expect: `409` com `error: "UPLOAD_NOT_IN_PROGRESS"`

### 2. GET /videos/:public_id/upload-parts

**Setup:** mesmo bootstrap da seção 1.

#### 2.1. lists-parts-already-stored-in-real-storage

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. POST /videos/:public_id/upload-parts do owner com `{ "part_numbers": [1] }` e em seguida um `PUT` real de 64 MiB na `url` retornada, contra o Garage
    - expect: o `PUT` é aceito pelo storage
  2. GET /videos/:public_id/upload-parts do owner
    - expect: `200` com uma entrada contendo `part_number: 1`, `etag` preenchido e `size_bytes: 67108864`
