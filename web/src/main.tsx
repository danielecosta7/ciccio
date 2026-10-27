import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
// Font inclusi nel progetto: nessuna richiesta a Google Fonts.
import '@fontsource/geist/400.css';
import '@fontsource/geist/500.css';
import '@fontsource/geist/600.css';
import '@fontsource/geist/700.css';
import '@fontsource/geist-mono/400.css';
import '@fontsource/geist-mono/500.css';
import '@fontsource/silkscreen/400.css';
import './styles.css';
import { MotionConfig } from 'motion/react';
import { App } from './App';
import { AuthGate } from './Auth';
import { installViewport } from './viewport';

// Safari su iPhone ignora user-scalable=no per il pizzico: lo si ferma qui. L'anteprima delle immagini
// ingrandisce da sé con due dita (FileViewer), senza zoomare la pagina.
for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) {
  document.addEventListener(ev, (e) => e.preventDefault(), { passive: false });
}
installViewport();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {/* Chi chiede meno movimento nel sistema ottiene dissolvenze al posto degli spostamenti. */}
    <MotionConfig reducedMotion="user" transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}>
      <AuthGate>
        <App />
      </AuthGate>
    </MotionConfig>
  </StrictMode>,
);
