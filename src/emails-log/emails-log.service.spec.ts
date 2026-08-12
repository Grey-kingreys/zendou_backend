import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { EmailStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { EmailsLogService } from './emails-log.service';
import type { EmailDetail } from './emails-log.types';

// Reflète exactement les `select` de production : jamais l'id interne cuid
// ni le userId ne doivent être exposés (voir emails-log.service.ts).
const EMAIL_LIST_SELECT = {
  publicId: true,
  fromAddress: true,
  toAddress: true,
  subject: true,
  status: true,
  queuedAt: true,
  sentAt: true,
  deliveredAt: true,
  lastEventAt: true,
};

const EMAIL_DETAIL_SELECT = {
  ...EMAIL_LIST_SELECT,
  errorMessage: true,
  sesMessageId: true,
};

describe('EmailsLogService', () => {
  let service: EmailsLogService;

  const findMany = jest.fn();
  const count = jest.fn();
  const findFirst = jest.fn();

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailsLogService,
        {
          provide: PrismaService,
          useValue: { email: { findMany, count, findFirst } },
        },
      ],
    }).compile();

    service = module.get<EmailsLogService>(EmailsLogService);
  });

  describe('list', () => {
    it('applies default pagination (page 1, limit 25) scoped to the current user', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(0);

      const result = await service.list('user_1', {});

      expect(findMany).toHaveBeenCalledWith({
        where: { userId: 'user_1', system: false },
        select: EMAIL_LIST_SELECT,
        orderBy: { queuedAt: 'desc' },
        skip: 0,
        take: 25,
      });
      expect(count).toHaveBeenCalledWith({
        where: { userId: 'user_1', system: false },
      });
      expect(result).toEqual({
        items: [],
        total: 0,
        page: 1,
        limit: 25,
        totalPages: 0,
      });
    });

    it('computes skip/take and totalPages for a given page/limit', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(42);

      const result = await service.list('user_1', { page: '3', limit: '10' });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 20, take: 10 }),
      );
      expect(result).toMatchObject({ page: 3, limit: 10, totalPages: 5 });
    });

    it('rejects a page below 1', async () => {
      await expect(
        service.list('user_1', { page: '0' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('rejects a non-integer page', async () => {
      await expect(
        service.list('user_1', { page: 'abc' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a limit above 100', async () => {
      await expect(
        service.list('user_1', { limit: '101' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('rejects a limit below 1', async () => {
      await expect(
        service.list('user_1', { limit: '0' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('filters by status when provided', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(0);

      await service.list('user_1', { status: EmailStatus.DELIVERED });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user_1',
            system: false,
            status: EmailStatus.DELIVERED,
          },
        }),
      );
      expect(count).toHaveBeenCalledWith({
        where: {
          userId: 'user_1',
          system: false,
          status: EmailStatus.DELIVERED,
        },
      });
    });

    it('rejects an unknown status with a 400', async () => {
      await expect(
        service.list('user_1', { status: 'NOT_A_STATUS' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('filters on the queuedAt range with from and to', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(0);

      await service.list('user_1', {
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-31T23:59:59.000Z',
      });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user_1',
            system: false,
            queuedAt: {
              gte: new Date('2026-01-01T00:00:00.000Z'),
              lte: new Date('2026-01-31T23:59:59.000Z'),
            },
          },
        }),
      );
    });

    it('rejects an invalid from date with a 400', async () => {
      await expect(
        service.list('user_1', { from: 'not-a-date' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('rejects an invalid to date with a 400', async () => {
      await expect(
        service.list('user_1', { to: 'not-a-date' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects from > to with a 400', async () => {
      await expect(
        service.list('user_1', { from: '2026-02-01', to: '2026-01-01' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('searches case-insensitively on toAddress or subject with q', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(0);

      await service.list('user_1', { q: 'Diallo' });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            userId: 'user_1',
            system: false,
            OR: [
              { toAddress: { contains: 'Diallo', mode: 'insensitive' } },
              { subject: { contains: 'Diallo', mode: 'insensitive' } },
            ],
          },
        }),
      );
    });

    it('ignores a blank q', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(0);

      await service.list('user_1', { q: '   ' });

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user_1', system: false } }),
      );
    });

    it('scopes the query to the current user (user A never sees user B emails)', async () => {
      findMany.mockResolvedValue([]);
      count.mockResolvedValue(0);

      await service.list('user_A', {});

      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { userId: 'user_A', system: false } }),
      );
      expect(count).toHaveBeenCalledWith({
        where: { userId: 'user_A', system: false },
      });
    });
  });

  describe('detail', () => {
    const email: EmailDetail = {
      publicId: 'pub_1',
      fromAddress: 'contact@zendou.gn',
      toAddress: 'aissatou@example.com',
      subject: 'Bienvenue',
      status: EmailStatus.SENT,
      errorMessage: null,
      sesMessageId: 'ses_1',
      queuedAt: new Date('2026-01-01T00:00:00.000Z'),
      sentAt: new Date('2026-01-01T00:00:01.000Z'),
      deliveredAt: null,
      lastEventAt: new Date('2026-01-01T00:00:01.000Z'),
    };

    it('returns the full detail scoped by publicId and userId', async () => {
      findFirst.mockResolvedValue(email);

      const result = await service.detail('user_1', 'pub_1');

      expect(findFirst).toHaveBeenCalledWith({
        where: { publicId: 'pub_1', userId: 'user_1', system: false },
        select: EMAIL_DETAIL_SELECT,
      });
      expect(result).toEqual(email);
    });

    it('throws 404 when the email does not exist', async () => {
      findFirst.mockResolvedValue(null);

      await expect(service.detail('user_1', 'unknown')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('throws the exact same 404 when the email belongs to another user (no oracle)', async () => {
      // La requête combine publicId + userId : Prisma renvoie null pour un
      // publicId d'un autre utilisateur, exactement comme pour un publicId
      // inexistant.
      findFirst.mockResolvedValue(null);

      const ownEmailError = await service
        .detail('user_B', 'pub_of_user_A')
        .catch((error: NotFoundException) => error);
      const unknownEmailError = await service
        .detail('user_B', 'does-not-exist')
        .catch((error: NotFoundException) => error);

      expect(ownEmailError).toBeInstanceOf(NotFoundException);
      expect(unknownEmailError).toBeInstanceOf(NotFoundException);
      expect((ownEmailError as NotFoundException).getResponse()).toEqual(
        (unknownEmailError as NotFoundException).getResponse(),
      );
      expect(findFirst).toHaveBeenNthCalledWith(1, {
        where: { publicId: 'pub_of_user_A', userId: 'user_B', system: false },
        select: EMAIL_DETAIL_SELECT,
      });
    });
  });
});
