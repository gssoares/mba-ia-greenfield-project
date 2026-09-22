import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
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
import { StorageService } from '../storage/storage.service';
import { JOBS, QUEUES } from '../queue/queue.constants';
import { CompleteUploadResponseDto } from './dto/complete-upload-response.dto';
import { CreateVideoUploadDto } from './dto/create-video-upload.dto';
import { ListUploadedPartsResponseDto } from './dto/uploaded-part.dto';
import { MediaUrlResponseDto } from './dto/media-url-response.dto';
import { SignUploadPartsResponseDto } from './dto/signed-upload-part.dto';
import { VideoResponseDto } from './dto/video-response.dto';
import { VideoUploadResponseDto } from './dto/video-upload-response.dto';
import { Video } from './entities/video.entity';
import { generatePublicId } from './public-id.util';
import {
  ACCEPTED_CONTENT_TYPES,
  DOWNLOAD_URL_TTL_SECONDS,
  MAX_UPLOAD_BYTES,
  PART_SIZE_BYTES,
  PLAYBACK_URL_TTL_SECONDS,
} from './videos.constants';

function sanitizedDownloadFilename(originalFilename: string): string {
  const withoutExtension = originalFilename.replace(/\.[^./]+$/, '');
  // eslint-disable-next-line no-control-regex
  const sanitized = withoutExtension.replace(/["\x00-\x1f\x7f]/g, '');
  return `${sanitized}.mp4`;
}

const UPLOAD_PART_EXPIRES_IN_SECONDS = 3600;

const PG_UNIQUE_VIOLATION = '23505';
const PUBLIC_ID_COLUMN = 'public_id';
const MAX_RETRIES = 5;

function isPgUniqueViolationOnColumn(err: unknown, column: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const e = err as QueryFailedError & { code?: string; detail?: string };
  return (
    e.code === PG_UNIQUE_VIOLATION &&
    typeof e.detail === 'string' &&
    e.detail.includes(column)
  );
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly dataSource: DataSource,
    @InjectQueue(QUEUES.VIDEO_PROCESSING)
    private readonly videoProcessingQueue: Queue,
  ) {}

  async initiateUpload(
    userId: string,
    dto: CreateVideoUploadDto,
  ): Promise<VideoUploadResponseDto> {
    if (dto.size_bytes > MAX_UPLOAD_BYTES) {
      throw new VideoUploadTooLargeException();
    }
    if (
      !ACCEPTED_CONTENT_TYPES.includes(
        dto.content_type as (typeof ACCEPTED_CONTENT_TYPES)[number],
      )
    ) {
      throw new UnsupportedVideoContentTypeException();
    }

    const partCount = Math.ceil(dto.size_bytes / PART_SIZE_BYTES);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      const publicId = generatePublicId();
      const sourceObjectKey = `videos/${publicId}/original`;

      const { UploadId } = await this.storageService.client.send(
        new CreateMultipartUploadCommand({
          Bucket: this.storageService.bucket,
          Key: sourceObjectKey,
          ContentType: dto.content_type,
        }),
      );

      try {
        const video = await this.videoRepository.save(
          this.videoRepository.create({
            public_id: publicId,
            user_id: userId,
            original_filename: dto.filename,
            content_type: dto.content_type,
            size_bytes: dto.size_bytes,
            source_object_key: sourceObjectKey,
            upload_id: UploadId,
          }),
        );

        return {
          public_id: video.public_id,
          processing_status: video.processing_status,
          part_size_bytes: PART_SIZE_BYTES,
          part_count: partCount,
          created_at: video.created_at.toISOString(),
        };
      } catch (err) {
        await this.storageService.client.send(
          new AbortMultipartUploadCommand({
            Bucket: this.storageService.bucket,
            Key: sourceObjectKey,
            UploadId,
          }),
        );

        if (!isPgUniqueViolationOnColumn(err, PUBLIC_ID_COLUMN)) {
          throw err;
        }
      }
    }

    throw new Error(
      'public_id conflict could not be resolved after max retries',
    );
  }

  async findOwnedByPublicId(
    userId: string,
    publicId: string,
    options: { selectUploadId?: boolean } = {},
  ): Promise<Video> {
    const qb = this.videoRepository
      .createQueryBuilder('video')
      .where('video.public_id = :publicId', { publicId });

    if (options.selectUploadId) {
      qb.addSelect('video.upload_id');
    }

    const video = await qb.getOne();

    if (!video || video.user_id !== userId) {
      throw new VideoNotFoundException();
    }

    return video;
  }

  async signUploadParts(
    userId: string,
    publicId: string,
    partNumbers: number[],
  ): Promise<SignUploadPartsResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId, {
      selectUploadId: true,
    });

    if (video.processing_status !== 'uploading') {
      throw new UploadNotInProgressException();
    }

    const partCount = Math.ceil(video.size_bytes / PART_SIZE_BYTES);
    if (partNumbers.some((n) => n < 1 || n > partCount)) {
      throw new InvalidPartNumberException();
    }

    const issuedAt = Date.now();
    const expiresAt = new Date(
      issuedAt + UPLOAD_PART_EXPIRES_IN_SECONDS * 1000,
    ).toISOString();

    const parts = await Promise.all(
      partNumbers.map(async (partNumber) => ({
        part_number: partNumber,
        url: await this.storageService.presignUploadPart(
          video.source_object_key,
          video.upload_id!,
          partNumber,
          UPLOAD_PART_EXPIRES_IN_SECONDS,
        ),
        expires_at: expiresAt,
      })),
    );

    return { parts };
  }

  async listUploadedParts(
    userId: string,
    publicId: string,
  ): Promise<ListUploadedPartsResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId, {
      selectUploadId: true,
    });

    if (video.processing_status !== 'uploading') {
      throw new UploadNotInProgressException();
    }

    const { Parts } = await this.storageService.client.send(
      new ListPartsCommand({
        Bucket: this.storageService.bucket,
        Key: video.source_object_key,
        UploadId: video.upload_id!,
      }),
    );

    return {
      parts: (Parts ?? []).map((part) => ({
        part_number: part.PartNumber!,
        etag: part.ETag!,
        size_bytes: part.Size!,
      })),
    };
  }

  async completeUpload(
    userId: string,
    publicId: string,
    parts: { part_number: number; etag: string }[],
  ): Promise<CompleteUploadResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId, {
      selectUploadId: true,
    });

    if (video.processing_status !== 'uploading') {
      throw new UploadNotInProgressException();
    }

    const partCount = Math.ceil(video.size_bytes / PART_SIZE_BYTES);
    const partsInOrder = parts.every(
      (part, index) => part.part_number === index + 1,
    );
    if (parts.length !== partCount || !partsInOrder) {
      throw new UploadIncompleteException();
    }

    try {
      await this.storageService.client.send(
        new CompleteMultipartUploadCommand({
          Bucket: this.storageService.bucket,
          Key: video.source_object_key,
          UploadId: video.upload_id!,
          MultipartUpload: {
            Parts: parts.map((part) => ({
              ETag: part.etag,
              PartNumber: part.part_number,
            })),
          },
        }),
      );
    } catch {
      throw new UploadIncompleteException();
    }

    const { ContentLength } = await this.storageService.client.send(
      new HeadObjectCommand({
        Bucket: this.storageService.bucket,
        Key: video.source_object_key,
      }),
    );

    if (ContentLength !== video.size_bytes) {
      await this.storageService.client.send(
        new DeleteObjectCommand({
          Bucket: this.storageService.bucket,
          Key: video.source_object_key,
        }),
      );
      throw new UploadIncompleteException();
    }

    await this.dataSource.transaction(async (manager) => {
      await manager.update(Video, video.id, {
        upload_completed_at: new Date(),
        upload_id: null,
        processing_status: 'processing',
      });
    });

    await this.videoProcessingQueue.add(
      JOBS.PROCESS_VIDEO,
      { videoId: video.id },
      { jobId: video.id },
    );

    return { public_id: video.public_id, processing_status: 'processing' };
  }

  async getOwnedVideo(
    userId: string,
    publicId: string,
  ): Promise<VideoResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId);

    return {
      public_id: video.public_id,
      publication_status: video.publication_status,
      processing_status: video.processing_status,
      failure_code: video.failure_code,
      original_filename: video.original_filename,
      content_type: video.content_type,
      size_bytes: video.size_bytes,
      duration_seconds:
        video.duration_seconds === null
          ? null
          : parseFloat(video.duration_seconds),
      width: video.width,
      height: video.height,
      video_codec: video.video_codec,
      audio_codec: video.audio_codec,
      created_at: video.created_at.toISOString(),
      processed_at: video.processed_at?.toISOString() ?? null,
    };
  }

  async getPlaybackUrl(
    userId: string,
    publicId: string,
  ): Promise<MediaUrlResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (video.processing_status !== 'ready') {
      throw new VideoNotReadyException();
    }

    const issuedAt = Date.now();
    const url = await this.storageService.presignGetObject(
      video.video_object_key!,
      PLAYBACK_URL_TTL_SECONDS,
    );

    return {
      url,
      expires_at: new Date(
        issuedAt + PLAYBACK_URL_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }

  async getDownloadUrl(
    userId: string,
    publicId: string,
  ): Promise<MediaUrlResponseDto> {
    const video = await this.findOwnedByPublicId(userId, publicId);
    if (video.processing_status !== 'ready') {
      throw new VideoNotReadyException();
    }

    const issuedAt = Date.now();
    const filename = sanitizedDownloadFilename(video.original_filename);
    const url = await this.storageService.presignGetObject(
      video.video_object_key!,
      DOWNLOAD_URL_TTL_SECONDS,
      `attachment; filename="${filename}"`,
    );

    return {
      url,
      expires_at: new Date(
        issuedAt + DOWNLOAD_URL_TTL_SECONDS * 1000,
      ).toISOString(),
    };
  }
}
