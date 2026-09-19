import { ApiProperty } from '@nestjs/swagger';

export class VideoResponseDto {
  @ApiProperty({ example: 'aB3xQ9zK1pL' })
  public_id: string;

  @ApiProperty({ example: 'draft' })
  publication_status: string;

  @ApiProperty({ example: 'uploading' })
  processing_status: string;

  @ApiProperty({ example: null, nullable: true })
  failure_code: string | null;

  @ApiProperty({ example: 'clip.mp4' })
  original_filename: string;

  @ApiProperty({ example: 'video/mp4' })
  content_type: string;

  @ApiProperty({ example: 104857600 })
  size_bytes: number;

  @ApiProperty({ example: null, nullable: true })
  duration_seconds: number | null;

  @ApiProperty({ example: null, nullable: true })
  width: number | null;

  @ApiProperty({ example: null, nullable: true })
  height: number | null;

  @ApiProperty({ example: null, nullable: true })
  video_codec: string | null;

  @ApiProperty({ example: null, nullable: true })
  audio_codec: string | null;

  @ApiProperty({ example: '2026-09-17T12:00:00.000Z' })
  created_at: string;

  @ApiProperty({ example: null, nullable: true })
  processed_at: string | null;
}
