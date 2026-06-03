import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BasicAuthGuard } from './basic-auth.guard';

const VALID_USER = 'admin';
const VALID_PASS = 'secret';

function makeGuard(user = VALID_USER, pass = VALID_PASS): BasicAuthGuard {
  const configService = {
    get: (key: string) => {
      if (key === 'API_USER') return user;
      if (key === 'API_PASSWORD') return pass;
      return undefined;
    },
  } as unknown as ConfigService;
  return new BasicAuthGuard(configService);
}

function makeContext(authHeader?: string): ExecutionContext {
  const request = {
    headers: authHeader ? { authorization: authHeader } : {},
  };
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function encodeBasic(user: string, pass: string): string {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
}

describe('BasicAuthGuard', () => {
  it('should return true for valid credentials', () => {
    const guard = makeGuard();
    const ctx = makeContext(encodeBasic(VALID_USER, VALID_PASS));
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('should throw UnauthorizedException when Authorization header is absent', () => {
    const guard = makeGuard();
    const ctx = makeContext();
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when header does not start with Basic', () => {
    const guard = makeGuard();
    const ctx = makeContext('Bearer sometoken');
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when base64 has no colon separator', () => {
    const guard = makeGuard();
    const ctx = makeContext(
      `Basic ${Buffer.from('nocolon').toString('base64')}`,
    );
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when user is wrong', () => {
    const guard = makeGuard();
    const ctx = makeContext(encodeBasic('wronguser', VALID_PASS));
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when password is wrong', () => {
    const guard = makeGuard();
    const ctx = makeContext(encodeBasic(VALID_USER, 'wrongpass'));
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when both user and password are wrong', () => {
    const guard = makeGuard();
    const ctx = makeContext(encodeBasic('bad', 'creds'));
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });

  it('should throw UnauthorizedException when credentials are empty', () => {
    const guard = makeGuard();
    const ctx = makeContext(encodeBasic('', ''));
    expect(() => guard.canActivate(ctx)).toThrow(UnauthorizedException);
  });
});
