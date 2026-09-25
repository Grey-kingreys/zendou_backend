import {
  buildInactivityWarningEmail,
  buildLoginUrl,
} from './inactivity-warning.template';

describe('buildInactivityWarningEmail', () => {
  const email = buildInactivityWarningEmail({
    name: 'Awa <Diallo>',
    anonymizationDate: new Date('2028-01-01T00:00:00.000Z'),
    loginUrl: buildLoginUrl('https://zendou.app/'),
  });

  it('dit ce qui va se passer, à quelle date, et comment l’éviter', () => {
    expect(email.subject).toBe(
      'Votre compte Zendou sera anonymisé le 1 janvier 2028',
    );
    for (const body of [email.text, email.html]) {
      expect(body).toContain('1 janvier 2028');
      expect(body).toContain('anonymisé');
      expect(body).toContain('traces de paiement');
      expect(body).toContain('il suffit de vous connecter');
      expect(body).toContain('https://zendou.app/connexion');
    }
  });

  it('échappe le nom dans la version HTML', () => {
    expect(email.html).toContain('Awa &lt;Diallo&gt;');
    expect(email.html).not.toContain('<Diallo>');
  });

  it('ne contient ni tiret cadratin ni demi-cadratin', () => {
    const all = email.text + email.html + email.subject;
    for (const code of [0x2013, 0x2014]) {
      expect(all).not.toContain(String.fromCharCode(code));
    }
  });
});
