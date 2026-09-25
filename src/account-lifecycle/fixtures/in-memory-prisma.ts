/**
 * Double en mémoire de Prisma pour les tests du cycle de vie des comptes
 * (ANON-1). Sémantique réelle sur le sous-ensemble utilisé : filtres `where`
 * (égalité, `null`, `not`, `lt`/`lte`/`gt`/`gte`, `in`, `OR`, `AND`),
 * `findUnique`/`findFirst`/`findMany`/`count`/`create`/`update`/
 * `updateMany`/`deleteMany`, relation `user` en `select`, et transactions
 * **avec retour arrière** (instantané restauré si la fonction lève).
 */

type Row = Record<string, unknown>;

const MODELS = [
  'user',
  'domain',
  'apiKey',
  'smtpCredential',
  'email',
  'creditEntry',
  'topUpRequest',
  'adminAction',
  'suppression',
] as const;

export type ModelName = (typeof MODELS)[number];

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return a === b;
}

function compare(a: unknown, b: unknown): number {
  const left = a instanceof Date ? a.getTime() : (a as number);
  const right = b instanceof Date ? b.getTime() : (b as number);
  return left < right ? -1 : left > right ? 1 : 0;
}

function matchField(value: unknown, condition: unknown): boolean {
  if (condition === null) {
    return value === null || value === undefined;
  }

  if (
    typeof condition === 'object' &&
    !(condition instanceof Date) &&
    !Array.isArray(condition)
  ) {
    const ops = condition as Record<string, unknown>;
    for (const [op, operand] of Object.entries(ops)) {
      switch (op) {
        case 'equals':
          if (!matchField(value, operand)) return false;
          break;
        case 'not':
          if (matchField(value, operand)) return false;
          break;
        case 'in':
          if (!(operand as unknown[]).some((item) => sameValue(value, item)))
            return false;
          break;
        case 'lt':
        case 'lte':
        case 'gt':
        case 'gte': {
          if (value === null || value === undefined) return false;
          const c = compare(value, operand);
          if (op === 'lt' && !(c < 0)) return false;
          if (op === 'lte' && !(c <= 0)) return false;
          if (op === 'gt' && !(c > 0)) return false;
          if (op === 'gte' && !(c >= 0)) return false;
          break;
        }
        default:
          throw new Error(`Opérateur non pris en charge : ${op}`);
      }
    }
    return true;
  }

  return sameValue(value, condition);
}

export function matches(row: Row, where: Row = {}): boolean {
  for (const [key, condition] of Object.entries(where)) {
    if (condition === undefined) continue;
    if (key === 'OR') {
      if (!(condition as Row[]).some((sub) => matches(row, sub))) return false;
    } else if (key === 'AND') {
      if (!(condition as Row[]).every((sub) => matches(row, sub))) return false;
    } else if (key === 'NOT') {
      if (matches(row, condition as Row)) return false;
    } else if (!matchField(row[key], condition)) {
      return false;
    }
  }
  return true;
}

let sequence = 0;

export class InMemoryPrisma {
  tables: Record<ModelName, Row[]> = Object.fromEntries(
    MODELS.map((name) => [name, [] as Row[]]),
  ) as Record<ModelName, Row[]>;

  user = this.model('user');
  domain = this.model('domain');
  apiKey = this.model('apiKey');
  smtpCredential = this.model('smtpCredential');
  email = this.model('email');
  creditEntry = this.model('creditEntry');
  topUpRequest = this.model('topUpRequest');
  adminAction = this.model('adminAction');
  suppression = this.model('suppression');

  async $transaction<T>(run: (tx: this) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.tables);
    try {
      return await run(this);
    } catch (error) {
      this.tables = snapshot;
      throw error;
    }
  }

  /** Copie profonde de l'état, pour comparer avant et après. */
  snapshot(): Record<ModelName, Row[]> {
    return structuredClone(this.tables);
  }

  seed(name: ModelName, row: Row): Row {
    const full = { id: `${name}_${++sequence}`, ...row };
    this.tables[name].push(full);
    return full;
  }

  private withRelations(name: ModelName, row: Row, select?: Row): Row {
    const copy: Row = { ...row };
    if (select && typeof select.user === 'object' && 'userId' in row) {
      copy.user = this.tables.user.find((user) => user.id === row.userId);
    }
    return copy;
  }

  private model(name: ModelName) {
    const rows = (): Row[] => this.tables[name];

    return {
      findUnique: (args: { where: Row; select?: Row }) => {
        const found = rows().find((row) => matches(row, args.where));
        return Promise.resolve(
          found ? this.withRelations(name, found, args.select) : null,
        );
      },
      findUniqueOrThrow: (args: { where: Row }) => {
        const found = rows().find((row) => matches(row, args.where));
        if (!found) return Promise.reject(new Error(`${name} introuvable`));
        return Promise.resolve({ ...found });
      },
      findFirst: (args: { where?: Row; select?: Row } = {}) => {
        const found = rows().find((row) => matches(row, args.where));
        return Promise.resolve(
          found ? this.withRelations(name, found, args.select) : null,
        );
      },
      findMany: (args: { where?: Row; take?: number } = {}) => {
        const found = rows()
          .filter((row) => matches(row, args.where))
          .slice(0, args.take ?? Infinity)
          .map((row) => ({ ...row }));
        return Promise.resolve(found);
      },
      count: (args: { where?: Row } = {}) =>
        Promise.resolve(
          rows().filter((row) => matches(row, args.where)).length,
        ),
      create: (args: { data: Row }) => {
        const now = new Date();
        const defaults: Row =
          name === 'user'
            ? {
                status: 'ACTIVE',
                role: 'CUSTOMER',
                company: null,
                declaredUsage: null,
                passwordHash: null,
                googleSub: null,
                emailVerifiedAt: null,
                lastActivityAt: null,
                anonymizedAt: null,
                inactivityWarningSentAt: null,
                createdAt: now,
              }
            : { createdAt: now };
        return Promise.resolve({
          ...this.seed(name, { ...defaults, ...args.data }),
        });
      },
      update: (args: { where: Row; data: Row }) => {
        const found = rows().find((row) => matches(row, args.where));
        if (!found) return Promise.reject(new Error(`${name} introuvable`));
        Object.assign(found, args.data);
        return Promise.resolve({ ...found });
      },
      updateMany: (args: { where: Row; data: Row }) => {
        const found = rows().filter((row) => matches(row, args.where));
        for (const row of found) Object.assign(row, args.data);
        return Promise.resolve({ count: found.length });
      },
      deleteMany: (args: { where?: Row } = {}) => {
        const before = rows().length;
        this.tables[name] = rows().filter((row) => !matches(row, args.where));
        return Promise.resolve({ count: before - this.tables[name].length });
      },
    };
  }
}
