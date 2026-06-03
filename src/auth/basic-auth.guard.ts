import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

@Injectable()
export class BasicAuthGuard implements CanActivate {
  constructor(private readonly configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const authHeader: string | undefined = request.headers['authorization'];

    if (!authHeader || !authHeader.startsWith('Basic ')) {
      throw new UnauthorizedException();
    }

    let decoded: string;
    try {
      decoded = Buffer.from(authHeader.slice(6), 'base64').toString('utf-8');
    } catch {
      throw new UnauthorizedException();
    }

    const colonIndex = decoded.indexOf(':');
    if (colonIndex === -1) {
      throw new UnauthorizedException();
    }

    const user = decoded.slice(0, colonIndex);
    const password = decoded.slice(colonIndex + 1);

    const expectedUser = this.configService.get<string>('API_USER') ?? '';
    const expectedPassword =
      this.configService.get<string>('API_PASSWORD') ?? '';

    const userMatch = this.timingSafeCompare(user, expectedUser);
    const passMatch = this.timingSafeCompare(password, expectedPassword);

    if (!userMatch || !passMatch) {
      throw new UnauthorizedException();
    }

    return true;
  }

  private timingSafeCompare(a: string, b: string): boolean {
    const aBuf = Buffer.from(a);
    const bBuf = Buffer.from(b);

    if (aBuf.length !== bBuf.length) {
      crypto.timingSafeEqual(aBuf, aBuf);
      return false;
    }

    return crypto.timingSafeEqual(aBuf, bBuf);
  }
}
