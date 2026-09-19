import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { DataSource, QueryFailedError, Repository } from 'typeorm';
import {
  InvalidPartNumberException,
  UnsupportedVideoContentTypeException,
  UploadIncompleteException,
  UploadNotInProgressException,
  VideoNotFoundException,
  VideoNotReadyException,
  VideoUploadTooLargeException,
} from '../common/exceptions/domain.exception';
import { QUEUES } from '../queue/queue.constants';
import { StorageService } from '../storage/storage.service';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';
import { MAX_UPLOAD_BYTES, PART_SIZE_BYTES } from './videos.constants';

function makeUniqueViolationOnPublicId(): QueryFailedError {
  const err = new QueryFailedError('INSERT', [], new Error()) as any;
  err.code = '23505';
  err.detail = 'Key (public_id)=(aaaaaaaaaaa) already exists.';
  return err;
}

describe('VideosService — initiateUpload', () => {
  let videosService: VideosService;
  let videoRepository: jest.Mocked<Repository<Video>>;
  let storageService: { client: { send: jest.Mock }; bucket: string };

  const baseDto = {
    filename: 'clip.mp4',
    size_bytes: 104857600,
    content_type: 'video/mp4',
  };

  beforeEach(async () => {
    storageService = {
      client: { send: jest.fn() },
      bucket: 'streamtube-videos',
    };
    storageService.client.send.mockImplementation((command: unknown) => {
      if (command instanceof CreateMultipartUploadCommand) {
        return Promise.resolve({ UploadId: 'test-upload-id' });
      }
      if (command instanceof AbortMultipartUploadCommand) {
        return Promise.resolve({});
      }
      throw new Error('Unexpected command sent to storage client');
    });

    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        {
          provide: getRepositoryToken(Video),
          useValue: {
            create: jest.fn((attrs) => attrs),
            save: jest.fn().mockImplementation((entity) =>
              Promise.resolve({
                ...entity,
                processing_status: 'uploading',
                created_at: new Date('2026-09-17T12:00:00.000Z'),
              }),
            ),
          },
        },
        { provide: StorageService, useValue: storageService },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        {
          provide: getQueueToken(QUEUES.VIDEO_PROCESSING),
          useValue: { add: jest.fn() },
        },
      ],
    }).compile();

    videosService = module.get(VideosService);
    videoRepository = module.get(getRepositoryToken(Video));
  });

  it('should reject a file above the 10 GiB limit with UPLOAD_TOO_LARGE', async () => {
    await expect(
      videosService.initiateUpload('user-1', {
        ...baseDto,
        size_bytes: MAX_UPLOAD_BYTES + 1,
      }),
    ).rejects.toThrow(VideoUploadTooLargeException);

    expect(storageService.client.send).not.toHaveBeenCalled();
  });

  it('should reject a content type outside the allowlist with UNSUPPORTED_MEDIA_TYPE', async () => {
    await expect(
      videosService.initiateUpload('user-1', {
        ...baseDto,
        content_type: 'video/x-matroska',
      }),
    ).rejects.toThrow(UnsupportedVideoContentTypeException);

    expect(storageService.client.send).not.toHaveBeenCalled();
  });

  it('should compute part_count from size_bytes and the fixed part size', async () => {
    const result = await videosService.initiateUpload('user-1', {
      ...baseDto,
      size_bytes: PART_SIZE_BYTES * 2 + 1,
    });

    expect(result.part_size_bytes).toBe(PART_SIZE_BYTES);
    expect(result.part_count).toBe(3);
  });

  it('should retry with a new public_id when the save fails on a public_id unique violation', async () => {
    videoRepository.save
      .mockRejectedValueOnce(makeUniqueViolationOnPublicId())
      .mockImplementationOnce((entity) =>
        Promise.resolve({
          ...entity,
          processing_status: 'uploading',
          created_at: new Date('2026-09-17T12:00:00.000Z'),
        }),
      );

    const result = await videosService.initiateUpload('user-1', baseDto);

    expect(result.public_id).toBeDefined();
    expect(videoRepository.save).toHaveBeenCalledTimes(2);
    expect(storageService.client.send).toHaveBeenCalledTimes(3); // 2x create + 1 abort
    expect(storageService.client.send).toHaveBeenCalledWith(
      expect.any(AbortMultipartUploadCommand),
    );
  });

  it('should abort the multipart upload with the returned UploadId when the save fails for a non-collision reason', async () => {
    const dbError = new Error('connection lost');
    videoRepository.save.mockRejectedValueOnce(dbError);

    await expect(
      videosService.initiateUpload('user-1', baseDto),
    ).rejects.toThrow(dbError);

    const abortCall = storageService.client.send.mock.calls.find(
      ([command]) => command instanceof AbortMultipartUploadCommand,
    );
    expect(abortCall).toBeDefined();
    expect(abortCall![0].input).toMatchObject({ UploadId: 'test-upload-id' });
  });
});

