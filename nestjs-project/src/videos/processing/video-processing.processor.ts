import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Job, UnrecoverableError } from 'bullmq';
import { createReadStream, createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { pipeline } from 'stream/promises';
import { Repository } from 'typeorm';
import { QUEUES } from '../../queue/queue.constants';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import { FfmpegService, type FfprobeResult } from './ffmpeg.service';
import { assertSupportedMedia, thumbnailTimestamp } from './media-policy';

const DEFAULT_FAILURE_CODE = 'PROCESSING_FAILED';

@Processor(QUEUES.VIDEO_PROCESSING)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    private readonly ffmpegService: FfmpegService,
  ) {
    super();
  }

  async process(job: Job<{ videoId: string }>): Promise<void> {
    const video = await this.videoRepository.findOneBy({
      id: job.data.videoId,
    });
    if (!video || video.processing_status !== 'processing') {
      return;
    }

    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'video-processing-'),
    );

    try {
      const originalPath = path.join(tempDir, 'original');
      const { Body } = await this.storageService.client.send(
        new GetObjectCommand({
          Bucket: this.storageService.bucket,
          Key: video.source_object_key,
        }),
      );
      await pipeline(
        Body as NodeJS.ReadableStream,
        createWriteStream(originalPath),
      );

      let probe: FfprobeResult;
      try {
        probe = await this.ffmpegService.probe(originalPath);
      } catch {
        throw new UnrecoverableError('INVALID_MEDIA');
      }
      assertSupportedMedia(probe);

      const videoStream = probe.streams.find((s) => s.codec_type === 'video')!;
      const audioStream = probe.streams.find((s) => s.codec_type === 'audio');
      const durationSeconds = parseFloat(probe.format.duration ?? '0');

      const remuxedPath = path.join(tempDir, 'video.mp4');
      await this.ffmpegService.remuxFaststart(originalPath, remuxedPath);

      const thumbnailPath = path.join(tempDir, 'thumbnail.jpg');
      await this.ffmpegService.extractThumbnail(
        remuxedPath,
        thumbnailPath,
        thumbnailTimestamp(durationSeconds),
      );

      const videoObjectKey = `videos/${video.public_id}/video.mp4`;
      const thumbnailObjectKey = `videos/${video.public_id}/thumbnail.jpg`;

      const remuxedStat = await fs.stat(remuxedPath);
      await this.storageService.client.send(
        new PutObjectCommand({
          Bucket: this.storageService.bucket,
          Key: videoObjectKey,
          Body: createReadStream(remuxedPath),
          ContentLength: remuxedStat.size,
          ContentType: 'video/mp4',
        }),
      );

      const thumbnailStat = await fs.stat(thumbnailPath);
      await this.storageService.client.send(
        new PutObjectCommand({
          Bucket: this.storageService.bucket,
          Key: thumbnailObjectKey,
          Body: createReadStream(thumbnailPath),
          ContentLength: thumbnailStat.size,
          ContentType: 'image/jpeg',
        }),
      );

      await this.videoRepository.update(video.id, {
        video_object_key: videoObjectKey,
        thumbnail_object_key: thumbnailObjectKey,
        duration_seconds: durationSeconds.toFixed(3),
        width: videoStream.width ?? null,
        height: videoStream.height ?? null,
        video_codec: videoStream.codec_name,
        audio_codec: audioStream?.codec_name ?? null,
        processing_status: 'ready',
        processed_at: new Date(),
      });

      await this.storageService.client.send(
        new DeleteObjectCommand({
          Bucket: this.storageService.bucket,
          Key: video.source_object_key,
        }),
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<{ videoId: string }>, error: Error): Promise<void> {
    const isFinalFailure =
      error instanceof UnrecoverableError ||
      job.attemptsMade >= (job.opts.attempts ?? 1);

    if (!isFinalFailure) {
      return;
    }

    const failureCode =
      error instanceof UnrecoverableError && error.message
        ? error.message
        : DEFAULT_FAILURE_CODE;

    await this.videoRepository.update(
      { id: job.data.videoId, processing_status: 'processing' },
      {
        processing_status: 'failed',
        failure_code: failureCode,
        failed_at: new Date(),
      },
    );
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn(`Job stalled: ${jobId}`);
  }
}
