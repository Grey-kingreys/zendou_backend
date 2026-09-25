import type { Prisma } from '@prisma/client';
import { ACTIVITY_WRITE_INTERVAL_MS } from './account-lifecycle.constants';

/** Ce dont l'enregistrement d'activité a besoin : `user.updateMany`, rien de plus. */
export interface ActivityStore {
  user: {
    updateMany(args: {
      where: Prisma.UserWhereInput;
      data: Prisma.UserUpdateManyMutationInput;
    }): Promise<{ count: number }>;
  };
}

/**
 * Enregistre une activité du titulaire (ANON-1) : connexion ou envoi client
 * accepté. **Au plus une écriture par heure et par compte**, garantie à deux
 * niveaux :
 *
 * 1. si l'appelant connaît déjà `lastActivityAt` (il vient de lire la ligne),
 *    une valeur de moins d'une heure court-circuite tout : aucune requête ;
 * 2. sinon, l'écriture est conditionnelle (`lastActivityAt` nul ou vieux
 *    d'une heure au moins) : c'est la base qui arbitre, y compris entre deux
 *    répliques de l'API qui traitent le même compte au même instant.
 *
 * Lève en même temps l'avertissement d'inactivité éventuel : un compte qui
 * redevient actif sort du circuit d'anonymisation. Un compte anonymisé n'est
 * jamais touché.
 *
 * @returns `true` si une écriture a eu lieu.
 */
export async function recordAccountActivity(
  store: ActivityStore,
  userId: string,
  now: Date = new Date(),
  known?: Date | null,
): Promise<boolean> {
  const threshold = new Date(now.getTime() - ACTIVITY_WRITE_INTERVAL_MS);

  if (known instanceof Date && known.getTime() > threshold.getTime()) {
    return false;
  }

  const result = await store.user.updateMany({
    where: {
      id: userId,
      anonymizedAt: null,
      OR: [{ lastActivityAt: null }, { lastActivityAt: { lte: threshold } }],
    },
    data: { lastActivityAt: now, inactivityWarningSentAt: null },
  });

  return result.count > 0;
}
