import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { VitePWA } from 'vite-plugin-pwa';

// Tampon de build affiché dans les réglages. Repris de Mochi (vite.config.ts) et
// pour la même raison : après un déploiement, « est-ce que ma version est passée ? »
// doit se répondre d'un coup d'œil. Sans lui, un service worker qui sert encore
// l'ancien cache est indiscernable d'un build cassé.
function buildId(): string {
  let hash = 'sans-git';
  try {
    hash = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    // Pas de dépôt (archive, CI minimale) : l'horodatage suffit à trancher.
  }
  return `${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${hash}`;
}

// PORT 5175, et pas 5174 : Mochi occupe 5174 et les deux doivent pouvoir tourner
// EN MÊME TEMPS sur le PC de dev (on compare les deux personnages). Un PORT dans
// l'environnement reste prioritaire (preview).
const port = process.env.PORT ? Number(process.env.PORT) : 5175;

// strictPort TOUJOURS : le défaut de Vite est de GLISSER sur le port suivant quand
// le sien est pris — c'est ce qui fait qu'on sert un jour sur 5176 pendant que le
// téléphone interroge 5175 et affiche une page blanche, sans rien dans les logs.
const strictPort = true;

// HTTPS optionnel (certificat auto-signé) : nécessaire pour tester le MICRO sur un
// téléphone via le WiFi (getUserMedia exige un contexte sécurisé). `npm run dev:https`.
const https = !!process.env.HTTPS;

export default defineConfig({
  // ⚠️ UNE SEULE VALEUR, ET ELLE IMPOSE LE NOM DU DÉPÔT. Pages sert sous le nom du
  // dépôt et github.io est sensible à la casse : il faut donc un dépôt `loro` EN
  // MINUSCULES pour que iapafoto.github.io/loro/ résolve. Contrainte héritée de
  // Mochi ; facile à changer avant le premier déploiement, coûteux après.
  base: '/loro/',
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
  plugins: [
    ...(https ? [basicSsl()] : []),
    VitePWA({
      // 'prompt' = « ne bascule pas tout seul, rends-moi la main » ; c'est pwa.ts
      // qui applique. Cf. src/pwa.ts pour la politique de mise à jour.
      registerType: 'prompt',
      injectRegister: null,
      // Manifeste écrit à la main dans public/ et référencé par index.html.
      manifest: false,
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,webmanifest}'],
        navigateFallback: 'index.html',
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port,
    strictPort,
    host: true,
    // Le navigateur du pane de preview met en cache les modules ES sans revalider :
    // on désactive tout cache en dev pour toujours servir le code frais.
    headers: { 'Cache-Control': 'no-store' },
  },
  // Import de fichiers .frag comme chaînes brutes (shader du visage).
  assetsInclude: ['**/*.frag'],
});
