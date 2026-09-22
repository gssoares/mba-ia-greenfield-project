import { ApiProperty } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsInt, IsPositive } from 'class-validator';

export class SignUploadPartsDto {
  @ApiProperty({ type: [Number], example: [1, 2] })
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsInt({ each: true })
  @IsPositive({ each: true })
  part_numbers: number[];
}
