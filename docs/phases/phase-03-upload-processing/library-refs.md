---
libs:
  "@aws-sdk/client-s3":
    version: "^3.1132.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-15T09:16:18+01:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1132.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-09-15T09:16:18+01:00"
  "bullmq":
    version: "^6.3.6"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-09-15T09:16:18+01:00"
  "@nestjs/bullmq":
    version: "^12.0.0"
    context7_id: "/nestjs/bull"
    fetched_at: "2026-09-15T09:16:18+01:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-upload-processing.md: "2026-09-15T09:13:06+01:00"
---

# Library References

Distilled Context7 excerpts for the libraries decided in `phase-03-upload-processing`. Versions are the latest published on npm at fetch time (none is installed in `nestjs-project/package.json` yet). Peer-dependency check: `@nestjs/bullmq@12.0.0` declares `@nestjs/common`/`@nestjs/core` `^10 || ^11 || ^12` and `bullmq` `^3 || ^4 || ^5 || ^6` — compatible with the project's NestJS 11.

### @aws-sdk/client-s3

**Used by:** `phase-03-upload-processing/TD-01` (Garage via S3 API), `TD-02` (dual endpoint), `TD-03` (multipart), `TD-05` (completion + cleanup), `TD-12` (media access).

**Client for S3-compatible endpoints.** Garage has no wildcard DNS for bucket subdomains, so `forcePathStyle: true` is required (default `false` puts the bucket in the hostname). `region` must still be set (Garage accepts any configured region name).

```typescript
import { S3Client } from '@aws-sdk/client-s3';

// Internal client — server-side ops (Docker service name, per CLAUDE.md networking rule)
const s3 = new S3Client({
  endpoint: config.endpoint,          // STORAGE_ENDPOINT, e.g. http://storage:3900
  region: config.region,
  forcePathStyle: true,
  credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
});

// Public client — used ONLY by the presigner (TD-02)
const s3Public = new S3Client({ ...sameOptions, endpoint: config.publicEndpoint }); // STORAGE_PUBLIC_ENDPOINT
```

**Multipart flow (TD-03 / TD-05), all via `client.send(new XCommand(input))`:**

| Step | Command | Key input | Key output |
|------|---------|-----------|------------|
| Initiate (API) | `CreateMultipartUploadCommand` | `Bucket`, `Key` (required), `ContentType` | `UploadId` |
| Upload part (browser, presigned) | `UploadPartCommand` | `Bucket`, `Key`, `UploadId`, `PartNumber` | `ETag` response header |
| Resume (API) | `ListPartsCommand` | `Bucket`, `Key`, `UploadId` | `Parts[]` (`PartNumber`, `ETag`, `Size`) |
| Complete (API) | `CompleteMultipartUploadCommand` | `Bucket`, `Key`, `UploadId`, `MultipartUpload: { Parts: [{ ETag, PartNumber }] }` | `ETag`, `Location` |
| Abort (API) | `AbortMultipartUploadCommand` | `Bucket`, `Key`, `UploadId` | — |
| Validate size (API, TD-05) | `HeadObjectCommand` | `Bucket`, `Key` | `ContentLength`, `ContentType`, `ETag` |
| Cleanup (TD-05) | `DeleteObjectCommand` | `Bucket`, `Key` | — |

S3 limits relevant to TD-03 revision (10 GiB ceiling, 64 MiB parts → 160 parts): min part size 5 MiB (except the last part), max 10,000 parts, `PartNumber` 1–10,000.

**Size enforcement:** a presigned `UploadPart` URL cannot cap total size — validate declared size at initiation, then `HeadObjectCommand.ContentLength` at completion (TD-03 cons).

**Lifecycle rule (TD-01 revision — abort incomplete uploads after 1 day), applied at bucket bootstrap:**

```typescript
import { PutBucketLifecycleConfigurationCommand } from '@aws-sdk/client-s3';

await s3.send(new PutBucketLifecycleConfigurationCommand({
  Bucket: bucket,
  LifecycleConfiguration: {
    Rules: [{
      ID: 'abort-incomplete-multipart',
      Status: 'Enabled',
      Filter: { Prefix: '' },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    }],
  },
}));
```

**Download disposition (TD-12):** `GetObjectCommand` accepts `ResponseContentDisposition` (also `ResponseContentType`, `ResponseCacheControl`, `ResponseExpires`), which S3 echoes as the response header when the URL is presigned — e.g. `ResponseContentDisposition: 'attachment; filename="video.mp4"'`.

### @aws-sdk/s3-request-presigner

