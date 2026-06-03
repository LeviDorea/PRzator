import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { Criticality } from '@prisma/client';

export class CreateRuleDto {
  @IsString()
  @MinLength(3)
  title: string;

  @IsString()
  @MinLength(10)
  description: string;

  @IsEnum(Criticality)
  criticality: Criticality;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  fileGlobs?: string[];

  @IsString()
  @IsOptional()
  targetLanguage?: string;
}
