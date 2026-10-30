import '@fontsource/rajdhani/500.css';
import '@fontsource/rajdhani/600.css';
import '@fontsource/rajdhani/700.css';
import '@fontsource/orbitron/700.css';
import '@fontsource/orbitron/900.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/jetbrains-mono/700.css';
import './ui/styles.css';
import { Game } from './core/Game';
import { detectLang, setLang, startTranslator } from './i18n';

startTranslator();

const game = new Game();
setLang(game.settings.language || detectLang());
(window as any).__game = game; // handy for debugging in the console
game.boot().catch((e) => {
  console.error(e);
  const el = document.createElement('div');
  el.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:24px;background:#05070b;color:#ff8da1;font:600 16px/1.5 system-ui;text-align:center;z-index:100';
  el.textContent = `NEON DISTRICT could not start: ${(e as Error).message}. A browser with WebGL 2 is required (recent Chrome, Edge, Safari or Firefox).`;
  document.body.appendChild(el);
});
