import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { RulesService } from './rules.service';
import { CreateRuleDto } from './dto/create-rule.dto';
import { UpdateRuleDto } from './dto/update-rule.dto';
import { AssociateReposDto } from './dto/associate-repos.dto';
import { BasicAuthGuard } from '../auth/basic-auth.guard';

@Controller('rules')
@UseGuards(BasicAuthGuard)
export class RulesController {
  constructor(private readonly service: RulesService) {}

  @Get()
  findAll() {
    return this.service.findAll();
  }

  @Post()
  create(@Body() dto: CreateRuleDto) {
    return this.service.create(dto);
  }

  @Put(':id')
  update(@Param('id') id: string, @Body() dto: UpdateRuleDto) {
    return this.service.update(id, dto);
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.service.remove(id);
  }

  @Post(':id/repos')
  associateToRepos(@Param('id') id: string, @Body() dto: AssociateReposDto) {
    return this.service.associateToRepos(id, dto);
  }
}
