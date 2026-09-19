import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { WorkerModule } from './worker.module';
import { JOBS, QUEUES, SCHEDULES } from './queue/queue.constants';

async function bootstrap() {
  const app = await NestFactory.createApplicationContext(WorkerModule);

  const videoMaintenanceQueue = app.get<Queue>(
    getQueueToken(QUEUES.VIDEO_MAINTENANCE),
  );
  await videoMaintenanceQueue.upsertJobScheduler(
    JOBS.PURGE_STALE_UPLOADS,
    { pattern: SCHEDULES.PURGE_STALE_UPLOADS_CRON },
    { name: JOBS.PURGE_STALE_UPLOADS, data: {} },
  );

  Logger.log('Video worker started, consuming video-processing queue', 'Bootstrap');
}
void bootstrap();
