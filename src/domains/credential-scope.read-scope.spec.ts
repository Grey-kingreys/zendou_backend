import type { PrismaService } from '../prisma/prisma.service';
import { resolveReadScope } from './credential-scope';

describe('resolveReadScope (portée de lecture d’une clé API)', () => {
  const findUnique = jest.fn();
  const prisma = { apiKey: { findUnique } } as unknown as PrismaService;

  beforeEach(() => findUnique.mockReset());

  it('rend null pour une session (aucune clé), sans lire la base', async () => {
    await expect(resolveReadScope(prisma, undefined)).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rend null pour une clé ALL, même si des liens de jointure traînent', async () => {
    findUnique.mockResolvedValue({
      domainScope: 'ALL',
      domains: [{ domainId: 'dom_a' }],
    });

    await expect(resolveReadScope(prisma, 'k1')).resolves.toBeNull();
  });

  it('rend les domaines liés pour une clé SELECTED', async () => {
    findUnique.mockResolvedValue({
      domainScope: 'SELECTED',
      domains: [{ domainId: 'dom_a' }, { domainId: 'dom_b' }],
    });

    await expect(resolveReadScope(prisma, 'k1')).resolves.toEqual([
      'dom_a',
      'dom_b',
    ]);
  });

  it('rend une liste vide pour une clé SELECTED sans domaine', async () => {
    findUnique.mockResolvedValue({ domainScope: 'SELECTED', domains: [] });

    await expect(resolveReadScope(prisma, 'k1')).resolves.toEqual([]);
  });

  it('rend une liste vide pour une clé introuvable (fail-closed)', async () => {
    findUnique.mockResolvedValue(null);

    await expect(resolveReadScope(prisma, 'inconnue')).resolves.toEqual([]);
  });
});
