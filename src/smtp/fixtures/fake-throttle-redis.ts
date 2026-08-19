import type Redis from 'ioredis';

/**
 * Redis en mémoire pour l'anti-abus SMTP (B6/S9).
 *
 * Deux suites s'en servent — les tests unitaires du service et le test
 * d'intégration en processus — et elles doivent voir **le même** comportement,
 * sans quoi la seconde pourrait passer sur une fiction que la première ne
 * couvre pas. D'où un double partagé plutôt que deux imitations parallèles.
 *
 * Il **compte réellement** au lieu de rendre des réponses pré-programmées :
 * `INCR` incrémente, `SADD` déduplique, `SCARD` compte. C'est ce qui permet de
 * vérifier les plafonds en appelant le service autant de fois qu'un attaquant
 * le ferait, plutôt qu'en simulant la valeur qu'on veut voir. Les fenêtres
 * (`PEXPIRE`), elles, ne sont pas simulées : aucun test ne dépend du temps qui
 * passe — la durée demandée est simplement enregistrée pour être assertée.
 *
 * Volontairement sans `jest.fn()` : ce fichier vit avec les fixtures MIME, donc
 * dans le périmètre de compilation de production, et ne doit référencer aucun
 * global de test.
 */

/** Définition d'un script Lua telle que `defineCommand` la reçoit. */
export interface FakeDefinedCommand {
  numberOfKeys: number;
  lua: string;
}

/** Appel enregistré du script « incrémenter dans une fenêtre ». */
export interface FakeHitCall {
  key: string;
  windowMs: string;
}

/** Appel enregistré du script « compter des valeurs distinctes ». */
export interface FakeDistinctCall {
  key: string;
  member: string;
  windowMs: string;
}

export class FakeThrottleRedis {
  /** Scripts enregistrés par le service, par nom. */
  readonly definedCommands = new Map<string, FakeDefinedCommand>();

  /** Tous les appels de compteur, dans l'ordre. */
  readonly hitCalls: FakeHitCall[] = [];

  /** Tous les appels d'ensemble, dans l'ordre. */
  readonly distinctCalls: FakeDistinctCall[] = [];

  /** `disconnect()` a-t-il été appelé (arrêt du module) ? */
  disconnected = false;

  /** Quand vrai, toute commande échoue — pour éprouver le repli « laisser passer ». */
  failing = false;

  private readonly counters = new Map<string, number>();
  private readonly sets = new Map<string, Set<string>>();

  defineCommand(name: string, definition: FakeDefinedCommand): void {
    this.definedCommands.set(name, definition);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  zendouSmtpHit = (
    key: string,
    windowMs: string,
  ): Promise<[number, number]> => {
    this.hitCalls.push({ key, windowMs });

    if (this.failing) {
      return Promise.reject(new Error('Redis injoignable'));
    }

    const hits = (this.counters.get(key) ?? 0) + 1;
    this.counters.set(key, hits);

    return Promise.resolve([hits, Number(windowMs)]);
  };

  zendouSmtpDistinct = (
    key: string,
    member: string,
    windowMs: string,
  ): Promise<[number]> => {
    this.distinctCalls.push({ key, member, windowMs });

    if (this.failing) {
      return Promise.reject(new Error('Redis injoignable'));
    }

    const members = this.sets.get(key) ?? new Set<string>();
    members.add(member);
    this.sets.set(key, members);

    return Promise.resolve([members.size]);
  };

  /**
   * Toutes les clés écrites, répétitions comprises — compteurs d'abord,
   * ensembles ensuite. Sert aux assertions d'**absence** (« aucune clé par IP
   * n'a été écrite ») ; pour l'ordre exact d'une famille, lire `hitCalls` ou
   * `distinctCalls`. C'est la donnée que les specs assertent **littéralement** :
   * une clé mal formée ou mal préfixée se voit ici, pas dans un comportement
   * dérivé.
   */
  get writtenKeys(): string[] {
    return [
      ...this.hitCalls.map((call) => call.key),
      ...this.distinctCalls.map((call) => call.key),
    ];
  }

  /** Se donne pour un `Redis` — le service n'utilise que ce qu'implémente ce double. */
  asRedis(): Redis {
    return this as unknown as Redis;
  }
}
