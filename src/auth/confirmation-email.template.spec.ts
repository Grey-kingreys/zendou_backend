import {
  buildConfirmationEmail,
  buildConfirmationUrl,
} from './confirmation-email.template';
import { EMAIL_CONFIRMATION_TTL_HOURS } from './email-confirmation.constants';

describe('buildConfirmationUrl', () => {
  it('construit le lien à partir de la base configurée', () => {
    expect(buildConfirmationUrl('https://zendou.dev', 'abc')).toBe(
      'https://zendou.dev/confirmation?token=abc',
    );
  });

  it('tolère un slash final dans la configuration', () => {
    expect(buildConfirmationUrl('https://zendou.dev/', 'abc')).toBe(
      'https://zendou.dev/confirmation?token=abc',
    );
  });

  /**
   * Le jeton est en base64url : il peut contenir `-` et `_`, jamais `+` ni
   * `/`. L'encodage reste indispensable pour ne rien casser si l'alphabet
   * changeait un jour.
   */
  it('encode le jeton dans la query', () => {
    expect(buildConfirmationUrl('https://zendou.dev', 'a+b/c=')).toBe(
      'https://zendou.dev/confirmation?token=a%2Bb%2Fc%3D',
    );
  });
});

describe('buildConfirmationEmail', () => {
  const url = 'https://zendou.dev/confirmation?token=abc';

  it('fournit toujours les deux variantes, avec le lien dans chacune', () => {
    const { html, text } = buildConfirmationEmail('Aïssatou Diallo', url);

    expect(text).toContain(url);
    expect(html).toContain(url);
    expect(text).toContain('Aïssatou Diallo');
    expect(html).toContain('Aïssatou Diallo');
  });

  it('annonce la durée de validité réelle du lien', () => {
    const { html, text } = buildConfirmationEmail('Awa', url);

    expect(text).toContain(`${EMAIL_CONFIRMATION_TTL_HOURS} heures`);
    expect(html).toContain(`${EMAIL_CONFIRMATION_TTL_HOURS} heures`);
  });

  it('reste correct sans nom exploitable', () => {
    const { text } = buildConfirmationEmail('   ', url);

    expect(text).toContain('Bonjour,');
  });

  /**
   * Le nom vient de l'utilisateur. Sans échappement, il injecterait du
   * balisage dans un email que nous signons en DKIM depuis notre propre
   * domaine — le pire endroit où laisser passer du HTML arbitraire.
   */
  it('échappe le nom avant de l’insérer dans le HTML', () => {
    const { html } = buildConfirmationEmail(
      '<img src=x onerror="alert(1)">',
      url,
    );

    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});
