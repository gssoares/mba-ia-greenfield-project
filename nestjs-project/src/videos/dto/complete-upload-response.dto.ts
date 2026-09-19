import { ApiProperty } from '@nestjs/swagger';

export class CompleteUploadResponseDto {
  @ApiProperty({ example: 'aB3xQ9zK1pL' })
  public_id: string;

  @ApiProperty({ example: 'processing' })
  processing_status: string;
}
