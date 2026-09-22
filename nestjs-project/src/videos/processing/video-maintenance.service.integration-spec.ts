import {
  AbortMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { DataSource, Repository } from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import storageConfig from '../../config/storage.config';
import { StorageService } from '../../storage/storage.service';
import { User } from '../../users/entities/user.entity';
import { Video } from '../entities/video.entity';
import { generatePublicId } from '../public-id.util';
import { VideoMaintenanceService } from './video-maintenance.service';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

describe('VideoMaintenanceService (integration)', () => {
  let dataSource: DataSource;
  let userRepository: Repository<User>;
  let videoRepository: Repository<Video>;
  let storageService: StorageService;
  let service: VideoMaintenanceService;
  let user: User;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    userRepository = dataSource.getRepository(User);
    videoRepository = dataSource.getRepository(Video);
    storageService = new StorageService(storageConfig());
    service = new VideoMaintenanceService(videoRepository, storageService);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    user = await userRepository.save(
      userRepository.create({
        email: 'video-maintenance@example.com',
        password: 'hashed',
      }),
    );
  });

  async function createUploadingVideo(ageHours: number): Promise<Video> {
    const publicId = generatePublicId();
    const sourceObjectKey = `videos/${publicId}/original`;

    const { UploadId } = await storageService.client.send(
      new CreateMultipartUploadCommand({
        Bucket: storageService.bucket,
        Key: sourceObjectKey,
        ContentType: 'video/mp4',
      }),
    );

    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        user_id: user.id,
        original_filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
        source_object_key: sourceObjectKey,
        upload_id: UploadId,
        processing_status: 'uploading',
      }),
    );
    await dataSource.query('UPDATE videos SET created_at = $1 WHERE id = $2', [
      new Date(Date.now() - ageHours * HOUR_MS),
      saved.id,
    ]);
    return saved;
  }

  async function createFailedVideo(ageDays: number): Promise<Video> {
    const publicId = generatePublicId();
    const sourceObjectKey = `videos/${publicId}/original`;

    await storageService.client.send(
      new PutObjectCommand({
        Bucket: storageService.bucket,
        Key: sourceObjectKey,
        Body: Buffer.alloc(1024, 'a'),
      }),
    );

    const saved = await videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        user_id: user.id,
        original_filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
        source_object_key: sourceObjectKey,
        processing_status: 'failed',
        failure_code: 'UNSUPPORTED_CODEC',
      }),
    );
    await dataSource.query('UPDATE videos SET failed_at = $1 WHERE id = $2', [
      new Date(Date.now() - ageDays * DAY_MS),
      saved.id,
    ]);
    return saved;
  }

  it('aborts and removes a 25h-old uploading draft, but leaves a 23h-old one intact', async () => {
    const stale = await createUploadingVideo(25);
    const fresh = await createUploadingVideo(23);

    await service.purgeStaleUploads(new Date());

    expect(await videoRepository.findOneBy({ id: stale.id })).toBeNull();
    expect(await videoRepository.findOneBy({ id: fresh.id })).not.toBeNull();

    await expect(
      storageService.client.send(
        new HeadObjectCommand({
          Bucket: storageService.bucket,
          Key: stale.source_object_key,
        }),
      ),
    ).rejects.toThrow();
  }, 30000);

  it('deletes the original for an 8-day-old failed video, keeping the row and failure_code, but leaves a 6-day-old one intact', async () => {
    const expired = await createFailedVideo(8);
    const recent = await createFailedVideo(6);

    await service.deleteExpiredFailedOriginals(new Date());

    const expiredRow = await videoRepository.findOneBy({ id: expired.id });
    expect(expiredRow).not.toBeNull();
    expect(expiredRow!.processing_status).toBe('failed');
    expect(expiredRow!.failure_code).toBe('UNSUPPORTED_CODEC');
    await expect(
      storageService.client.send(
        new HeadObjectCommand({
          Bucket: storageService.bucket,
          Key: expired.source_object_key,
        }),
      ),
    ).rejects.toThrow();

    const recentHead = await storageService.client.send(
      new HeadObjectCommand({
        Bucket: storageService.bucket,
        Key: recent.source_object_key,
      }),
    );
    expect(recentHead.ContentLength).toBe(1024);
  }, 30000);

  it('does not touch ready videos', async () => {
    const publicId = generatePublicId();
    const ready = await videoRepository.save(
      videoRepository.create({
        public_id: publicId,
        user_id: user.id,
        original_filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: 1024,
        source_object_key: `videos/${publicId}/original`,
        processing_status: 'ready',
      }),
    );
    await dataSource.query('UPDATE videos SET created_at = $1 WHERE id = $2', [
      new Date(Date.now() - 48 * HOUR_MS),
      ready.id,
    ]);

    await service.purgeStaleUploads(new Date());
    await service.deleteExpiredFailedOriginals(new Date());

    const row = await videoRepository.findOneBy({ id: ready.id });
    expect(row).not.toBeNull();
    expect(row!.processing_status).toBe('ready');
  });

  it('ignores an already-aborted multipart upload when purging a stale draft', async () => {
    const stale = await createUploadingVideo(25);
    const staleWithUploadId = await videoRepository
      .createQueryBuilder('video')
      .addSelect('video.upload_id')
      .where('video.id = :id', { id: stale.id })
      .getOneOrFail();

    // Simulate the bucket's own lifecycle rule (SI-03.1) already aborting
    // this upload independently of this job.
    await storageService.client.send(
      new AbortMultipartUploadCommand({
        Bucket: storageService.bucket,
        Key: stale.source_object_key,
        UploadId: staleWithUploadId.upload_id!,
      }),
    );

    await expect(service.purgeStaleUploads(new Date())).resolves.not.toThrow();
    expect(await videoRepository.findOneBy({ id: stale.id })).toBeNull();
  }, 30000);

  it('ignores an already-deleted original when purging expired failed videos', async () => {
    const expired = await createFailedVideo(8);
    await storageService.client.send(
      new DeleteObjectCommand({
        Bucket: storageService.bucket,
        Key: expired.source_object_key,
      }),
    );

    await expect(
      service.deleteExpiredFailedOriginals(new Date()),
    ).resolves.not.toThrow();
  }, 30000);

  it('running the job twice in a row does not throw', async () => {
    await createUploadingVideo(25);
    await createFailedVideo(8);

    await service.purgeStaleUploads(new Date());
    await service.deleteExpiredFailedOriginals(new Date());

    await expect(service.purgeStaleUploads(new Date())).resolves.not.toThrow();
    await expect(
      service.deleteExpiredFailedOriginals(new Date()),
    ).resolves.not.toThrow();
  }, 30000);
});
