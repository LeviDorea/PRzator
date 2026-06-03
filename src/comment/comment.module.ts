import { Module } from '@nestjs/common';
import { GithubModule } from '../github/github.module';
import { CommentListener } from './comment.listener';
import { CommentService } from './comment.service';

@Module({
  imports: [GithubModule],
  providers: [CommentService, CommentListener],
})
export class CommentModule {}
