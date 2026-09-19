import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { QueueModule } from '../queue/queue.module';
import { StorageModule } from '../storage/storage.module';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    QueueModule,
    StorageModule,
  ],
  controllers: [VideosController],
  providers: [VideosService],
  exports: [TypeOrmModule],
})
export class VideosModule {}
