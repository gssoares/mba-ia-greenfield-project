import {
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../channels/entities/channel.entity';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { QUEUES } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { User } from '../users/entities/user.entity';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';
import { PART_SIZE_BYTES } from './videos.constants';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

function createVideoProcessingQueue(): Queue {
  const config = queueConfig();
  return new Queue(QUEUES.VIDEO_PROCESSING, {
    connection: { host: config.redisHost, port: config.redisPort },
  });
}

describe('VideosService.initiateUpload (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let videoProcessingQueue: Queue;
  let videosService: VideosService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    storageService = new StorageService(storageConfig());
    videoProcessingQueue = createVideoProcessingQueue();
    videosService = new VideosService(
      videoRepository,
      storageService,
      dataSource,
      videoProcessingQueue,
    );
  });

  afterAll(async () => {
    await videoProcessingQueue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  it('creates the videos row and a real multipart upload accepted by Garage', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: 'upload-initiate@example.com',
        password: 'hashed',
      }),
    );

    const result = await videosService.initiateUpload(user.id, {
      filename: 'clip.mp4',
      size_bytes: 104857600,
      content_type: 'video/mp4',
    });

    expect(result.public_id).toHaveLength(11);
    expect(result.processing_status).toBe('uploading');
    expect(result.part_count).toBe(2);

    const saved = await videoRepository.findOne({
      where: { public_id: result.public_id },
      select: [
        'id',
        'public_id',
        'user_id',
        'publication_status',
        'processing_status',
        'source_object_key',
        'upload_id',
      ],
    });
    expect(saved).toBeDefined();
    expect(saved!.user_id).toBe(user.id);
    expect(saved!.publication_status).toBe('draft');
    expect(saved!.source_object_key).toBe(
      `videos/${result.public_id}/original`,
    );
    expect(saved!.upload_id).toBeDefined();

    const { Parts } = await storageService.client.send(
      new ListPartsCommand({
        Bucket: storageService.bucket,
        Key: saved!.source_object_key,
        UploadId: saved!.upload_id!,
      }),
    );
    expect(Parts ?? []).toHaveLength(0);
  }, 30000);
});

describe('VideosService.signUploadParts + listUploadedParts (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let videoProcessingQueue: Queue;
  let videosService: VideosService;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    storageService = new StorageService({
      ...storageConfig(),
      // Presigned URLs must be reachable from wherever this test runs (the
      // nestjs-api container); STORAGE_PUBLIC_ENDPOINT defaults to
      // localhost:3900 for real browsers on the host, which the container
      // cannot reach — host.docker.internal routes back to the host.
      publicEndpoint: 'http://host.docker.internal:3900',
    });
    videoProcessingQueue = createVideoProcessingQueue();
    videosService = new VideosService(
      videoRepository,
      storageService,
      dataSource,
      videoProcessingQueue,
    );
  });

  afterAll(async () => {
    await videoProcessingQueue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  it('signs part 1, accepts a real PUT against Garage, and lists it back with part_number, etag and size_bytes', async () => {
    const user = await userRepository.save(
      userRepository.create({
        email: 'upload-parts@example.com',
        password: 'hashed',
      }),
    );

    const initiated = await videosService.initiateUpload(user.id, {
      filename: 'clip.mp4',
      size_bytes: 104857600,
      content_type: 'video/mp4',
    });

    const { parts } = await videosService.signUploadParts(
      user.id,
      initiated.public_id,
      [1],
    );
    expect(parts).toHaveLength(1);
    expect(new URL(parts[0].url).host).toBe('host.docker.internal:3900');

    const partBody = Buffer.alloc(PART_SIZE_BYTES, 'a');
    const putResponse = await fetch(parts[0].url, {
      method: 'PUT',
      body: partBody,
    });
    expect(putResponse.status).toBe(200);

    const { parts: uploaded } = await videosService.listUploadedParts(
      user.id,
      initiated.public_id,
    );
    expect(uploaded).toEqual([
      {
        part_number: 1,
        etag: expect.any(String) as string,
        size_bytes: PART_SIZE_BYTES,
      },
    ]);
  }, 60000);
});

