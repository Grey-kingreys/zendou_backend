import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Type } from '@nestjs/common';
import { AppModule } from '../app.module';
import { API_KEY_ACCESS } from './session-or-api-key.guard';

// `ConfigModule.forRoot` valide l'environnement dès l'import de l'`AppModule` :
// ce balayage lit des métadonnées de classes, il ne doit pas dépendre de
// l'environnement de la machine qui lance les tests.
jest.mock('../config/env.schema', () => ({
  ...jest.requireActual<object>('../config/env.schema'),
  validateEnv: (config: Record<string, unknown>) => config,
}));

/**
 * Découvre par réflexion tous les contrôleurs atteignables depuis l'`AppModule`
 * réel (imports statiques et dynamiques, récursivement). Aucune liste écrite
 * à la main : un contrôleur ajouté demain est balayé sans toucher ce test.
 */
function discoverControllers(root: Type<unknown>): Type<unknown>[] {
  const seen = new Set<unknown>();
  const controllers = new Set<Type<unknown>>();

  const visit = (ref: unknown): void => {
    if (!ref || typeof ref === 'string' || typeof ref === 'symbol') {
      return;
    }
    // Un import peut être une promesse (module asynchrone) : ignoré, on ne
    // sait pas le résoudre ici, et aucun contrôleur n'est déclaré ainsi.
    if (typeof (ref as { then?: unknown }).then === 'function') {
      return;
    }

    const dynamic = ref as Partial<{
      module: Type<unknown>;
      controllers: Type<unknown>[];
      imports: unknown[];
    }>;
    const moduleClass = dynamic.module
      ? dynamic.module
      : (ref as Type<unknown>);

    if (seen.has(ref) && seen.has(moduleClass)) {
      return;
    }
    seen.add(ref);
    seen.add(moduleClass);

    const declared = [
      ...((Reflect.getMetadata('controllers', moduleClass) as
        Type<unknown>[] | undefined) ?? []),
      ...(dynamic.controllers ?? []),
    ];
    declared.forEach((controller) => controllers.add(controller));

    const imports = [
      ...((Reflect.getMetadata('imports', moduleClass) as
        unknown[] | undefined) ?? []),
      ...(dynamic.imports ?? []),
    ];
    imports.forEach(visit);
  };

  visit(root);

  return [...controllers];
}

/** Routes d'un contrôleur : méthodes portant une métadonnée de verbe HTTP. */
function routesOf(
  controller: Type<unknown>,
): { name: string; handler: object }[] {
  return Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => ({
      name,
      handler: (controller.prototype as Record<string, unknown>)[
        name
      ] as object,
    }))
    .filter(
      ({ handler }) =>
        typeof handler === 'function' && Reflect.hasMetadata('method', handler),
    );
}

/**
 * Seules cinq routes de toute l'application s'ouvrent à une clé API par une
 * marque explicite : le solde (toute clé active) et les quatre routes de
 * lecture (clé avec `canRead`). Une marque ajoutée ailleurs doit casser ce test.
 */
describe('Marques de route clé API - balayage de tous les contrôleurs', () => {
  const controllers = discoverControllers(AppModule);
  const marked = controllers
    .flatMap((controller) =>
      routesOf(controller).map(({ name, handler }) => ({
        route: `${controller.name}.${name}`,
        access: Reflect.getMetadata(API_KEY_ACCESS, handler) as
          string | undefined,
      })),
    )
    .filter(({ access }) => access !== undefined)
    .map(({ route, access }) => `${route}:${access}`)
    .sort();

  it('découvre exactement les contrôleurs présents dans les sources (pas un balayage partiel)', () => {
    // Recensement indépendant : tout fichier source qui déclare `@Controller(`.
    const onDisk: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
        } else if (
          entry.name.endsWith('.ts') &&
          !entry.name.includes('.spec')
        ) {
          const match =
            /^@Controller\([^)]*\)\s*(?:@\w+\([^)]*\)\s*)*export class (\w+)/m.exec(
              readFileSync(path, 'utf-8'),
            );
          if (match) {
            onDisk.push(match[1]);
          }
        }
      }
    };
    walk(join(__dirname, '..'));

    expect(onDisk.length).toBeGreaterThan(10);
    expect(controllers.map((c) => c.name).sort()).toEqual(onDisk.sort());
    expect(
      controllers.reduce((sum, c) => sum + routesOf(c).length, 0),
    ).toBeGreaterThan(40);
  });

  it('n’ouvre à une clé que le solde et les quatre routes de lecture', () => {
    expect(marked).toEqual(
      [
        'BillingController.getBalance:any',
        'DomainsController.findOne:read',
        'DomainsController.list:read',
        'EmailsLogController.detail:read',
        'EmailsLogController.list:read',
      ].sort(),
    );
  });
});
