import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { RepositoriesService } from './repositories.service';
import { CreateRepositoryDto } from './dto/create-repository.dto';
import { BasicAuthGuard } from '../auth/basic-auth.guard';

@Controller('repos')
@UseGuards(BasicAuthGuard)
export class RepositoriesController {
  constructor(private readonly service: RepositoriesService) {}

  @Get('available')
  findAvailable() {
    return this.service.findAvailable();
  }

  @Post()
  create(@Body() dto: CreateRepositoryDto) {
    return this.service.create(dto);
  }

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }
}
