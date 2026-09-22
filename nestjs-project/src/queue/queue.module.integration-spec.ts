import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QueueModule } from './queue.module';
import { QUEUES } from './queue.constants';

describe('QueueModule (integration)', () => {
  let module: TestingModule;
  let videoProcessingQueue: Queue;
  let videoMaintenanceQueue: Queue;

  beforeAll(async () => {
    module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    videoProcessingQueue = module.get<Queue>(
      getQueueToken(QUEUES.VIDEO_PROCESSING),
    );
    videoMaintenanceQueue = module.get<Queue>(
      getQueueToken(QUEUES.VIDEO_MAINTENANCE),
    );
  }, 30000);

  afterEach(async () => {
    await videoProcessingQueue.obliterate({ force: true });
  });

  afterAll(async () => {
    await module.close();
  });

  it('should compile against the real Redis instance and expose both queues', () => {
    expect(videoProcessingQueue).toBeDefined();
    expect(videoProcessingQueue.name).toBe(QUEUES.VIDEO_PROCESSING);
    expect(videoMaintenanceQueue).toBeDefined();
    expect(videoMaintenanceQueue.name).toBe(QUEUES.VIDEO_MAINTENANCE);
  });

  it('should respond to getJobCounts() without error', async () => {
    await expect(videoProcessingQueue.getJobCounts()).resolves.toBeDefined();
  });

  it('should apply the default job options (3 attempts, exponential backoff at 30000ms) when a job is added without explicit options', async () => {
    const job = await videoProcessingQueue.add('process-video', {
      videoId: 'test-video-id',
    });

    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 30_000 });
  });

  it('should keep a newly added job in the waiting state while no worker is active', async () => {
    const job = await videoProcessingQueue.add('process-video', {
      videoId: 'test-video-id-2',
    });

    const state = await job.getState();
    expect(state).toBe('waiting');
  });
});
