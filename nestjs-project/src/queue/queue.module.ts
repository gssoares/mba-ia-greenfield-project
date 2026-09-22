import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigType } from '@nestjs/config';
import queueConfig from '../config/queue.config';
import { QUEUES } from './queue.constants';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [queueConfig.KEY],
      useFactory: (config: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: config.redisHost,
          port: config.redisPort,
        },
      }),
    }),
    BullModule.registerQueue(
      {
        name: QUEUES.VIDEO_PROCESSING,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 30_000 },
        },
      },
      { name: QUEUES.VIDEO_MAINTENANCE },
    ),
  ],
  exports: [BullModule],
})
export class QueueModule {}
