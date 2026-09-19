import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsString, Min, MaxLength } from 'class-validator';

export class CreateVideoUploadDto {
  @ApiProperty({ example: 'my-video.mp4' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  filename: string;

  @ApiProperty({ example: 134217728 })
  @IsInt()
  @Min(1)
  size_bytes: number;

  @ApiProperty({ example: 'video/mp4' })
  @IsString()
  @IsNotEmpty()
  content_type: string;
}
