import { createHash, createHmac } from 'crypto';
import { ConfigService } from '@nestjs/config';
import { SecretHashingService } from './secret-hashing.service';

const SECRET = 'zd_live_secret-de-test';
const PEPPER = 'p'.repeat(64);

function serviceWith(pepper?: string): SecretHashingService {
  return new SecretHashingService({
    get: (key: string) => (key === 'API_KEY_PEPPER' ? pepper : undefined),
  } as unknown as ConfigService);
}

const legacyHash = createHash('sha256').update(SECRET).digest('hex');
const pepperedHash = createHmac('sha256', PEPPER).update(SECRET).digest('hex');

describe('SecretHashingService - sans poivre (comportement historique)', () => {
  const service = serviceWith(undefined);

  it('hache en SHA-256 nu, exactement comme avant E3', () => {
    expect(service.hashForStorage(SECRET)).toBe(legacyHash);
  });

  it('ne cherche qu’une seule empreinte : il n’y a rien d’autre en base', () => {
    expect(service.candidateHashes(SECRET)).toEqual([legacyHash]);
  });

  it('ne déclare jamais une empreinte à migrer : il n’y a nulle part où aller', () => {
    expect(service.isLegacy(legacyHash, SECRET)).toBe(false);
  });

  it('traite un poivre vide comme absent', () => {
    expect(serviceWith('').hashForStorage(SECRET)).toBe(legacyHash);
  });
});

describe('SecretHashingService - avec poivre (E3)', () => {
  const service = serviceWith(PEPPER);

  it('persiste un HMAC-SHA256 poivré, jamais le SHA-256 nu', () => {
    expect(service.hashForStorage(SECRET)).toBe(pepperedHash);
    expect(service.hashForStorage(SECRET)).not.toBe(legacyHash);
  });

  it('cherche la forme poivrée d’abord, l’historique ensuite', () => {
    expect(service.candidateHashes(SECRET)).toEqual([pepperedHash, legacyHash]);
  });

  it('reconnaît une empreinte historique comme à migrer, la poivrée non', () => {
    expect(service.isLegacy(legacyHash, SECRET)).toBe(true);
    expect(service.isLegacy(pepperedHash, SECRET)).toBe(false);
  });

  it('change d’empreinte quand le poivre change : deux poivres, deux résultats', () => {
    expect(serviceWith('q'.repeat(64)).hashForStorage(SECRET)).not.toBe(
      pepperedHash,
    );
  });
});
