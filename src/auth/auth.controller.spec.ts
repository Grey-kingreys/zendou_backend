import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { UserRole, UserStatus } from '@prisma/client';
import type { Request, Response } from 'express';
import { SESSION_COOKIE_NAME, SESSION_TTL_SECONDS } from './auth.constants';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AuthUser } from './auth.types';
import { SessionAuthGuard } from './session-auth.guard';
import {
  baseSessionCookieOptions,
  sessionCookieOptions,
} from './session-cookie';
import { SessionService } from './session.service';

const authUser: AuthUser = {
  id: 'user_1',
  email: 'aissatou@example.com',
  name: 'Aïssatou Diallo',
  company: null,
  declaredUsage: null,
  role: UserRole.CUSTOMER,
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

interface ResponseMock {
  response: Response;
  cookie: jest.Mock;
  clearCookie: jest.Mock;
}

function responseMock(): ResponseMock {
  const cookie = jest.fn();
  const clearCookie = jest.fn();

  return {
    response: { cookie, clearCookie } as unknown as Response,
    cookie,
    clearCookie,
  };
}

function requestMock(cookies?: Record<string, string>): Request {
  return { cookies } as unknown as Request;
}

describe('AuthController', () => {
  let controller: AuthController;

  const authService = { register: jest.fn(), login: jest.fn() };
  const sessionService = {
    create: jest.fn(),
    resolve: jest.fn(),
    destroy: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: SessionService, useValue: sessionService },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('development') },
        },
      ],
    })
      // Le guard est couvert par session-auth.guard.spec.ts.
      .overrideGuard(SessionAuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('sets the session cookie on register and returns the public user', async () => {
    authService.register.mockResolvedValue({
      user: authUser,
      token: 'token-register',
    });
    const { response, cookie } = responseMock();

    await expect(
      controller.register(
        {
          email: 'aissatou@example.com',
          password: 'motdepasse-solide',
          name: 'Aïssatou Diallo',
        },
        response,
      ),
    ).resolves.toEqual(authUser);

    expect(cookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, 'token-register', {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: false,
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
  });

  it('sets the session cookie on login', async () => {
    authService.login.mockResolvedValue({
      user: authUser,
      token: 'token-login',
    });
    const { response, cookie } = responseMock();

    await expect(
      controller.login(
        { email: 'aissatou@example.com', password: 'motdepasse-solide' },
        response,
      ),
    ).resolves.toEqual(authUser);

    expect(cookie).toHaveBeenCalledWith(
      SESSION_COOKIE_NAME,
      'token-login',
      expect.objectContaining({ httpOnly: true, sameSite: 'lax', path: '/' }),
    );
  });

  it('destroys the session and clears the cookie on logout', async () => {
    const { response, clearCookie } = responseMock();

    await controller.logout(
      requestMock({ [SESSION_COOKIE_NAME]: 'token-logout' }),
      response,
    );

    expect(sessionService.destroy).toHaveBeenCalledWith('token-logout');
    expect(clearCookie).toHaveBeenCalledWith(SESSION_COOKIE_NAME, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: false,
    });
  });

  it('is idempotent on logout without a session cookie', async () => {
    const { response, clearCookie } = responseMock();

    await expect(
      controller.logout(requestMock(), response),
    ).resolves.toBeUndefined();

    expect(sessionService.destroy).not.toHaveBeenCalled();
    expect(clearCookie).toHaveBeenCalledTimes(1);
  });

  it('returns the injected current user on /me', () => {
    expect(controller.me(authUser)).toEqual(authUser);
  });
});

describe('session cookie options', () => {
  it('marks the cookie secure only in production', () => {
    expect(sessionCookieOptions(false).secure).toBe(false);
    expect(sessionCookieOptions(true).secure).toBe(true);
    expect(baseSessionCookieOptions(true)).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: true,
    });
  });
});
