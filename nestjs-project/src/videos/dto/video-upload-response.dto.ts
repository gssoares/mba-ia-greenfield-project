import { ApiProperty } from '@nestjs/swagger';

export class VideoUploadResponseDto {
  @ApiProperty({ example: 'aB3xQ9zK1pL' })
  public_id: string;

  @ApiProperty({ example: 'uploading' })
  processing_status: string;

  @ApiProperty({ example: 67108864 })
  part_size_bytes: number;

  @ApiProperty({ example: 2 })
  part_count: number;

  @ApiProperty({ example: '2026-09-17T12:00:00.000Z' })
  created_at: string;
}
