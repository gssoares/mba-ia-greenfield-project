import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { QUEUES } from '../../queue/queue.constants';
import { VideoMaintenanceService } from './video-maintenance.service';

@Processor(QUEUES.VIDEO_MAINTENANCE)
export class VideoMaintenanceProcessor extends WorkerHost {
  constructor(
    private readonly videoMaintenanceService: VideoMaintenanceService,
  ) {
    super();
  }

  async process(job: Job): Promise<void> {
    const now = new Date();
    await this.videoMaintenanceService.purgeStaleUploads(now);
    await this.videoMaintenanceService.deleteExpiredFailedOriginals(now);
  }
}
