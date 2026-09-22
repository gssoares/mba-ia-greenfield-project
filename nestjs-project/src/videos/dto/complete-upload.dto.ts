import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMinSize,
  IsInt,
  IsNotEmpty,
  IsPositive,
  IsString,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

class CompletedPartDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @IsPositive()
  part_number: number;

  @ApiProperty({ example: '"9e107d9d372bb6826bd81d3542a419d6"' })
  @IsString()
  @IsNotEmpty()
  etag: string;
}

export class CompleteUploadDto {
  @ApiProperty({ type: [CompletedPartDto] })
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CompletedPartDto)
  parts: CompletedPartDto[];
}