**Used by:** `phase-03-upload-processing/TD-02`, `TD-03`, `TD-12`.

```typescript
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { UploadPartCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// Part URL — TTL 1 h (TD-03 revision)
const partUrl = await getSignedUrl(
  s3Public,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }),
  { expiresIn: 3600 },
);

// Playback URL — TTL 6 h (TD-12 revision)
const playbackUrl = await getSignedUrl(s3Public, new GetObjectCommand({ Bucket, Key }), { expiresIn: 21600 });

// Download URL — TTL 15 min + attachment (TD-12 revision)
const downloadUrl = await getSignedUrl(
  s3Public,
  new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: `attachment; filename="${fileName}"` }),
  { expiresIn: 900 },
);
```

- `getSignedUrl(client, command, options)` — `options.expiresIn` in seconds; **default 900 s** when omitted. Always pass it explicitly.
- The presigner builds the signature from the client's `endpoint` (host is part of the signed request) — it **must** be the public-endpoint client (TD-02), otherwise the browser receives a URL pointing to `storage:3900` or a signature mismatch after host rewriting.
- The browser must read each part's `ETag` header → bucket CORS must allow the FE origin, method `PUT`, and `ExposeHeaders: ['ETag']` (TD-02). Verification item: integration test that presigns via the public endpoint.

### bullmq

**Used by:** `phase-03-upload-processing/TD-07` (queue semantics), `TD-08` (separate worker process), `TD-05` (scheduled cleanup).

**Retries (TD-07 revision — 3 attempts, exponential backoff):**

```typescript
await queue.add('process-video', { videoId }, {
  jobId: videoId,                                  // idempotent enqueue — duplicate jobId is ignored
  attempts: 3,
  backoff: { type: 'exponential', delay: 1000 },   // 1 s, 2 s, 4 s …
});
```

Alternative dedup mechanism: `deduplication: { id }` (simple mode deduplicates until the job completes or fails; `ttl` enables throttle mode).

**Locks and stalled jobs (verification item for the 10 GB faststart remux):**

- A worker holds a lock for `lockDuration` (default 30 s), renewed every `lockRenewTime` (≈ half of `lockDuration`).
- If the lock is not renewed in time the job is considered **stalled** and restarted — delivery is *at least once*, so the processor must be idempotent (status guard per TD-07).
- Renewal fails when the Node event loop is blocked. FFmpeg runs in a child process (`spawn`, TD-09), so the loop stays free; still raise `lockDuration` for long jobs and keep awaits non-blocking.
- `maxStalledCount` (default 1) caps stalled-recovery restarts; listen to the `stalled` event and log it.
- Manual extension when needed: `await job.extendLock(token, ms)`.

**Scheduled cleanup (TD-05 revision — purge `uploading` drafts after 24 h, failed originals after 7 days).** BullMQ v6 replaces legacy repeatable jobs with job schedulers:

```typescript
await queue.upsertJobScheduler(
  'purge-stale-uploads',                 // scheduler id (upsert = idempotent at boot)
  { pattern: '0 0 * * * *' },            // cron (with seconds) — or { every: ms }
  { name: 'purge-stale-uploads', data: {}, opts: { attempts: 3, backoff: 3000 } },
);
```

### @nestjs/bullmq

**Used by:** `phase-03-upload-processing/TD-07`, `TD-08`.

**Root connection from config** (fits the `phase-01-configuracao-base` convention: a `queue.config.ts` namespace + Joi keys):

```typescript
import { BullModule } from '@nestjs/bullmq';

BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) => ({
    connection: {
      host: config.get('REDIS_HOST'),   // Compose service name, never localhost
      port: config.get('REDIS_PORT'),
    },
  }),
}),
```

**Producer side (API):**

```typescript
BullModule.registerQueue({ name: 'video-processing' });

@Injectable()
export class VideoProcessingProducer {
  constructor(@InjectQueue('video-processing') private readonly queue: Queue) {}
}
```

**Consumer side (worker entrypoint only — TD-08):**

```typescript
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing', { concurrency: 2, lockDuration: 60000, maxStalledCount: 3 })
export class VideoProcessor extends WorkerHost {
  async process(job: Job<{ videoId: string }>) {
    // probe → thumbnail → optional remux
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job, error: Error) {}
}
```

- The second argument of `@Processor` takes BullMQ `WorkerOptions` (`concurrency`, `lockDuration`, `maxStalledCount`, …).
- Per TD-08 A, register processor providers only in the worker's root module; the API module registers the queue (producer) but no `@Processor` class, so the API process never consumes jobs.
