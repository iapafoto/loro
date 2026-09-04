import { registerSW } from 'virtual:pwa-register';

/**
 * Service worker : cache durable + POLITIQUE DE MISE À JOUR (repris de Mochi).
 *
 * Le piège si on ne fait rien : un nouveau service worker s'installe, passe en
 * « waiting », et s'arrête là tant qu'un client de l'ancien tourne — l'app continue
 * de servir L'ANCIEN CODE, sans rien signaler. On pousse, on relance, on voit
 * l'ancienne version, on conclut que le build est cassé. La règle tient en une
 * ligne : on applique dès que c'est disponible.
 */
export interface PwaHooks {
  log(line: string): void;
}

export function setupPwa(hooks: PwaHooks): void {
  if (!import.meta.env.PROD) return;

  void requestPersistentStorage(hooks.log);

  const updateSW = registerSW({
    onNeedRefresh() {
      hooks.log('⬆ mise à jour : rechargement…');
      void updateSW(true); // skipWaiting + reload
    },
    onOfflineReady() {
      hooks.log('📦 app en cache — elle démarrera même sans réseau');
    },
    onRegisterError(err: unknown) {
      hooks.log(`⚠ service worker non enregistré : ${(err as Error).message}`);
    },
  });
}

/**
 * Demande un stockage DURABLE. Sans ça, Chrome peut évincer le cache ET le carnet
 * (localStorage) sous pression de stockage — sur un téléphone plein de photos, ça
 * arrive. Ici l'enjeu est plus grave que chez Mochi : le carnet est la mémoire de la
 * progression, on ne veut pas la perdre.
 */
async function requestPersistentStorage(log: (line: string) => void): Promise<void> {
  if (!navigator.storage?.persist) return;
  try {
    if (await navigator.storage.persisted()) return;
    const granted = await navigator.storage.persist();
    if (!granted) log('ℹ stockage non durable — le carnet et la clé peuvent être évincés');
  } catch {
    // API refusée ou indisponible : sans conséquence.
  }
}
