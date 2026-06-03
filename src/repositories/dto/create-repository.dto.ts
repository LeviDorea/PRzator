import { IsInt, IsString } from 'class-validator';

export class CreateRepositoryDto {
  @IsString()
  owner: string;

  @IsString()
  name: string;

  @IsString()
  fullName: string;

  @IsInt()
  githubId: number;

  @IsInt()
  installationId: number;
}