describe('VideosService.completeUpload (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let videoProcessingQueue: Queue;
  let videosService: VideosService;
  let user: User;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    storageService = new StorageService({
      ...storageConfig(),
      publicEndpoint: 'http://host.docker.internal:3900',
    });
    videoProcessingQueue = createVideoProcessingQueue();
    videosService = new VideosService(
      videoRepository,
      storageService,
      dataSource,
      videoProcessingQueue,
    );
  });

  afterEach(async () => {
    await videoProcessingQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await videoProcessingQueue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    user = await userRepository.save(
      userRepository.create({
        email: 'upload-completion@example.com',
        password: 'hashed',
      }),
    );
  });

  async function initiateAndUploadSinglePart(
    sizeBytes = 1024,
  ): Promise<{ public_id: string; id: string; etag: string }> {
    const initiated = await videosService.initiateUpload(user.id, {
      filename: 'clip.mp4',
      size_bytes: sizeBytes,
      content_type: 'video/mp4',
    });

    const { parts } = await videosService.signUploadParts(
      user.id,
      initiated.public_id,
      [1],
    );
    const putResponse = await fetch(parts[0].url, {
      method: 'PUT',
      body: Buffer.alloc(sizeBytes, 'a'),
    });
    expect(putResponse.status).toBe(200);
    const etag = putResponse.headers.get('etag')!;
    expect(etag).toBeTruthy();

    const video = await videoRepository.findOneByOrFail({
      public_id: initiated.public_id,
    });

    return { public_id: initiated.public_id, id: video.id, etag };
  }

  it('completes a real multipart upload, transitions the video to processing, and enqueues process-video keyed by the video id', async () => {
    const { public_id, id, etag } = await initiateAndUploadSinglePart(1024);

    const result = await videosService.completeUpload(user.id, public_id, [
      { part_number: 1, etag },
    ]);

    expect(result).toEqual({ public_id, processing_status: 'processing' });

    const saved = await videoRepository.findOneByOrFail({ public_id });
    expect(saved.processing_status).toBe('processing');
    expect(saved.upload_completed_at).not.toBeNull();

    const videoWithUploadId = await videoRepository
      .createQueryBuilder('video')
      .addSelect('video.upload_id')
      .where('video.public_id = :public_id', { public_id })
      .getOneOrFail();
    expect(videoWithUploadId.upload_id).toBeNull();

    const head = await storageService.client.send(
      new HeadObjectCommand({
        Bucket: storageService.bucket,
        Key: `videos/${public_id}/original`,
      }),
    );
    expect(head.ContentLength).toBe(1024);

    const job = await videoProcessingQueue.getJob(id);
    expect(job).toBeDefined();
    expect(job!.data).toEqual({ videoId: id });
  }, 30000);

  it('does not create a duplicate job when the enqueue is retried with the same jobId', async () => {
    const { public_id, id, etag } = await initiateAndUploadSinglePart(1024);

    await videosService.completeUpload(user.id, public_id, [
      { part_number: 1, etag },
    ]);
    await videoProcessingQueue.add(
      'process-video',
      { videoId: id },
      { jobId: id },
    );

    const jobs = await videoProcessingQueue.getJobs([
      'waiting',
      'active',
      'delayed',
      'completed',
      'failed',
    ]);
    expect(jobs.filter((j) => j.id === id)).toHaveLength(1);
  }, 30000);
});

describe('VideosService.getPlaybackUrl + getDownloadUrl (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let videoProcessingQueue: Queue;
  let videosService: VideosService;
  let user: User;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    storageService = new StorageService({
      ...storageConfig(),
      publicEndpoint: 'http://host.docker.internal:3900',
    });
    videoProcessingQueue = createVideoProcessingQueue();
    videosService = new VideosService(
      videoRepository,
      storageService,
      dataSource,
      videoProcessingQueue,
    );
  });

  afterAll(async () => {
    await videoProcessingQueue.close();
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    user = await userRepository.save(
      userRepository.create({
        email: 'media-urls@example.com',
        password: 'hashed',
      }),
    );
  });

  async function createReadyVideo(
    originalFilename = 'clip.mov',
  ): Promise<Video> {
    const publicId = `ready${Math.random().toString(36).slice(2, 8)}`;
    const videoObjectKey = `videos/${publicId}/video.mp4`;

    const video = await videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        user_id: user.id,
        original_filename: originalFilename,
        content_type: 'video/mp4',
        size_bytes: 1024,
        source_object_key: `videos/${publicId}/original`,
        video_object_key: videoObjectKey,
        processing_status: 'ready',
      }),
    );

    await storageService.client.send(
      new PutObjectCommand({
        Bucket: storageService.bucket,
        Key: videoObjectKey,
        Body: Buffer.alloc(2048, 'a'),
        ContentType: 'video/mp4',
      }),
    );

    return video;
  }

  it('signs a playback URL that serves a 206 Partial Content response for a Range request', async () => {
    const video = await createReadyVideo();

    const result = await videosService.getPlaybackUrl(user.id, video.public_id);
    expect(new URL(result.url).host).toBe('host.docker.internal:3900');

    const res = await fetch(result.url, {
      headers: { Range: 'bytes=0-1023' },
    });
    expect(res.status).toBe(206);
    const body = await res.arrayBuffer();
    expect(body.byteLength).toBe(1024);
  }, 30000);

  it('signs a download URL that serves the video with a sanitized Content-Disposition', async () => {
    const video = await createReadyVideo('clip.mov');

    const result = await videosService.getDownloadUrl(user.id, video.public_id);

    const res = await fetch(result.url);
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="clip.mp4"',
    );
  }, 30000);

  it('throws VIDEO_NOT_READY for both endpoints when the video is still processing', async () => {
    const video = await createReadyVideo();
    await videoRepository.update(video.id, { processing_status: 'processing' });

    await expect(
      videosService.getPlaybackUrl(user.id, video.public_id),
    ).rejects.toThrow('Video has not finished processing yet');
    await expect(
      videosService.getDownloadUrl(user.id, video.public_id),
    ).rejects.toThrow('Video has not finished processing yet');
  });
});
