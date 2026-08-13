import {
  ExecutionContext,
  INestApplication,
  UnauthorizedException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { UserRole, UserStatus } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { AuthenticatedRequest, AuthUser } from '../auth';
import { SessionAuthGuard } from '../auth';
import { AdminGuard } from '../billing/admin/admin.guard';
import { AdminStatsController } from './admin-stats.controller';
import { AdminStatsService } from './admin-stats.service';

const adminUser: AuthUser = {
  id: 'admin_1',
  email: 'admin@zendou.gn',
  name: 'Admin Zendou',
  company: null,
  declaredUsage: null,
  role: UserRole.ADMIN,
  status: UserStatus.ACTIVE,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

const customerUser: AuthUser = {
  ...adminUser,
  id: 'user_1',
  email: 'aissatou@example.com',
  role: UserRole.CUSTOMER,
};

describe('AdminStatsController', () => {
  describe('délégation', () => {
    let controller: AdminStatsController;

    const adminStatsService = { emailStats: jest.fn() };

    beforeEach(async () => {
      jest.clearAllMocks();

      const module: TestingModule = await Test.createTestingModule({
        controllers: [AdminStatsController],
        providers: [
          { provide: AdminStatsService, useValue: adminStatsService },
        ],
      })
        // Le garde est couvert par billing/admin/admin.guard.spec.ts pour sa
        // logique générique, et par le bloc « sécurité » ci-dessous pour sa
        // présence réelle sur cette route précise.
        .overrideGuard(AdminGuard)
        .useValue({ canActivate: () => true })
        .compile();

      controller = module.get<AdminStatsController>(AdminStatsController);
    });

    it('delegates to the service', async () => {
      const stats = { total: { all: 1, system: 0, client: 1 } };
      adminStatsService.emailStats.mockResolvedValue(stats);

      await expect(controller.emails()).resolves.toBe(stats);
      expect(adminStatsService.emailStats).toHaveBeenCalledWith();
    });
  });

  /**
   * Preuve que la route réelle — décorateur `@UseGuards` compris, pas
   * seulement la classe `AdminGuard` isolée — rejette bien un compte non
   * admin. Un endpoint de statistiques globales accessible à un CUSTOMER
   * serait une fuite de données commerciales sur toute la plateforme.
   *
   * Seul `SessionAuthGuard` est doublé (pas de Redis/cookie ici, déjà
   * couvert par ses propres tests) ; `AdminGuard` et le contrôleur sont les
   * vraies classes, montées dans une vraie application Nest et interrogées
   * via de vraies requêtes HTTP (supertest), comme
   * `rate-limit.integration.spec.ts`.
   */
  describe('sécurité (garde réel, bout en bout)', () => {
    let app: INestApplication<App>;
    const sessionAuthGuard = { canActivate: jest.fn() };
    const adminStatsService = { emailStats: jest.fn() };

    beforeAll(async () => {
      const module: TestingModule = await Test.createTestingModule({
        controllers: [AdminStatsController],
        providers: [
          AdminGuard,
          { provide: SessionAuthGuard, useValue: sessionAuthGuard },
          { provide: AdminStatsService, useValue: adminStatsService },
        ],
      }).compile();

      app = module.createNestApplication<INestApplication<App>>();
      await app.init();
    });

    afterAll(async () => {
      await app.close();
    });

    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('répond 401 sans session', async () => {
      // La logique exacte (cookie absent → 401) est prouvée par
      // `session-auth.guard.spec.ts` ; ici on ne double que la sortie —
      // c'est l'exception que `SessionAuthGuard` lève réellement dans ce cas.
      sessionAuthGuard.canActivate.mockRejectedValue(
        new UnauthorizedException('Authentification requise'),
      );

      const response = await request(app.getHttpServer()).get(
        '/admin/stats/emails',
      );

      expect(response.status).toBe(401);
      expect(adminStatsService.emailStats).not.toHaveBeenCalled();
    });

    it('répond 403 pour un compte CUSTOMER authentifié', async () => {
      sessionAuthGuard.canActivate.mockImplementation(
        (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
          req.user = customerUser;
          return true;
        },
      );

      const response = await request(app.getHttpServer()).get(
        '/admin/stats/emails',
      );

      expect(response.status).toBe(403);
      expect(adminStatsService.emailStats).not.toHaveBeenCalled();
    });

    it('répond 200 pour un compte ADMIN authentifié et sert la réponse du service', async () => {
      sessionAuthGuard.canActivate.mockImplementation(
        (context: ExecutionContext) => {
          const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
          req.user = adminUser;
          return true;
        },
      );
      const stats = {
        total: { all: 1000, system: 30, client: 970 },
        today: { all: 20, system: 2, client: 18 },
        last7d: { all: 150, system: 10, client: 140 },
        last30d: { all: 625, system: 25, client: 600 },
        byStatus: {
          QUEUED: 0,
          SENT: 900,
          DELIVERED: 50,
          BOUNCED: 20,
          COMPLAINED: 5,
          REJECTED: 5,
          FAILED: 10,
          SUPPRESSED: 10,
        },
        generatedAt: new Date('2026-08-13T15:30:00.000Z'),
      };
      adminStatsService.emailStats.mockResolvedValue(stats);

      const response = await request(app.getHttpServer()).get(
        '/admin/stats/emails',
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        total: { all: 1000, system: 30, client: 970 },
      });
      expect(adminStatsService.emailStats).toHaveBeenCalledWith();
    });
  });
});
