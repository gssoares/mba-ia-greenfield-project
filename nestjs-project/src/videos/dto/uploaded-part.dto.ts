import { ApiProperty } from '@nestjs/swagger';

export class UploadedPartDto {
  @ApiProperty({ example: 1 })
  part_number: number;

  @ApiProperty({ example: '"9e107d9d372bb6826bd81d3542a419d6"' })
  etag: string;

  @ApiProperty({ example: 67108864 })
  size_bytes: number;
}

export class ListUploadedPartsResponseDto {
  @ApiProperty({ type: [UploadedPartDto] })
  parts: UploadedPartDto[];
}
