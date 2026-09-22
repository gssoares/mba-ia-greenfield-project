---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.8
target_file: test/videos.e2e-spec.ts
---

# GET /videos/:public_id Test Plan

## Application Overview

This endpoint lets the owner track processing state and read the metadata extracted by the worker — the polling surface a client uses to follow `uploading → processing → ready | failed` after the `202` from upload completion.

## Test Scenarios

### 1. GET /videos/:public_id

**Setup:** same bootstrap as `videos-upload-initiate.plan.md` §1, plus a video created via `POST /videos` for the freshly-created case, and a video row seeded directly for the `ready`/`failed` cases (bypassing the full upload+worker flow, since only the read contract is under test here).

#### 1.1. returns-draft-status-for-freshly-created-video

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. GET /videos/:public_id do owner logo após `POST /videos`
    - expect: `200` com `processing_status: "uploading"`, `publication_status: "draft"`, `failure_code: null` e `duration_seconds: null`

#### 1.2. returns-processed-metadata-when-ready

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. GET /videos/:public_id do owner para um vídeo com `processing_status = 'ready'`
    - expect: `200` com `duration_seconds`, `width`, `height`, `video_codec` e `processed_at` preenchidos

#### 1.3. returns-failure-code-when-failed

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. GET /videos/:public_id do owner para um vídeo com `processing_status = 'failed'` e um `failure_code` gravado
    - expect: `200` com o mesmo `failure_code` gravado pelo worker

#### 1.4. omits-internal-fields-from-response-body

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. GET /videos/:public_id do owner
    - expect: o corpo da resposta não contém `id`, `user_id`, `upload_id`, `source_object_key`, `video_object_key` nem `thumbnail_object_key`

#### 1.5. rejects-non-owner-and-missing-token

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. GET /videos/:public_id autenticado como um segundo usuário (não o owner)
    - expect: `404` com `error: "VIDEO_NOT_FOUND"`
  2. GET /videos/:public_id sem header `Authorization`
    - expect: `401`
