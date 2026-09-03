import { MAX_BOUNCE_RATE, MAX_COMPLAINT_RATE } from './reputation.constants';
import type { ReputationMetrics } from './reputation.types';
import { buildSuspensionAlertEmail } from './suspension-alert.template';

const METRICS: ReputationMetrics = {
  sent: 100,
  bounces: 9,
  hardBounces: 6,
  transientBounces: 3,
  complaints: 2,
  bounceRate: 0.06,
  complaintRate: 0.02,
  verdict: 'SUSPEND',
};

function alertEmail(overrides: Record<string, unknown> = {}) {
  return buildSuspensionAlertEmail({
    email: 'contact@boutique-awa.gn',
    userId: 'user_1',
    reason:
      'Suspension automatique : taux de rebonds durs 6.00 % (6/100, seuil 5.00 %)',
    metrics: METRICS,
    adminUrl: 'https://app.zendou.dev/admin/comptes/user_1',
    ...overrides,
  });
}

describe('buildSuspensionAlertEmail (E2)', () => {
  it('nomme le compte suspendu dans le sujet', () => {
    expect(alertEmail().subject).toBe(
      'Suspension automatique du compte contact@boutique-awa.gn',
    );
  });

  it('donne le compte, son identifiant et le motif dans les deux corps', () => {
    const { text, html } = alertEmail();

    for (const body of [text, html]) {
      expect(body).toContain('contact@boutique-awa.gn');
      expect(body).toContain('user_1');
      expect(body).toContain('taux de rebonds durs 6.00 %');
    }
  });

  it('donne les métriques, leurs taux, les seuils et la fenêtre', () => {
    const { text } = alertEmail();

    expect(text).toContain('Envois sur la fenêtre : 100');
    expect(text).toContain('Rebonds durs : 6 (6.00 %');
    expect(text).toContain(`seuil ${(MAX_BOUNCE_RATE * 100).toFixed(2)} %`);
    expect(text).toContain('Rebonds transitoires, non sanctionnés : 3');
    expect(text).toContain('Plaintes : 2 (2.00 %');
    expect(text).toContain(`seuil ${(MAX_COMPLAINT_RATE * 100).toFixed(2)} %`);
    expect(text).toContain("Fenêtre d'observation : 30 jours");
  });

  it('porte le lien de la fiche admin, en texte comme en HTML', () => {
    const { text, html } = alertEmail();

    expect(text).toContain('https://app.zendou.dev/admin/comptes/user_1');
    expect(html).toContain(
      'href="https://app.zendou.dev/admin/comptes/user_1"',
    );
  });

  /**
   * L'adresse et le motif viennent de la base, pas de nous : ils n'ont rien à
   * faire en balisage brut dans un email que nous signons en DKIM.
   */
  it('échappe le HTML des valeurs interpolées', () => {
    const { html } = alertEmail({
      email: '<script>alerte()</script>@exemple.gn',
    });

    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('n’écrit aucun tiret cadratin ni demi-cadratin, sujet et corps compris', () => {
    const { subject, text, html } = alertEmail();

    expect(subject).not.toMatch(/[\u2013\u2014]/);
    expect(text).not.toMatch(/[\u2013\u2014]/);
    expect(html).not.toMatch(/[\u2013\u2014]/);
  });
});
