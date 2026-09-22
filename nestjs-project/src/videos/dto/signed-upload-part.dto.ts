import { ApiProperty } from '@nestjs/swagger';

export class SignedUploadPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: 'http://localhost:3900/streamtube-videos/...' })
  url: string;

  @ApiProperty({ example: '2026-09-17T13:00:00.000Z' })
  expires_at: string;
}

export class SignUploadPartsResponseDto {
  @ApiProperty({ type: [SignedUploadPartDto] })
  parts: SignedUploadPartDto[];
}
