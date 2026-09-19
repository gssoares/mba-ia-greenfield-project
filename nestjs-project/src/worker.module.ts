import { Module } from '@nestjs/common';
import { ConfigModule, ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import databaseConfig from './config/database.config';
import queueConfig from './config/queue.config';
import storageConfig from './config/storage.config';
import { envValidationSchema } from './config/env.validation';
import { QueueModule } from './queue/queue.module';
import { StorageModule } from './storage/storage.module';
import { Channel } from './channels/entities/channel.entity';
import { User } from './users/entities/user.entity';
import { Video } from './videos/entities/video.entity';
import { FfmpegService } from './videos/processing/ffmpeg.service';
import { VideoMaintenanceProcessor } from './videos/processing/video-maintenance.processor';
import { VideoMaintenanceService } from './videos/processing/video-maintenance.service';
import { VideoProcessingProcessor } from './videos/processing/video-processing.processor';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, queueConfig, storageConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        autoLoadEntities: true,
        synchronize: false,
      }),
    }),
    // User and Channel are not queried directly here, but Video's
    // @ManyToOne(() => User) and User's @OneToOne(() => Channel) relations
    // need both entities' metadata registered in this connection too.
    TypeOrmModule.forFeature([Video, User, Channel]),
    QueueModule,
    StorageModule,
  ],
  providers: [
    FfmpegService,
    VideoProcessingProcessor,
    VideoMaintenanceService,
    VideoMaintenanceProcessor,
  ],
})
export class WorkerModule {}
