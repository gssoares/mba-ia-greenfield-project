import { Test } from '@nestjs/testing';
import { getQueueToken } from '@nestjs/bullmq';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { WorkerModule } from './worker.module';
import { JOBS, QUEUES, SCHEDULES } from './queue/queue.constants';
import { Video } from './videos/entities/video.entity';
import { VideoMaintenanceProcessor } from './videos/processing/video-maintenance.processor';
import { VideoProcessingProcessor } from './videos/processing/video-processing.processor';

describe('WorkerModule (integration)', () => {
  it('should compile against real Redis, Postgres and Garage and register the video-processing processor', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();

    expect(module).toBeDefined();
    expect(module.get(VideoProcessingProcessor)).toBeDefined();
    expect(module.get(VideoMaintenanceProcessor)).toBeDefined();
    expect(module.get(getRepositoryToken(Video))).toBeDefined();
    expect(module.get(getQueueToken(QUEUES.VIDEO_PROCESSING))).toBeDefined();
    expect(module.get(getQueueToken(QUEUES.VIDEO_MAINTENANCE))).toBeDefined();

    await module.close();
  }, 30000);

  it('keeps exactly one purge-stale-uploads scheduler in video-maintenance after two consecutive bootstraps', async () => {
    const module = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    const maintenanceQueue = module.get<Queue>(
      getQueueToken(QUEUES.VIDEO_MAINTENANCE),
    );

    const registerSchedule = () =>
      maintenanceQueue.upsertJobScheduler(
        JOBS.PURGE_STALE_UPLOADS,
        { pattern: SCHEDULES.PURGE_STALE_UPLOADS_CRON },
        { name: JOBS.PURGE_STALE_UPLOADS, data: {} },
      );

    await registerSchedule();
    await registerSchedule();

    const schedulers = await maintenanceQueue.getJobSchedulers();
    const purgeSchedulers = schedulers.filter(
      (s) => s.key === JOBS.PURGE_STALE_UPLOADS,
    );
    expect(purgeSchedulers).toHaveLength(1);
    expect(purgeSchedulers[0].pattern).toBe(SCHEDULES.PURGE_STALE_UPLOADS_CRON);

    await module.close();
  }, 30000);
});
