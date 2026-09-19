import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  AbortMultipartUploadCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { LessThan, Repository } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import { Video } from '../entities/video.entity';
import {
  FAILED_ORIGINAL_RETENTION_DAYS,
  STALE_UPLOAD_MAX_AGE_HOURS,
} from '../videos.constants';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

@Injectable()
export class VideoMaintenanceService {
  private readonly logger = new Logger(VideoMaintenanceService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {}

  async purgeStaleUploads(now: Date): Promise<void> {
    const cutoff = new Date(
      now.getTime() - STALE_UPLOAD_MAX_AGE_HOURS * HOUR_MS,
    );

    const staleUploads = await this.videoRepository
      .createQueryBuilder('video')
      .addSelect('video.upload_id')
      .where('video.processing_status = :status', { status: 'uploading' })
      .andWhere('video.created_at < :cutoff', { cutoff })
      .getMany();

    for (const video of staleUploads) {
      if (video.upload_id) {
        try {
          await this.storageService.client.send(
            new AbortMultipartUploadCommand({
              Bucket: this.storageService.bucket,
              Key: video.source_object_key,
              UploadId: video.upload_id,
            }),
          );
        } catch (err) {
          // The upload may already be gone — aborted independently by the
          // bucket's own lifecycle rule (SI-03.1), or by a prior run of this
          // job. Either way the row still needs to go.
          this.logger.warn(
            `Could not abort multipart upload for video ${video.id}, proceeding to remove the row: ${(err as Error).message}`,
          );
        }
      }
      await this.videoRepository.delete(video.id);
    }
  }

  async deleteExpiredFailedOriginals(now: Date): Promise<void> {
    const cutoff = new Date(
      now.getTime() - FAILED_ORIGINAL_RETENTION_DAYS * DAY_MS,
    );

    const expiredFailures = await this.videoRepository.find({
      where: { processing_status: 'failed', failed_at: LessThan(cutoff) },
    });

    for (const video of expiredFailures) {
      await this.storageService.client.send(
        new DeleteObjectCommand({
          Bucket: this.storageService.bucket,
          Key: video.source_object_key,
        }),
      );
    }
  }
}
