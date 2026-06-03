import { IsArray, IsString } from 'class-validator';

export class AssociateReposDto {
  @IsArray()
  @IsString({ each: true })
  repositoryIds: string[];
}
