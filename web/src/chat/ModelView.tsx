import { useEffect, useRef, useState } from 'react';
import type { Object3D } from 'three';

/**
 * Modelli 3D (STL, OBJ, 3MF) come in un visualizzatore da stampa: il pezzo appoggiato su una griglia,
 * da girare col mouse o col dito, con le misure d'ingombro. three.js arriva solo quando serve.
 */
export function ModelView({ url, path }: { url: string; path: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState('');
  const [size, setSize] = useState<[number, number, number] | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    let alive = true;
    let stop = () => {};
    setErr(''); setSize(null);
    void (async () => {
      const THREE = await import('three');
      const { OrbitControls } = await import('three/examples/jsm/controls/OrbitControls.js');
      const r = await fetch(url);
      if (!r.ok) throw new Error(r.status === 404 ? 'File non trovato: forse è stato spostato o cancellato.' : `Errore ${r.status}`);
      const buf = await r.arrayBuffer();
      if (!alive) return;

      const ext = path.split('.').pop()?.toLowerCase();
      const material = new THREE.MeshStandardMaterial({ color: 0xc9cdd2, metalness: 0.05, roughness: 0.55 });
      let object: Object3D;
      if (ext === 'stl') {
        const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
        const geo = new STLLoader().parse(buf);
        geo.computeVertexNormals();
        object = new THREE.Mesh(geo, material);
      } else if (ext === '3mf') {
        const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
        object = new ThreeMFLoader().parse(buf);
      } else {
        const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
        object = new OBJLoader().parse(new TextDecoder().decode(buf));
        object.traverse((o) => { if ((o as import('three').Mesh).isMesh) (o as import('three').Mesh).material = material; });
      }
      // STL e 3MF hanno la Z in alto (come le stampanti), three.js la Y.
      if (ext !== 'obj') object.rotation.x = -Math.PI / 2;
      const model = new THREE.Group();
      model.add(object);
      model.updateMatrixWorld(true);
      const bounds = new THREE.Box3().setFromObject(model);
      if (bounds.isEmpty()) throw new Error('Il file non contiene forme da disegnare.');
      const dims = bounds.getSize(new THREE.Vector3());
      const center = bounds.getCenter(new THREE.Vector3());
      // Centrato e appoggiato sulla griglia.
      model.position.set(-center.x, -bounds.min.y, -center.z);
      const span = Math.max(dims.x, dims.y, dims.z) || 1;

      const scene = new THREE.Scene();
      scene.add(model);
      const grid = new THREE.GridHelper(span * 2.5, 20, 0x5a5a5a, 0x333333);
      scene.add(grid);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3a3a, 1.3));
      const camera = new THREE.PerspectiveCamera(40, 1, span / 200, span * 100);
      // La luce principale segue la vista: il lato che guardi è sempre illuminato.
      const key = new THREE.DirectionalLight(0xffffff, 2.2);
      key.position.set(1, 1.5, 2);
      camera.add(key);
      scene.add(camera);
      camera.position.set(span * 1.7, span * 1.25, span * 2.1);

      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.domElement.style.display = 'block';
      renderer.domElement.style.touchAction = 'none';
      el.append(renderer.domElement);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.target.set(0, dims.y / 2, 0);
      controls.enableDamping = true;
      controls.update();

      const fit = () => {
        const w = el.clientWidth, h = el.clientHeight;
        if (!w || !h) return;
        renderer.setSize(w, h, false);
        renderer.domElement.style.width = '100%';
        renderer.domElement.style.height = '100%';
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      };
      fit();
      const ro = new ResizeObserver(fit);
      ro.observe(el);
      let raf = 0;
      const tick = () => { controls.update(); renderer.render(scene, camera); raf = requestAnimationFrame(tick); };
      tick();
      setSize([dims.x, dims.z, dims.y]);
      stop = () => {
        cancelAnimationFrame(raf);
        ro.disconnect();
        controls.dispose();
        scene.traverse((o) => {
          const m = o as import('three').Mesh;
          if (m.isMesh) { m.geometry.dispose(); (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => x.dispose()); }
        });
        renderer.dispose();
        renderer.domElement.remove();
      };
      if (!alive) stop();
    })().catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; stop(); };
  }, [url, path]);

  const mm = (n: number) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10).toLocaleString('it-IT');
  return (
    <div className="relative h-full min-h-[60vh] w-full overflow-hidden rounded-[8px] border border-line bg-[oklch(0.17_0_0)]">
      <div ref={box} className="absolute inset-0" />
      {err && <div className="absolute inset-x-0 top-0 p-4 text-[13px] text-block">Non riesco a disegnare il modello: {err}</div>}
      {!err && !size && <div className="absolute inset-x-0 top-0 p-4 text-[13px] text-muted">Preparo l’anteprima…</div>}
      {size && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-wrap items-center justify-between gap-2 p-3 font-mono text-[11.5px] text-muted">
          <span>{mm(size[0])} × {mm(size[1])} × {mm(size[2])} mm</span>
          <span className="hidden sm:inline">Trascina per girare · rotella per lo zoom · tasto destro per spostare</span>
        </div>
      )}
    </div>
  );
}
