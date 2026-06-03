import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { GithubModule } from './github/github.module';
import { RepositoriesModule } from './repositories/repositories.module';
import { RulesModule } from './rules/rules.module';
import { WebhookModule } from './webhook/webhook.module';
import { AnalysisModule } from './analysis/analysis.module';
import { CommentModule } from './comment/comment.module';
import { ScoringConfigModule } from './scoring-config/scoring-config.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    EventEmitterModule.forRoot(),
    PrismaModule,
    GithubModule,
    RepositoriesModule,
    RulesModule,
    WebhookModule,
    AnalysisModule,
    CommentModule,
    ScoringConfigModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
