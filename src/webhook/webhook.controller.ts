import {
  Controller,
  Headers,
  HttpCode,
  Post,
  Req,
  RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { WebhookService } from './webhook.service';

@Controller('webhook')
export class WebhookController {
  constructor(private readonly webhookService: WebhookService) {}

  @Post('github')
  @HttpCode(200)
  async handleGithub(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-hub-signature-256') signature: string,
    @Headers('x-github-event') event: string,
  ) {
    this.webhookService.validateSignature(req.rawBody!, signature);
    await this.webhookService.handlePullRequestEvent(event, req.body);
    return { ok: true };
  }
}
