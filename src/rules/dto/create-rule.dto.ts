import {
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';
import { Criticality, RuleScope } from '@prisma/client';

export class CreateRuleDto {
  @IsString()
  @MinLength(3)
  title: string;

  @IsString()
  @MinLength(10)
  description: string;

  @IsEnum(Criticality)
  criticality: Criticality;

  @IsEnum(RuleScope)
  @IsOptional()
  scope?: RuleScope;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  fileGlobs?: string[];

  @IsString()
  @IsOptional()
  targetLanguage?: string;

  @IsString()
  @IsOptional()
  whyThisRuleExists?: string;

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  localEvidence?: string[];

  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  supersedesDefaults?: string[];
}
