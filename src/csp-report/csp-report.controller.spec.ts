import { HttpStatus, Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { JSON_BODY_TYPES } from '../app-setup';
import { CSP_FIELD_MAX_LENGTH } from './csp-report.controller';
import { CspReportModule } from './csp-report.module';

/**
 * Le contrôleur ne rend rien et n'écrit rien en base : sa seule sortie
 * observable est la ligne de journal. C'est donc elle que ces tests lisent.
 */
describe('CspReportController (HTTP)', () => {
  let app: NestExpressApplication;
  let warned: jest.SpyInstance;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CspReportModule],
    }).compile();

    app = moduleRef.createNestApplication<NestExpressApplication>();
    // Les types MIME des rapports sont confiés au parseur JSON par
    // `setupApp` : sans cette ligne, le corps n'arriverait jamais jusqu'au
    // contrôleur. On rejoue donc exactement la configuration de production.
    app.useBodyParser('json', { limit: '2mb', type: JSON_BODY_TYPES });
    await app.init();

    warned = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    warned.mockRestore();
    await app.close();
  });

  const post = (contentType: string, body: string) =>
    request(app.getHttpServer())
      .post('/csp-report')
      .set('Content-Type', contentType)
      .send(body);

  /** Toutes les lignes journalisées, concaténées. */
  const lignes = (): string[] =>
    (warned.mock.calls as unknown[][]).map((call) => String(call[0]));

  it('accepte le format historique report-uri', async () => {
    const response = await post(
      'application/csp-report',
      JSON.stringify({
        'csp-report': {
          'document-uri': 'https://zendou.app/tableau-de-bord',
          'violated-directive': 'script-src',
          'blocked-uri': 'https://cdn.pirate.example/x.js',
          disposition: 'enforce',
          'script-sample': 'const jeton = "secret-a-ne-pas-journaliser"',
        },
      }),
    );

    expect(response.status).toBe(HttpStatus.NO_CONTENT);
    expect(lignes()).toHaveLength(1);
    expect(lignes()[0]).toContain('https://zendou.app/tableau-de-bord');
    expect(lignes()[0]).toContain('script-src');
    expect(lignes()[0]).toContain('https://cdn.pirate.example/x.js');
    expect(lignes()[0]).toContain('enforce');
  });

  it('accepte le format Reporting API, une ligne par violation', async () => {
    const response = await post(
      'application/reports+json',
      JSON.stringify([
        {
          type: 'csp-violation',
          body: {
            documentURL: 'https://zendou.app/connexion',
            effectiveDirective: 'img-src',
            blockedURL: 'https://tracker.example/pixel.gif',
            disposition: 'report',
          },
        },
        {
          type: 'csp-violation',
          body: {
            documentURL: 'https://zendou.app/facturation',
            effectiveDirective: 'style-src',
            blockedURL: 'inline',
            disposition: 'enforce',
          },
        },
        // Une enveloppe d'un autre type (deprecation, intervention...) est
        // ignorée : cette boîte aux lettres est celle de la CSP.
        { type: 'deprecation', body: { id: 'obsolete' } },
      ]),
    );

    expect(response.status).toBe(HttpStatus.NO_CONTENT);
    expect(lignes()).toHaveLength(2);
    expect(lignes()[0]).toContain('img-src');
    expect(lignes()[1]).toContain('style-src');
    expect(lignes().join(' ')).not.toContain('obsolete');
  });

  it('ne journalise jamais le corps brut ni script-sample', async () => {
    const secret = 'const jeton = "AKIA-secret-colle-dans-la-page"';

    await post(
      'application/csp-report',
      JSON.stringify({
        'csp-report': {
          'document-uri': 'https://zendou.app/',
          'violated-directive': 'script-src',
          'blocked-uri': 'inline',
          disposition: 'enforce',
          'script-sample': secret,
          'original-policy': "default-src 'none'; script-src 'self'",
        },
      }),
    );

    const journal = lignes().join(' ');

    expect(journal).not.toContain(secret);
    expect(journal).not.toContain('AKIA');
    expect(journal).not.toContain('original-policy');
    expect(journal).not.toContain('script-sample');
  });

  it('tronque chaque valeur à 200 caractères', async () => {
    const enorme = `https://zendou.app/${'a'.repeat(5000)}`;

    await post(
      'application/csp-report',
      JSON.stringify({
        'csp-report': {
          'document-uri': enorme,
          'violated-directive': 'script-src',
          'blocked-uri': enorme,
          disposition: 'enforce',
        },
      }),
    );

    const ligne = lignes()[0];

    expect(ligne).toContain(enorme.slice(0, CSP_FIELD_MAX_LENGTH));
    expect(ligne).not.toContain(enorme.slice(0, CSP_FIELD_MAX_LENGTH + 1));
    // Deux champs tronqués plus les libellés : la ligne reste bornée.
    expect(ligne.length).toBeLessThan(CSP_FIELD_MAX_LENGTH * 2 + 200);
  });

  it('remplace par « ? » un champ que le rapport ne porte pas', async () => {
    await post(
      'application/csp-report',
      JSON.stringify({ 'csp-report': { 'violated-directive': 'font-src' } }),
    );

    expect(lignes()[0]).toContain('document=?');
    expect(lignes()[0]).toContain('directive=font-src');
    expect(lignes()[0]).toContain('bloque=?');
  });

  it('répond 204 sur un corps vide, sans rien journaliser', async () => {
    const response = await request(app.getHttpServer()).post('/csp-report');

    expect(response.status).toBe(HttpStatus.NO_CONTENT);
    expect(response.text).toBe('');
    expect(warned).not.toHaveBeenCalled();
  });

  it('répond 204 sur un corps que le contrôleur ne sait pas lire', async () => {
    // Un navigateur qui reçoit une erreur ne réessaie pas, et un corps
    // inattendu ne doit pas produire une trace d'erreur par chargement de
    // page : tout ce qui n'est pas une violation reconnaissable est
    // silencieusement acquitté.
    const tableau = await post('application/reports+json', '[1, 2, 3]');
    const objet = await post(
      'application/csp-report',
      JSON.stringify({ autre: 'chose' }),
    );
    const enveloppeVide = await post(
      'application/reports+json',
      JSON.stringify([{ type: 'csp-violation' }]),
    );

    expect(tableau.status).toBe(HttpStatus.NO_CONTENT);
    expect(objet.status).toBe(HttpStatus.NO_CONTENT);
    // Une enveloppe sans corps reste une violation annoncée : on la trace,
    // avec des champs inconnus, plutôt que de la perdre.
    expect(enveloppeVide.status).toBe(HttpStatus.NO_CONTENT);
    expect(lignes()).toEqual([
      'Violation CSP · document=? · directive=? · bloque=? · disposition=?',
    ]);
  });
});
