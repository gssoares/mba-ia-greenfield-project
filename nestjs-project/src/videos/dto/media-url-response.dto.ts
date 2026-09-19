import { ApiProperty } from '@nestjs/swagger';

export class MediaUrlResponseDto {
  @ApiProperty({ example: 'https://storage.example.com/videos/aB3xQ9zK1pL/video.mp4?X-Amz-...' })
  url: string;

  @ApiProperty({ example: '2026-09-19T18:00:00.000Z' })
  expires_at: string;
}