function makeQueryBuilder(video: Partial<Video> | null) {
  return {
    where: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue(video),
  };
}

describe('VideosService — findOwnedByPublicId / signUploadParts / listUploadedParts', () => {
  let videosService: VideosService;
  let videoRepository: {
    createQueryBuilder: jest.Mock;
  };
  let storageService: {
    client: { send: jest.Mock };
    presignUploadPart: jest.Mock;
    bucket: string;
  };

  const ownerId = 'owner-1';
  const publicId = 'aaaaaaaaaaa';

  function baseVideo(overrides: Partial<Video> = {}): Partial<Video> {
    return {
      id: 'video-1',
      public_id: publicId,
      user_id: ownerId,
      processing_status: 'uploading',
      size_bytes: PART_SIZE_BYTES * 2,
      source_object_key: `videos/${publicId}/original`,
      upload_id: 'test-upload-id',
      ...overrides,
    };
  }

  beforeEach(() => {
    videoRepository = { createQueryBuilder: jest.fn() };
    storageService = {
      client: { send: jest.fn() },
      presignUploadPart: jest.fn().mockResolvedValue('https://signed.example/part'),
      bucket: 'streamtube-videos',
    };
  });

  async function build(): Promise<void> {
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        {
          provide: getQueueToken(QUEUES.VIDEO_PROCESSING),
          useValue: { add: jest.fn() },
        },
      ],
    }).compile();
    videosService = module.get(VideosService);
  }

  describe('findOwnedByPublicId', () => {
    it('should throw VIDEO_NOT_FOUND when the public_id does not exist', async () => {
      videoRepository.createQueryBuilder.mockReturnValue(makeQueryBuilder(null));
      await build();

      await expect(
        videosService.findOwnedByPublicId(ownerId, publicId),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should throw VIDEO_NOT_FOUND when the caller is not the owner', async () => {
      videoRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(baseVideo({ user_id: 'someone-else' }) as Video),
      );
      await build();

      await expect(
        videosService.findOwnedByPublicId(ownerId, publicId),
      ).rejects.toThrow(VideoNotFoundException);
    });
  });

  describe('signUploadParts', () => {
    it('should throw UPLOAD_NOT_IN_PROGRESS when processing_status is not uploading', async () => {
      videoRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(baseVideo({ processing_status: 'processing' }) as Video),
      );
      await build();

      await expect(
        videosService.signUploadParts(ownerId, publicId, [1]),
      ).rejects.toThrow(UploadNotInProgressException);
    });

    it('should throw INVALID_PART_NUMBER when a part number is outside 1..part_count', async () => {
      videoRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(baseVideo() as Video), // size_bytes => part_count = 2
      );
      await build();

      await expect(
        videosService.signUploadParts(ownerId, publicId, [3]),
      ).rejects.toThrow(InvalidPartNumberException);
    });

    it('should pass expiresIn: 3600 to the presign call for each requested part', async () => {
      videoRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(baseVideo() as Video),
      );
      await build();

      const result = await videosService.signUploadParts(ownerId, publicId, [
        1, 2,
      ]);

      expect(result.parts).toHaveLength(2);
      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        `videos/${publicId}/original`,
        'test-upload-id',
        1,
        3600,
      );
      expect(storageService.presignUploadPart).toHaveBeenCalledWith(
        `videos/${publicId}/original`,
        'test-upload-id',
        2,
        3600,
      );
    });
  });

  describe('listUploadedParts', () => {
    it('should throw UPLOAD_NOT_IN_PROGRESS when processing_status is not uploading', async () => {
      videoRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(baseVideo({ processing_status: 'ready' }) as Video),
      );
      await build();

      await expect(
        videosService.listUploadedParts(ownerId, publicId),
      ).rejects.toThrow(UploadNotInProgressException);
    });

    it('should map Parts[] (PartNumber, ETag, Size) to snake_case fields', async () => {
      videoRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(baseVideo() as Video),
      );
      storageService.client.send.mockResolvedValue({
        Parts: [{ PartNumber: 1, ETag: '"etag-1"', Size: 67108864 }],
      });
      await build();

      const result = await videosService.listUploadedParts(ownerId, publicId);

      expect(result.parts).toEqual([
        { part_number: 1, etag: '"etag-1"', size_bytes: 67108864 },
      ]);
    });
  });

  describe('getOwnedVideo', () => {
    it('should throw VIDEO_NOT_FOUND when the caller is not the owner', async () => {
      videoRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(baseVideo({ user_id: 'someone-else' }) as Video),
      );
      await build();

      await expect(
        videosService.getOwnedVideo(ownerId, publicId),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it('should map the full entity to the response DTO, converting duration_seconds to a number and omitting internal fields', async () => {
      videoRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(
          baseVideo({
            publication_status: 'draft',
            processing_status: 'ready',
            failure_code: null,
            original_filename: 'clip.mp4',
            content_type: 'video/mp4',
            size_bytes: PART_SIZE_BYTES * 2,
            duration_seconds: '12.345',
            width: 1920,
            height: 1080,
            video_codec: 'h264',
            audio_codec: 'aac',
            created_at: new Date('2026-09-17T12:00:00.000Z'),
            processed_at: new Date('2026-09-17T12:05:00.000Z'),
          }) as Video,
        ),
      );
      await build();

      const result = await videosService.getOwnedVideo(ownerId, publicId);

      expect(result).toEqual({
        public_id: publicId,
        publication_status: 'draft',
        processing_status: 'ready',
        failure_code: null,
        original_filename: 'clip.mp4',
        content_type: 'video/mp4',
        size_bytes: PART_SIZE_BYTES * 2,
        duration_seconds: 12.345,
        width: 1920,
        height: 1080,
        video_codec: 'h264',
        audio_codec: 'aac',
        created_at: '2026-09-17T12:00:00.000Z',
        processed_at: '2026-09-17T12:05:00.000Z',
      });
      expect(result).not.toHaveProperty('id');
      expect(result).not.toHaveProperty('user_id');
      expect(result).not.toHaveProperty('upload_id');
    });
  });
});

