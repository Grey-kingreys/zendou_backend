import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { IsString, MaxLength } from 'class-validator';
import type { Request } from 'express';
import request from 'supertest';
import { UNKNOWN_FIELD_MESSAGE, setupApp } from './app-setup';

const FRONTEND_ORIGIN = 'https://zendou.app';

/** Détail interne qu'aucune réponse HTTP ne doit laisser filtrer. */
const SECRET_INTERNAL_DETAIL =
  'ECONNREFUSED 10.0.0.7:5432 mot de passe base « s3cr3t-postgres »';

class MessageDto {
  @IsString()
  @MaxLength(200)
  message!: string;
}

/**
 * Cobaye minimal : un corps validé par un DTO, une explosion serveur, et une
 * route qui rend le corps brut tel que le parseur JSON l'a compris.
 */
@Controller('essais')
class EssaiController {
  @Post('echo')
  echo(@Body() dto: MessageDto): { message: string } {
    return { message: dto.message };
  }

  @Get('boum')
  boum(): never {
    throw new Error(SECRET_INTERNAL_DETAIL);
  }

  @Post('brut')
  @HttpCode(HttpStatus.OK)
  brut(@Req() httpRequest: Request): { recu: unknown } {
    return { recu: httpRequest.body };
  }
}

/**
 * Preuve de bout en bout du montage HTTP de l'application : ce que `main.ts`
 * appliquait auparavant sans qu'aucun test ne puisse l'atteindre.
 */
describe('setupApp - durcissement HTTP', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const configService = {
      get: (name: string): unknown =>
        name === 'FRONTEND_ORIGIN' ? FRONTEND_ORIGIN : undefined,
    } as unknown as ConfigService;

    const moduleRef = await Test.createTestingModule({
      controllers: [EssaiController],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    setupApp(app, configService);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // -------------------------------------------------------------------------
  // En-têtes de sécurité
  // -------------------------------------------------------------------------

  it("n'annonce plus la pile technique du serveur", async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/essais/echo')
      .send({ message: 'bonjour' });

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('impose HTTPS pour deux ans, sous-domaines compris et préchargeable', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/essais/echo')
      .send({ message: 'bonjour' });

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.headers['strict-transport-security']).toBe(
      'max-age=63072000; includeSubDomains; preload',
    );
  });

  it("interdit toute source et tout encadrement à l'API", async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/essais/echo')
      .send({ message: 'bonjour' });

    const csp = response.headers['content-security-policy'];

    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('autorise le partage de ressources avec le reste du site Zendou', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/essais/echo')
      .send({ message: 'bonjour' });

    expect(response.headers['cross-origin-resource-policy']).toBe('same-site');
  });

  // -------------------------------------------------------------------------
  // CORS : cookie de session conservé, en-têtes de débit lisibles
  // -------------------------------------------------------------------------

  it('accepte le préamble du front avec les cookies et expose Retry-After', async () => {
    const response = await request(app.getHttpServer())
      .options('/v1/essais/echo')
      .set('Origin', FRONTEND_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');

    expect(response.headers['access-control-allow-origin']).toBe(
      FRONTEND_ORIGIN,
    );
    // Sans ceci, le cookie de session ne partirait plus : c'est l'existant
    // qu'aucun ajout ne doit casser.
    expect(response.headers['access-control-allow-credentials']).toBe('true');

    const exposed = response.headers['access-control-expose-headers'];

    expect(exposed).toContain('Retry-After');
    expect(exposed).toContain('X-RateLimit-Limit');
    expect(exposed).toContain('X-RateLimit-Remaining');
    expect(exposed).toContain('X-RateLimit-Reset');
  });

  // -------------------------------------------------------------------------
  // Validation stricte
  // -------------------------------------------------------------------------

  it('refuse un champ inconnu, en français', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/essais/echo')
      .send({ message: 'bonjour', foo: 'valeur inattendue' });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);

    const body = response.body as { message: string; errors: string[] };

    expect(body.message).toContain(UNKNOWN_FIELD_MESSAGE('foo'));
    expect(body.errors).toContain(UNKNOWN_FIELD_MESSAGE('foo'));
    // La phrase de class-validator ne doit plus apparaître nulle part.
    expect(response.text).not.toContain('should not exist');
  });

  it('garde les phrases françaises des autres contraintes', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/essais/echo')
      .send({ message: 42 });

    expect(response.status).toBe(HttpStatus.BAD_REQUEST);

    const body = response.body as { errors: string[] };

    expect(body.errors.join(' ')).toContain('message');
    expect(body.errors.join(' ')).not.toContain('should not exist');
  });

  it('laisse évidemment passer un corps conforme', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/essais/echo')
      .send({ message: 'bonjour' });

    expect(response.status).toBe(HttpStatus.CREATED);
    expect(response.body).toEqual({ message: 'bonjour' });
  });

  // -------------------------------------------------------------------------
  // Parseur de corps : rapports CSP compris
  // -------------------------------------------------------------------------

  it('parse les deux types MIME des rapports de violation CSP', async () => {
    const ancienFormat = await request(app.getHttpServer())
      .post('/v1/essais/brut')
      .set('Content-Type', 'application/csp-report')
      .send(
        JSON.stringify({ 'csp-report': { 'document-uri': 'https://a/b' } }),
      );

    const reportingApi = await request(app.getHttpServer())
      .post('/v1/essais/brut')
      .set('Content-Type', 'application/reports+json')
      .send(JSON.stringify([{ type: 'csp-violation', body: {} }]));

    expect(ancienFormat.status).toBe(HttpStatus.OK);
    expect(ancienFormat.body).toEqual({
      recu: { 'csp-report': { 'document-uri': 'https://a/b' } },
    });
    expect(reportingApi.status).toBe(HttpStatus.OK);
    expect(reportingApi.body).toEqual({
      recu: [{ type: 'csp-violation', body: {} }],
    });
  });

  // -------------------------------------------------------------------------
  // 500 : le filtre global est bien monté
  // -------------------------------------------------------------------------

  it('rend un 500 générique, sans un mot de la pile', async () => {
    const logged = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    try {
      const response = await request(app.getHttpServer()).get(
        '/v1/essais/boum',
      );

      expect(response.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(response.body).toEqual({
        statusCode: 500,
        message: 'Internal server error',
        errors: ['Internal server error'],
      });
      expect(response.text).not.toContain(SECRET_INTERNAL_DETAIL);
      expect(response.text).not.toContain('at ');
      // La pile, elle, part bien au journal.
      expect(logged).toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });
});
