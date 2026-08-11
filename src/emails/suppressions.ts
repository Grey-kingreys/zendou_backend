import type { PrismaService } from '../prisma/prisma.service';

/**
 * Indique si une adresse est bloquée pour ce client, soit par une entrée
 * qui lui est propre (`userId`), soit par une entrée globale à la
 * plateforme (`userId` nul — bounce dur ou plainte constatée ailleurs).
 *
 * Utilisée deux fois : à l'acceptation de la requête, puis à nouveau par
 * le worker, l'adresse ayant pu être supprimée entre-temps.
 */
export async function isAddressSuppressed(
  prisma: PrismaService,
  userId: string,
  address: string,
): Promise<boolean> {
  const suppression = await prisma.suppression.findFirst({
    where: { address, OR: [{ userId }, { userId: null }] },
    select: { id: true },
  });

  return suppression !== null;
}