describe('VideosService — completeUpload', () => {
  let videosService: VideosService;
  let videoRepository: { createQueryBuilder: jest.Mock };
  let storageService: { client: { send: jest.Mock }; bucket: string };
  let dataSource: { transaction: jest.Mock };
  let manager: { update: jest.Mock };
  let videoProcessingQueue: { add: jest.Mock };

  const ownerId = 'owner-1';
  const publicId = 'aaaaaaaaaaa';
  const videoId = 'video-1';
  const validParts = [
    { part_number: 1, etag: '"etag-1"' },
    { part_number: 2, etag: '"etag-2"' },
  ];

  function baseVideo(overrides: Partial<Video> = {}): Partial<Video> {
    return {
      id: videoId,
      public_id: publicId,
      user_id: ownerId,
      processing_status: 'uploading',
      size_bytes: PART_SIZE_BYTES * 2, // part_count: 2
      source_object_key: `videos/${publicId}/original`,
      upload_id: 'test-upload-id',
      ...overrides,
    };
  }

  beforeEach(() => {
    videoRepository = { createQueryBuilder: jest.fn() };
    manager = { update: jest.fn().mockResolvedValue(undefined) };
    dataSource = { transaction: jest.fn((cb) => cb(manager)) };
    videoProcessingQueue = { add: jest.fn().mockResolvedValue(undefined) };
    storageService = {
      client: { send: jest.fn() },
      bucket: 'streamtube-videos',
    };
  });

  async function build(): Promise<void> {
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: DataSource, useValue: dataSource },
        {
          provide: getQueueToken(QUEUES.VIDEO_PROCESSING),
          useValue: videoProcessingQueue,
        },
      ],
    }).compile();
    videosService = module.get(VideosService);
  }

  it('should throw UPLOAD_NOT_IN_PROGRESS when processing_status is not uploading', async () => {
    videoRepository.createQueryBuilder.mockReturnValue(
      makeQueryBuilder(
        baseVideo({ processing_status: 'processing' }) as Video,
      ),
    );
    await build();

    await expect(
      videosService.completeUpload(ownerId, publicId, validParts),
    ).rejects.toThrow(UploadNotInProgressException);
    expect(storageService.client.send).not.toHaveBeenCalled();
  });

  it('should throw UPLOAD_INCOMPLETE when the part list does not cover 1..part_count', async () => {
    videoRepository.createQueryBuilder.mockReturnValue(
      makeQueryBuilder(baseVideo() as Video),
    );
    await build();

    await expect(
      videosService.completeUpload(ownerId, publicId, [validParts[0]]),
    ).rejects.toThrow(UploadIncompleteException);
    expect(storageService.client.send).not.toHaveBeenCalled();
  });

  it('should throw UPLOAD_INCOMPLETE when parts are out of order', async () => {
    videoRepository.createQueryBuilder.mockReturnValue(
      makeQueryBuilder(baseVideo() as Video),
    );
    await build();

    await expect(
      videosService.completeUpload(ownerId, publicId, [
        { part_number: 2, etag: '"etag-2"' },
        { part_number: 1, etag: '"etag-1"' },
      ]),
    ).rejects.toThrow(UploadIncompleteException);
    expect(storageService.client.send).not.toHaveBeenCalled();
  });

  it('should throw UPLOAD_INCOMPLETE when storage rejects the completion', async () => {
    videoRepository.createQueryBuilder.mockReturnValue(
      makeQueryBuilder(baseVideo() as Video),
    );
    storageService.client.send.mockImplementation((command: unknown) => {
      if (command instanceof CompleteMultipartUploadCommand) {
        return Promise.reject(new Error('storage rejected completion'));
      }
      throw new Error('Unexpected command sent to storage client');
    });
    await build();

    await expect(
      videosService.completeUpload(ownerId, publicId, validParts),
    ).rejects.toThrow(UploadIncompleteException);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('should delete the object and throw UPLOAD_INCOMPLETE when the stored size differs from size_bytes', async () => {
    videoRepository.createQueryBuilder.mockReturnValue(
      makeQueryBuilder(baseVideo() as Video),
    );
    storageService.client.send.mockImplementation((command: unknown) => {
      if (command instanceof CompleteMultipartUploadCommand) {
        return Promise.resolve({});
      }
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({ ContentLength: PART_SIZE_BYTES }); // mismatched
      }
      if (command instanceof DeleteObjectCommand) {
        return Promise.resolve({});
      }
      throw new Error('Unexpected command sent to storage client');
    });
    await build();

    await expect(
      videosService.completeUpload(ownerId, publicId, validParts),
    ).rejects.toThrow(UploadIncompleteException);
    expect(storageService.client.send).toHaveBeenCalledWith(
      expect.any(DeleteObjectCommand),
    );
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('should transition the video to processing and enqueue process-video only after the DB transition, keyed by the video id', async () => {
    videoRepository.createQueryBuilder.mockReturnValue(
      makeQueryBuilder(baseVideo() as Video),
    );
    storageService.client.send.mockImplementation((command: unknown) => {
      if (command instanceof CompleteMultipartUploadCommand) {
        return Promise.resolve({});
      }
      if (command instanceof HeadObjectCommand) {
        return Promise.resolve({ ContentLength: PART_SIZE_BYTES * 2 });
      }
      throw new Error('Unexpected command sent to storage client');
    });
    await build();

    const result = await videosService.completeUpload(
      ownerId,
      publicId,
      validParts,
    );

    expect(result).toEqual({
      public_id: publicId,
      processing_status: 'processing',
    });
    expect(manager.update).toHaveBeenCalledWith(
      Video,
      videoId,
      expect.objectContaining({
        upload_id: null,
        processing_status: 'processing',
      }),
    );
    expect(videoProcessingQueue.add).toHaveBeenCalledWith(
      'process-video',
      { videoId },
      { jobId: videoId },
    );

    const transactionOrder = dataSource.transaction.mock.invocationCallOrder[0];
    const enqueueOrder = videoProcessingQueue.add.mock.invocationCallOrder[0];
    expect(transactionOrder).toBeLessThan(enqueueOrder);
  });
});

describe('VideosService — getPlaybackUrl / getDownloadUrl', () => {
  let videosService: VideosService;
  let videoRepository: { createQueryBuilder: jest.Mock };
  let storageService: { presignGetObject: jest.Mock };

  const ownerId = 'owner-1';
  const publicId = 'aaaaaaaaaaa';

  function baseVideo(overrides: Partial<Video> = {}): Partial<Video> {
    return {
      id: 'video-1',
      public_id: publicId,
      user_id: ownerId,
      processing_status: 'ready',
      original_filename: 'clip.mov',
      video_object_key: `videos/${publicId}/video.mp4`,
      ...overrides,
    };
  }

  beforeEach(() => {
    videoRepository = { createQueryBuilder: jest.fn() };
    storageService = {
      presignGetObject: jest.fn().mockResolvedValue('https://signed.example/video.mp4'),
    };
  });

  async function build(): Promise<void> {
    const module = await Test.createTestingModule({
      providers: [
        VideosService,
        { provide: getRepositoryToken(Video), useValue: videoRepository },
        { provide: StorageService, useValue: storageService },
        { provide: DataSource, useValue: { transaction: jest.fn() } },
        {
          provide: getQueueToken(QUEUES.VIDEO_PROCESSING),
          useValue: { add: jest.fn() },
        },
      ],
    }).compile();
    videosService = module.get(VideosService);
  }

  describe('getPlaybackUrl', () => {
    it('should throw VIDEO_NOT_FOUND when the caller is not the owner', async () => {
      videoRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(baseVideo({ user_id: 'someone-else' }) as Video),
      );
      await build();

      await expect(
        videosService.getPlaybackUrl(ownerId, publicId),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it.each(['uploading', 'processing', 'failed'])(
      'should throw VIDEO_NOT_READY when processing_status is %s',
      async (processing_status) => {
        videoRepository.createQueryBuilder.mockReturnValue(
          makeQueryBuilder(baseVideo({ processing_status }) as Video),
        );
        await build();

        await expect(
          videosService.getPlaybackUrl(ownerId, publicId),
        ).rejects.toThrow(VideoNotReadyException);
      },
    );

    it('should presign with expiresIn: 21600', async () => {
      videoRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(baseVideo() as Video),
      );
      await build();

      await videosService.getPlaybackUrl(ownerId, publicId);

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        `videos/${publicId}/video.mp4`,
        21600,
      );
    });
  });

  describe('getDownloadUrl', () => {
    it('should throw VIDEO_NOT_FOUND when the caller is not the owner', async () => {
      videoRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(baseVideo({ user_id: 'someone-else' }) as Video),
      );
      await build();

      await expect(
        videosService.getDownloadUrl(ownerId, publicId),
      ).rejects.toThrow(VideoNotFoundException);
    });

    it.each(['uploading', 'processing', 'failed'])(
      'should throw VIDEO_NOT_READY when processing_status is %s',
      async (processing_status) => {
        videoRepository.createQueryBuilder.mockReturnValue(
          makeQueryBuilder(baseVideo({ processing_status }) as Video),
        );
        await build();

        await expect(
          videosService.getDownloadUrl(ownerId, publicId),
        ).rejects.toThrow(VideoNotReadyException);
      },
    );

    it('should presign with expiresIn: 900', async () => {
      videoRepository.createQueryBuilder.mockReturnValue(
        makeQueryBuilder(baseVideo() as Video),
      );
      await build();

      await videosService.getDownloadUrl(ownerId, publicId);

      expect(storageService.presignGetObject).toHaveBeenCalledWith(
        `videos/${publicId}/video.mp4`,
        900,
        expect.any(String),
      );
    });
  });

  it('should presign the download URL with a sanitized attachment filename', async () => {
    videoRepository.createQueryBuilder.mockReturnValue(
      makeQueryBuilder(
        baseVideo({ original_filename: 'my "clip".mov' }) as Video,
      ),
    );
    await build();

    await videosService.getDownloadUrl(ownerId, publicId);

    expect(storageService.presignGetObject).toHaveBeenCalledWith(
      `videos/${publicId}/video.mp4`,
      900,
      'attachment; filename="my clip.mp4"',
    );
  });
});
