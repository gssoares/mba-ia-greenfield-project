---
subproject: backend
runner: jest+supertest
scope: phase-03-upload-processing
si: SI-03.10
target_file: test/videos.e2e-spec.ts
---

# GET /videos/:public_id/playback-url|download-url Test Plan

## Application Overview

These endpoints emit short-lived signed URLs for progressive playback and download of a processed video, so media bytes never pass through the Node server — playback and download are handled entirely by the object storage.

## Test Scenarios

### 1. GET /videos/:public_id/playback-url

**Setup:** same bootstrap as `videos-upload-initiate.plan.md` §1, plus a video driven through the full upload + worker pipeline to `processing_status = 'ready'` with a real `video_object_key` in the Garage storage (or seeded directly with a real object uploaded to that key, when the worker path is exercised elsewhere).

#### 1.1. signs-playback-url-with-range-support

**Covers AC:** #1, #2
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. GET /videos/:public_id/playback-url do owner para um vídeo `ready`
    - expect: `200` com `url` no host de `STORAGE_PUBLIC_ENDPOINT`, `X-Amz-Expires=21600` na query string e `expires_at` seis horas após a emissão
  2. GET real na `url` retornada com header `Range: bytes=0-1023`
    - expect: `206 Partial Content` com 1024 bytes

#### 1.2. rejects-when-not-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. GET /videos/:public_id/playback-url do owner para um vídeo com `processing_status = 'processing'`
    - expect: `409` com `error: "VIDEO_NOT_READY"`

#### 1.3. rejects-non-owner-with-not-found

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. GET /videos/:public_id/playback-url autenticado como um segundo usuário (não o owner)
    - expect: `404` com `error: "VIDEO_NOT_FOUND"`

### 2. GET /videos/:public_id/download-url

**Setup:** mesmo bootstrap da seção 1.

#### 2.1. signs-download-url-with-content-disposition

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. GET /videos/:public_id/download-url do owner para um vídeo `ready` cujo `original_filename` foi enviado como `clip.mov`
    - expect: `200` com `expires_at` 15 minutos após a emissão
  2. GET real na `url` retornada
    - expect: header `Content-Disposition: attachment; filename="clip.mp4"`

#### 2.2. rejects-when-not-ready

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. GET /videos/:public_id/download-url do owner para um vídeo com `processing_status = 'processing'`
    - expect: `409` com `error: "VIDEO_NOT_READY"`

#### 2.3. rejects-non-owner-with-not-found

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-09-17T00:00:00Z

**Steps:**
  1. GET /videos/:public_id/download-url autenticado como um segundo usuário (não o owner)
    - expect: `404` com `error: "VIDEO_NOT_FOUND"`
