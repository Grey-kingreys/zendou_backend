import { buildRecommendedRecords } from './dns-records';

describe('buildRecommendedRecords', () => {
  const records = buildRecommendedRecords('boutique-awa.gn', 'eu-west-3');

  it('publie le MX du MAIL FROM sur bounce.<domaine>, priorité 10, vers l hôte SES de la région', () => {
    expect(records.find((record) => record.type === 'MX')).toMatchObject({
      purpose: 'MX',
      name: 'bounce.boutique-awa.gn',
      value: 'feedback-smtp.eu-west-3.amazonses.com',
      priority: 10,
    });
  });

  it('tire la région de l appelant, jamais d une valeur en dur', () => {
    const other = buildRecommendedRecords('boutique-awa.gn', 'us-east-1');

    expect(other[0].value).toBe('feedback-smtp.us-east-1.amazonses.com');
  });

  it('remplace le SPF du domaine racine par un SPF sur bounce.<domaine>', () => {
    const spf = records.filter((record) => record.purpose === 'SPF');

    expect(spf).toHaveLength(1);
    expect(spf[0]).toMatchObject({
      type: 'TXT',
      name: 'bounce.boutique-awa.gn',
      value: 'v=spf1 include:amazonses.com ~all',
    });
    expect(
      records.some(
        (record) => record.type === 'TXT' && record.name === 'boutique-awa.gn',
      ),
    ).toBe(false);
  });

  it('garde DMARC', () => {
    expect(records.find((record) => record.purpose === 'DMARC')).toMatchObject({
      type: 'TXT',
      name: '_dmarc.boutique-awa.gn',
      value: 'v=DMARC1; p=none;',
    });
  });

  it('explique chaque enregistrement en français, au vouvoiement', () => {
    for (const record of records) {
      expect(record.note.length).toBeGreaterThan(0);
      expect(record.note).not.toMatch(/\b(tu|ton|ta|tes|ajoute|publie)\b/i);
    }
    expect(records[0].note).toContain('priorité 10');
  });
});
