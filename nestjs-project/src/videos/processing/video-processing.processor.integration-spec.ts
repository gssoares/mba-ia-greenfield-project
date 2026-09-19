import { exec as execCallback } from 'child_process';
import { promisify } from 'util';
import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import queueConfig from '../../config/queue.config';
import storageConfig from '../../config/storage.config';
import { JOBS, QUEUES } from '../../queue/queue.constants';
import { QueueModule } from '../../queue/queue.module';
import { StorageModule } from '../../storage/storage.module';
import { StorageService } from '../../storage/storage.service';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { generatePublicId } from '../public-id.util';
import { FfmpegService } from './ffmpeg.service';
import { VideoProcessingProcessor } from './video-processing.processor';

const exec = promisify(execCallback);
const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for condition`);
}

describe('VideoProcessingProcessor (integration)', () => {
  let module: TestingModule;
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let videoProcessingQueue: Queue;
  let user: User;
  let tempDir: string;
  let h264AacFixture: string;
  let vp9Fixture: string;

  beforeAll(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'processor-fixtures-'));
    h264AacFixture = path.join(tempDir, 'h264-aac.mp4');
    vp9Fixture = path.join(tempDir, 'vp9.webm');

    await exec(
      `ffmpeg -y -f lavfi -i testsrc=duration=2:size=640x360:rate=25 ` +
        `-f lavfi -i sine=frequency=1000:duration=2 ` +
        `-c:v libx264 -c:a aac -shortest "${h264AacFixture}"`,
    );
    await exec(
      `ffmpeg -y -f lavfi -i testsrc=duration=1:size=640x360:rate=25 ` +
        `-c:v libvpx-vp9 -an "${vp9Fixture}"`,
    );

    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig, storageConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        TypeOrmModule.forFeature([Video]),
        QueueModule,
        StorageModule,
      ],
      providers: [FfmpegService, VideoProcessingProcessor],
    }).compile();
    // .compile() alone only builds the DI container — it does not run
    // onModuleInit, which is what @nestjs/bullmq uses to discover
    // @Processor classes and start their underlying Worker.
    await module.init();

    dataSource = module.get(DataSource);
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    storageService = module.get(StorageService);
    videoProcessingQueue = module.get<Queue>(
      getQueueToken(QUEUES.VIDEO_PROCESSING),
    );
  }, 60000);

  afterAll(async () => {
    await module.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await videoProcessingQueue.obliterate({ force: true });
    user = await userRepository.save(
      userRepository.create({
        email: 'video-worker@example.com',
        password: 'hashed',
      }),
    );
  });

  async function createProcessingVideo(
    fixturePath: string | null,
    overrides: Partial<Video> = {},
  ): Promise<Video> {
    const publicId = generatePublicId();
    const sourceObjectKey = `videos/${publicId}/original`;
    const sizeBytes = fixturePath ? (await fs.stat(fixturePath)).size : 1024;

    const video = await videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        user_id: user.id,
        original_filename: 'clip',
        content_type: 'video/mp4',
        size_bytes: sizeBytes,
        source_object_key: sourceObjectKey,
        processing_status: 'processing',
        ...overrides,
      }),
    );

    if (fixturePath) {
      await storageService.client.send(
        new PutObjectCommand({
          Bucket: storageService.bucket,
          Key: video.source_object_key,
          Body: createReadStream(fixturePath),
          ContentLength: sizeBytes,
        }),
      );
    }

    return video;
  }

  it('processes an h264/aac upload through to ready, uploads outputs and deletes the original', async () => {
    const video = await createProcessingVideo(h264AacFixture);

    await videoProcessingQueue.add(
      JOBS.PROCESS_VIDEO,
      { videoId: video.id },
      { jobId: video.id },
    );

    await waitUntil(async () => {
      const row = await videoRepository.findOneBy({ id: video.id });
      return row?.processing_status !== 'processing';
    }, 30000);

    const updated = await videoRepository.findOneBy({ id: video.id });
    expect(updated?.processing_status).toBe('ready');
    expect(updated?.video_codec).toBe('h264');
    expect(updated?.audio_codec).toBe('aac');
    expect(updated?.width).toBe(640);
    expect(updated?.height).toBe(360);
    expect(updated?.duration_seconds).not.toBeNull();
    expect(updated?.processed_at).not.toBeNull();
    expect(updated?.video_object_key).toBe(`videos/${video.public_id}/video.mp4`);
    expect(updated?.thumbnail_object_key).toBe(
      `videos/${video.public_id}/thumbnail.jpg`,
    );

    const videoHead = await storageService.client.send(
      new HeadObjectCommand({
        Bucket: storageService.bucket,
        Key: updated!.video_object_key!,
      }),
    );
    expect(videoHead.ContentLength).toBeGreaterThan(0);

    const thumbnailHead = await storageService.client.send(
      new HeadObjectCommand({
        Bucket: storageService.bucket,
        Key: updated!.thumbnail_object_key!,
      }),
    );
    expect(thumbnailHead.ContentLength).toBeGreaterThan(0);

    await expect(
      storageService.client.send(
        new HeadObjectCommand({
          Bucket: storageService.bucket,
          Key: video.source_object_key,
        }),
      ),
    ).rejects.toThrow();
  }, 60000);

  it('fails a vp9 upload with UNSUPPORTED_CODEC after a single attempt', async () => {
    const video = await createProcessingVideo(vp9Fixture, {
      content_type: 'video/webm',
    });

    await videoProcessingQueue.add(
      JOBS.PROCESS_VIDEO,
      { videoId: video.id },
      { jobId: video.id },
    );

    await waitUntil(async () => {
      const row = await videoRepository.findOneBy({ id: video.id });
      return row?.processing_status === 'failed';
    }, 30000);

    const updated = await videoRepository.findOneBy({ id: video.id });
    expect(updated?.processing_status).toBe('failed');
    expect(updated?.failure_code).toBe('UNSUPPORTED_CODEC');
    expect(updated?.failed_at).not.toBeNull();

    const finishedJob = await videoProcessingQueue.getJob(video.id);
    expect(finishedJob?.attemptsMade).toBe(1);
  }, 30000);

  it('marks a video failed with PROCESSING_FAILED only after the 3rd attempt of a recoverable error', async () => {
    const video = await createProcessingVideo(null);

    await videoProcessingQueue.add(
      JOBS.PROCESS_VIDEO,
      { videoId: video.id },
      { jobId: video.id, attempts: 3, backoff: { type: 'fixed', delay: 50 } },
    );

    await waitUntil(async () => {
      const row = await videoRepository.findOneBy({ id: video.id });
      return row?.processing_status === 'failed';
    }, 30000);

    const updated = await videoRepository.findOneBy({ id: video.id });
    expect(updated?.processing_status).toBe('failed');
    expect(updated?.failure_code).toBe('PROCESSING_FAILED');

    const finishedJob = await videoProcessingQueue.getJob(video.id);
    expect(finishedJob?.attemptsMade).toBe(3);
  }, 30000);

  it('does not alter a video that is already ready', async () => {
    const video = await createProcessingVideo(h264AacFixture, {
      processing_status: 'ready',
      video_object_key: 'videos/already-ready/video.mp4',
      thumbnail_object_key: 'videos/already-ready/thumbnail.jpg',
    });

    const job = await videoProcessingQueue.add(
      JOBS.PROCESS_VIDEO,
      { videoId: video.id },
      { jobId: video.id },
    );

    await waitUntil(async () => {
      const state = await job.getState();
      return state === 'completed';
    }, 15000);

    const updated = await videoRepository.findOneBy({ id: video.id });
    expect(updated?.processing_status).toBe('ready');
    expect(updated?.video_object_key).toBe('videos/already-ready/video.mp4');
    expect(updated?.thumbnail_object_key).toBe(
      'videos/already-ready/thumbnail.jpg',
    );
  }, 20000);
});
