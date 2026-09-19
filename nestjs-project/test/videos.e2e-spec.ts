import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { QUEUES } from '../src/queue/queue.constants';
import { StorageService } from '../src/storage/storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import { PART_SIZE_BYTES } from '../src/videos/videos.constants';

// Presigned part URLs must be reachable from wherever this test runs (the
// nestjs-api container); STORAGE_PUBLIC_ENDPOINT defaults to localhost:3900
// for real browsers on the host, which the container cannot reach —
// host.docker.internal routes back to the host. Restored in afterAll since
// process.env is a shared global across e2e spec files in the same run.
const ORIGINAL_STORAGE_PUBLIC_ENDPOINT = process.env.STORAGE_PUBLIC_ENDPOINT;
process.env.STORAGE_PUBLIC_ENDPOINT = 'http://host.docker.internal:3900';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;
  let videoProcessingQueue: Queue;
  let storageService: StorageService;
  let accessToken: string;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
    videoProcessingQueue = moduleFixture.get<Queue>(
      getQueueToken(QUEUES.VIDEO_PROCESSING),
    );
    storageService = moduleFixture.get(StorageService);
  });

  afterAll(async () => {
    await app.close();
    process.env.STORAGE_PUBLIC_ENDPOINT = ORIGINAL_STORAGE_PUBLIC_ENDPOINT;
  });

  async function captureConfirmationToken(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password });
    return capturedToken;
  }

  async function registerConfirmAndLogin(
    email: string,
    password = 'password123',
  ): Promise<string> {
    const token = await captureConfirmationToken(email, password);
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token });
    const res = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password });
    return res.body.access_token;
  }

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
    await videoProcessingQueue.obliterate({ force: true });
    accessToken = await registerConfirmAndLogin('video-owner@example.com');
  });

  async function initiateUpload(
    token: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ public_id: string; part_count: number }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'clip.mp4',
        size_bytes: PART_SIZE_BYTES * 2,
        content_type: 'video/mp4',
        ...overrides,
      });
    return res.body;
  }

  async function initiateSmallUpload(
    token: string,
  ): Promise<{ public_id: string }> {
    const res = await request(app.getHttpServer())
      .post('/videos')
      .set('Authorization', `Bearer ${token}`)
      .send({
        filename: 'clip.mp4',
        size_bytes: 1024,
        content_type: 'video/mp4',
      });
    return res.body;
  }

  async function uploadSinglePart(
    token: string,
    publicId: string,
  ): Promise<{ part_number: number; etag: string }> {
    const signed = await request(app.getHttpServer())
      .post(`/videos/${publicId}/upload-parts`)
      .set('Authorization', `Bearer ${token}`)
      .send({ part_numbers: [1] })
      .expect(200);

    const putResponse = await fetch(signed.body.parts[0].url, {
      method: 'PUT',
      body: Buffer.alloc(1024, 'a'),
    });
    expect(putResponse.status).toBe(200);

    return { part_number: 1, etag: putResponse.headers.get('etag')! };
  }

  async function seedReadyVideo(
    token: string,
    originalFilename = 'clip.mp4',
  ): Promise<{ public_id: string }> {
    const video = await initiateSmallUpload(token);
    const videoObjectKey = `videos/${video.public_id}/video.mp4`;

    await storageService.client.send(
      new PutObjectCommand({
        Bucket: storageService.bucket,
        Key: videoObjectKey,
        Body: Buffer.alloc(2048, 'a'),
        ContentType: 'video/mp4',
      }),
    );

    await dataSource.query(
      `UPDATE videos SET processing_status = 'ready', video_object_key = $1, original_filename = $2 WHERE public_id = $3`,
      [videoObjectKey, originalFilename, video.public_id],
    );

    return video;
  }

  describe('POST /videos', () => {
    it('creates-draft-video-and-opens-multipart-upload', async () => {
      const res = await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'clip.mp4',
          size_bytes: 104857600,
          content_type: 'video/mp4',
        })
        .expect(201);

      expect(res.body.public_id).toHaveLength(11);
      expect(res.body.processing_status).toBe('uploading');
      expect(res.body.part_size_bytes).toBe(67108864);
      expect(res.body.part_count).toBe(2);

      const video = await dataSource.query(
        'SELECT publication_status, user_id, upload_id FROM videos WHERE public_id = $1',
        [res.body.public_id],
      );
      expect(video).toHaveLength(1);
      expect(video[0].publication_status).toBe('draft');
      expect(video[0].upload_id).not.toBeNull();
    }, 30000);

    it('rejects-file-above-10gb', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'clip.mp4',
          size_bytes: 10737418241,
          content_type: 'video/mp4',
        })
        .expect(413)
        .expect((res) => {
          expect(res.body.error).toBe('UPLOAD_TOO_LARGE');
        });

      const videos = await dataSource.query('SELECT id FROM videos');
      expect(videos).toHaveLength(0);
    });

    it('rejects-unsupported-content-type', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          filename: 'clip.mkv',
          size_bytes: 104857600,
          content_type: 'video/x-matroska',
        })
        .expect(415)
        .expect((res) => {
          expect(res.body.error).toBe('UNSUPPORTED_MEDIA_TYPE');
        });
    });

    it('rejects-missing-filename', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ size_bytes: 104857600, content_type: 'video/mp4' })
        .expect(400)
        .expect((res) => {
          expect(res.body.error).toBe('VALIDATION_ERROR');
        });
    });

    it('rejects-missing-access-token', async () => {
      await request(app.getHttpServer())
        .post('/videos')
        .send({
          filename: 'clip.mp4',
          size_bytes: 104857600,
          content_type: 'video/mp4',
        })
        .expect(401);
    });

    it('allows-burst-of-eleven-requests-without-rate-limiting', async () => {
      for (let i = 0; i < 11; i++) {
        const res = await request(app.getHttpServer())
          .post('/videos')
          .set('Authorization', `Bearer ${accessToken}`)
          .send({
            filename: `clip-${i}.mp4`,
            size_bytes: 104857600,
            content_type: 'video/mp4',
          });
        expect(res.status).not.toBe(429);
      }
    }, 30000);
  });

  describe('POST /videos/:public_id/upload-parts', () => {
    it('signs-requested-part-urls', async () => {
      const video = await initiateUpload(accessToken);

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload-parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [1, 2] })
        .expect(200);

      expect(res.body.parts).toHaveLength(2);
      const issuedAt = Date.now();
      for (const part of res.body.parts) {
        expect(new URL(part.url).host).toBe('host.docker.internal:3900');
        const expiresAt = new Date(part.expires_at).getTime();
        expect(expiresAt).toBeGreaterThan(issuedAt + 3599_000);
        expect(expiresAt).toBeLessThanOrEqual(issuedAt + 3600_000 + 5000);
      }
    });

    it('rejects-part-number-outside-range', async () => {
      const video = await initiateUpload(accessToken); // part_count: 2

      await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload-parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [3] })
        .expect(400)
        .expect((res) => {
          expect(res.body.error).toBe('INVALID_PART_NUMBER');
        });
    });

    it('rejects-non-owner-with-not-found', async () => {
      const video = await initiateUpload(accessToken);
      const otherToken = await registerConfirmAndLogin(
        'video-intruder@example.com',
      );

      await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload-parts`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ part_numbers: [1] })
        .expect(404)
        .expect((res) => {
          expect(res.body.error).toBe('VIDEO_NOT_FOUND');
        });

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/upload-parts`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404)
        .expect((res) => {
          expect(res.body.error).toBe('VIDEO_NOT_FOUND');
        });
    });

    it('rejects-when-not-uploading', async () => {
      const video = await initiateUpload(accessToken);
      await dataSource.query(
        "UPDATE videos SET processing_status = 'processing' WHERE public_id = $1",
        [video.public_id],
      );

      await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload-parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [1] })
        .expect(409)
        .expect((res) => {
          expect(res.body.error).toBe('UPLOAD_NOT_IN_PROGRESS');
        });

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/upload-parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409)
        .expect((res) => {
          expect(res.body.error).toBe('UPLOAD_NOT_IN_PROGRESS');
        });
    });
  });

  describe('GET /videos/:public_id/upload-parts', () => {
    it('lists-parts-already-stored-in-real-storage', async () => {
      const video = await initiateUpload(accessToken);

      const signed = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload-parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [1] })
        .expect(200);

      const partBody = Buffer.alloc(PART_SIZE_BYTES, 'a');
      const putResponse = await fetch(signed.body.parts[0].url, {
        method: 'PUT',
        body: partBody,
      });
      expect(putResponse.status).toBe(200);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/upload-parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.parts).toHaveLength(1);
      expect(res.body.parts[0].part_number).toBe(1);
      expect(res.body.parts[0].etag).toBeDefined();
      expect(res.body.parts[0].size_bytes).toBe(PART_SIZE_BYTES);
    }, 30000);
  });

  describe('POST /videos/:public_id/upload-completion', () => {
    it('completes-upload-and-enqueues-processing', async () => {
      const video = await initiateSmallUpload(accessToken);
      const part = await uploadSinglePart(accessToken, video.public_id);

      const res = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload-completion`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [part] })
        .expect(202);

      expect(res.body).toEqual({
        public_id: video.public_id,
        processing_status: 'processing',
      });

      const rows = await dataSource.query(
        'SELECT id, processing_status, upload_completed_at, upload_id FROM videos WHERE public_id = $1',
        [video.public_id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].processing_status).toBe('processing');
      expect(rows[0].upload_completed_at).not.toBeNull();
      expect(rows[0].upload_id).toBeNull();

      const job = await videoProcessingQueue.getJob(rows[0].id);
      expect(job).toBeDefined();
      expect(job!.data).toEqual({ videoId: rows[0].id });
    }, 30000);

    it('rejects-incomplete-parts', async () => {
      const video = await initiateUpload(accessToken); // part_count: 2

      const signed = await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload-parts`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ part_numbers: [1] })
        .expect(200);
      const putResponse = await fetch(signed.body.parts[0].url, {
        method: 'PUT',
        body: Buffer.alloc(PART_SIZE_BYTES, 'a'),
      });
      const etag = putResponse.headers.get('etag')!;

      await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload-completion`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [{ part_number: 1, etag }] })
        .expect(422)
        .expect((res) => {
          expect(res.body.error).toBe('UPLOAD_INCOMPLETE');
        });

      const rows = await dataSource.query(
        'SELECT processing_status FROM videos WHERE public_id = $1',
        [video.public_id],
      );
      expect(rows[0].processing_status).toBe('uploading');
    }, 30000);

    it('rejects-repeated-completion', async () => {
      const video = await initiateSmallUpload(accessToken);
      const part = await uploadSinglePart(accessToken, video.public_id);

      await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload-completion`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [part] })
        .expect(202);

      await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload-completion`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ parts: [part] })
        .expect(409)
        .expect((res) => {
          expect(res.body.error).toBe('UPLOAD_NOT_IN_PROGRESS');
        });

      const counts = await videoProcessingQueue.getJobCounts(
        'waiting',
        'active',
        'delayed',
      );
      expect(counts.waiting + counts.active + counts.delayed).toBe(1);
    }, 30000);

    it('rejects-non-owner-with-not-found', async () => {
      const video = await initiateSmallUpload(accessToken);
      const otherToken = await registerConfirmAndLogin(
        'video-completion-intruder@example.com',
      );

      await request(app.getHttpServer())
        .post(`/videos/${video.public_id}/upload-completion`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ parts: [{ part_number: 1, etag: '"whatever"' }] })
        .expect(404)
        .expect((res) => {
          expect(res.body.error).toBe('VIDEO_NOT_FOUND');
        });
    });
  });

  describe('GET /videos/:public_id', () => {
    it('returns-draft-status-for-freshly-created-video', async () => {
      const video = await initiateSmallUpload(accessToken);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.processing_status).toBe('uploading');
      expect(res.body.publication_status).toBe('draft');
      expect(res.body.failure_code).toBeNull();
      expect(res.body.duration_seconds).toBeNull();
    });

    it('returns-processed-metadata-when-ready', async () => {
      const video = await initiateSmallUpload(accessToken);
      await dataSource.query(
        `UPDATE videos SET processing_status = 'ready', duration_seconds = 12.345,
          width = 1920, height = 1080, video_codec = 'h264', audio_codec = 'aac',
          processed_at = now() WHERE public_id = $1`,
        [video.public_id],
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.duration_seconds).toBe(12.345);
      expect(res.body.width).toBe(1920);
      expect(res.body.height).toBe(1080);
      expect(res.body.video_codec).toBe('h264');
      expect(res.body.processed_at).not.toBeNull();
    });

    it('returns-failure-code-when-failed', async () => {
      const video = await initiateSmallUpload(accessToken);
      await dataSource.query(
        `UPDATE videos SET processing_status = 'failed', failure_code = 'UNSUPPORTED_CODEC', failed_at = now() WHERE public_id = $1`,
        [video.public_id],
      );

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body.failure_code).toBe('UNSUPPORTED_CODEC');
    });

    it('omits-internal-fields-from-response-body', async () => {
      const video = await initiateSmallUpload(accessToken);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(res.body).not.toHaveProperty('id');
      expect(res.body).not.toHaveProperty('user_id');
      expect(res.body).not.toHaveProperty('upload_id');
      expect(res.body).not.toHaveProperty('source_object_key');
      expect(res.body).not.toHaveProperty('video_object_key');
      expect(res.body).not.toHaveProperty('thumbnail_object_key');
    });

    it('rejects-non-owner-and-missing-token', async () => {
      const video = await initiateSmallUpload(accessToken);
      const otherToken = await registerConfirmAndLogin(
        'video-detail-intruder@example.com',
      );

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404)
        .expect((res) => {
          expect(res.body.error).toBe('VIDEO_NOT_FOUND');
        });

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}`)
        .expect(401);
    });
  });

  describe('GET /videos/:public_id/playback-url', () => {
    it('signs-playback-url-with-range-support', async () => {
      const video = await seedReadyVideo(accessToken);

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/playback-url`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const url = new URL(res.body.url);
      expect(url.host).toBe('host.docker.internal:3900');
      expect(url.searchParams.get('X-Amz-Expires')).toBe('21600');

      const issuedAt = Date.now();
      const expiresAt = new Date(res.body.expires_at).getTime();
      expect(expiresAt - issuedAt).toBeGreaterThan(21600 * 1000 - 5000);
      expect(expiresAt - issuedAt).toBeLessThan(21600 * 1000 + 5000);

      const rangeRes = await fetch(res.body.url, {
        headers: { Range: 'bytes=0-1023' },
      });
      expect(rangeRes.status).toBe(206);
      const body = await rangeRes.arrayBuffer();
      expect(body.byteLength).toBe(1024);
    }, 30000);

    it('rejects-when-not-ready', async () => {
      const video = await initiateSmallUpload(accessToken);
      await dataSource.query(
        `UPDATE videos SET processing_status = 'processing' WHERE public_id = $1`,
        [video.public_id],
      );

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/playback-url`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409)
        .expect((res) => {
          expect(res.body.error).toBe('VIDEO_NOT_READY');
        });
    });

    it('rejects-non-owner-with-not-found', async () => {
      const video = await seedReadyVideo(accessToken);
      const otherToken = await registerConfirmAndLogin(
        'playback-url-intruder@example.com',
      );

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/playback-url`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404)
        .expect((res) => {
          expect(res.body.error).toBe('VIDEO_NOT_FOUND');
        });
    });
  });

  describe('GET /videos/:public_id/download-url', () => {
    it('signs-download-url-with-content-disposition', async () => {
      const video = await seedReadyVideo(accessToken, 'clip.mov');

      const res = await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download-url`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const issuedAt = Date.now();
      const expiresAt = new Date(res.body.expires_at).getTime();
      expect(expiresAt - issuedAt).toBeGreaterThan(900 * 1000 - 5000);
      expect(expiresAt - issuedAt).toBeLessThan(900 * 1000 + 5000);

      const downloadRes = await fetch(res.body.url);
      expect(downloadRes.headers.get('content-disposition')).toBe(
        'attachment; filename="clip.mp4"',
      );
    }, 30000);

    it('rejects-when-not-ready', async () => {
      const video = await initiateSmallUpload(accessToken);
      await dataSource.query(
        `UPDATE videos SET processing_status = 'processing' WHERE public_id = $1`,
        [video.public_id],
      );

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download-url`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(409)
        .expect((res) => {
          expect(res.body.error).toBe('VIDEO_NOT_READY');
        });
    });

    it('rejects-non-owner-with-not-found', async () => {
      const video = await seedReadyVideo(accessToken);
      const otherToken = await registerConfirmAndLogin(
        'download-url-intruder@example.com',
      );

      await request(app.getHttpServer())
        .get(`/videos/${video.public_id}/download-url`)
        .set('Authorization', `Bearer ${otherToken}`)
        .expect(404)
        .expect((res) => {
          expect(res.body.error).toBe('VIDEO_NOT_FOUND');
        });
    });
  });
});
