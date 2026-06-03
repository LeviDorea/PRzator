import { IsInt, Min } from 'class-validator';

export class UpdateScoringConfigDto {
  @IsInt()
  @Min(1)
  high: number;

  @IsInt()
  @Min(1)
  medium: number;

  @IsInt()
  @Min(1)
  low: number;
}
