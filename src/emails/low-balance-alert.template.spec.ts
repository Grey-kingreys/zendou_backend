import {
  buildBillingUrl,
  buildLowBalanceAlertEmail,
} from './low-balance-alert.template';

describe('buildLowBalanceAlertEmail', () => {
  const input = {
    name: 'Awa <Diallo>',
    balance: 87,
    billingUrl: 'https://zendou.app/dashboard/facturation',
  };

  it('dit le solde restant, l’arrêt à 0 (erreur 402) et donne le lien de facturation', () => {
    const { subject, text, html } = buildLowBalanceAlertEmail(input);

    expect(subject).toContain('solde');
    expect(text).toContain('Il vous reste 87 crédits');
    expect(text).toContain('0');
    expect(text).toContain('402');
    expect(text).toContain(input.billingUrl);
    expect(html).toContain(`href="${input.billingUrl}"`);
  });

  it('échappe le nom dans la version HTML', () => {
    const { html } = buildLowBalanceAlertEmail(input);

    expect(html).toContain('Awa &lt;Diallo&gt;');
    expect(html).not.toContain('<Diallo>');
  });

  it('accorde « crédit » au singulier', () => {
    expect(buildLowBalanceAlertEmail({ ...input, balance: 1 }).text).toContain(
      'Il vous reste 1 crédit sur',
    );
  });
});

describe('buildBillingUrl', () => {
  it('pointe sur la page de facturation, sans double slash', () => {
    expect(buildBillingUrl('https://zendou.app/')).toBe(
      'https://zendou.app/dashboard/facturation',
    );
    expect(buildBillingUrl(' http://localhost:3000 ')).toBe(
      'http://localhost:3000/dashboard/facturation',
    );
  });
});
