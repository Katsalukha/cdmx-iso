// cdmx-iso — photoreal isometric viewer for CDMX
// Phase 1: load Google Photorealistic 3D Tiles for one location under a fixed
// true-isometric orthographic camera. See plan + README for the staged roadmap.

import {
  Scene, WebGLRenderer, OrthographicCamera, MathUtils,
  AmbientLight, HemisphereLight, DirectionalLight,
  ACESFilmicToneMapping, SRGBColorSpace, MOUSE, TOUCH,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GoogleCloudAuthPlugin,
  ReorientationPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  GLTFExtensionsPlugin,
} from '3d-tiles-renderer/plugins';

// ---- Config ----------------------------------------------------------------
const LOCATION = {
  name: 'Plaza Luis Cabrera',
  lat: 19.41633,           // degrees (converted to radians for the plugin)
  lon: -99.15955,
};
const VIEW_RADIUS = 320;   // metres half-extent the ortho camera frames at zoom 1
const ISO_AZ  = MathUtils.degToRad(45);      // azimuth: classic iso = 45°
const ISO_EL  = MathUtils.degToRad(35.264);  // elevation: true iso = atan(1/√2) (~30° also reads well)
const CAM_DIST = 4000;     // distance from target (ortho: only direction matters, but keep within near/far)
const ERROR_TARGET = 12;   // tile screen-space error: lower = sharper + more tiles + more $$ (try 6–24)
const DRACO_DECODER = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/';
const KEY_STORAGE = 'cdmx_iso_google_key';

// ---- DOM -------------------------------------------------------------------
const canvas = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const attribEl = document.getElementById('attribution');
const keyModal = document.getElementById('key-modal');
const keyInput = document.getElementById('key-input');
const keySubmit = document.getElementById('key-submit');
document.getElementById('stat-lat').textContent = LOCATION.lat.toFixed(5) + '°';
document.getElementById('stat-lon').textContent = LOCATION.lon.toFixed(5) + '°';
const zoomEl = document.getElementById('stat-zoom');

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = 'status-row' + (cls ? ' ' + cls : '');
}

// ---- API key (window override → localStorage → prompt modal) ---------------
function getStoredKey() {
  return (typeof window.CDMX_GOOGLE_KEY === 'string' && window.CDMX_GOOGLE_KEY) ||
         localStorage.getItem(KEY_STORAGE) || '';
}

function promptForKey() {
  return new Promise((resolve) => {
    keyModal.classList.remove('hidden');
    keyInput.focus();
    const submit = () => {
      const v = keyInput.value.trim();
      if (!v) { keyInput.focus(); return; }
      localStorage.setItem(KEY_STORAGE, v);
      keyModal.classList.add('hidden');
      resolve(v);
    };
    keySubmit.addEventListener('click', submit);
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  });
}

// ---- three.js scaffold -----------------------------------------------------
const scene = new Scene();

const renderer = new WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace = SRGBColorSpace;

// Google tiles carry baked photographic texture; keep lighting bright + flat so it
// reads true. (Tune if the mesh looks too dark/washed — these are PBR materials.)
scene.add(new AmbientLight(0xffffff, 2.2));
scene.add(new HemisphereLight(0xffffff, 0x9a8f7a, 1.4));
const sun = new DirectionalLight(0xffffff, 0.8);
sun.position.set(1, 2, 1);
scene.add(sun);

const camera = new OrthographicCamera(-1, 1, 1, -1, 1, 20000);
function placeCamera() {
  camera.position.set(
    CAM_DIST * Math.cos(ISO_EL) * Math.sin(ISO_AZ),
    CAM_DIST * Math.sin(ISO_EL),
    CAM_DIST * Math.cos(ISO_EL) * Math.cos(ISO_AZ),
  );
  camera.lookAt(0, 0, 0);
}
function applyFrustum() {
  const aspect = window.innerWidth / window.innerHeight;
  camera.left = -VIEW_RADIUS * aspect;
  camera.right = VIEW_RADIUS * aspect;
  camera.top = VIEW_RADIUS;
  camera.bottom = -VIEW_RADIUS;
  camera.updateProjectionMatrix();
}
placeCamera();
applyFrustum();

// Fixed iso angle: pan + zoom only (no free orbit), for the "specimen on a table" look.
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableRotate = false;          // fixed iso angle
controls.screenSpacePanning = true;
controls.minZoom = 0.25;
controls.maxZoom = 12;
controls.target.set(0, 0, 0);
// Rotate is off, so map left-drag (and one-finger touch) to PAN instead of doing nothing.
controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
controls.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN };

// ---- Tiles -----------------------------------------------------------------
let tiles = null;
let firstContent = false;

function initTiles(apiToken) {
  tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken, autoRefreshToken: true }));
  tiles.registerPlugin(new TileCompressionPlugin());
  tiles.registerPlugin(new TilesFadePlugin());
  tiles.registerPlugin(new GLTFExtensionsPlugin({
    dracoLoader: new DRACOLoader().setDecoderPath(DRACO_DECODER),
  }));
  // Place the target lat/lon at the origin, local up → +Y. Plugin wants RADIANS.
  tiles.registerPlugin(new ReorientationPlugin({
    lat: MathUtils.degToRad(LOCATION.lat),
    lon: MathUtils.degToRad(LOCATION.lon),
    height: 0,
  }));

  tiles.errorTarget = ERROR_TARGET;
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  scene.add(tiles.group);

  tiles.addEventListener('load-content', () => {
    if (!firstContent) { firstContent = true; setStatus('Listo · arrastra para mover', 'ok'); }
  });
  tiles.addEventListener('load-error', (e) => {
    setStatus('Error al cargar mosaicos — revisa la API key / facturación', 'error');
    console.error('[cdmx-iso] tile load error', e);
  });

  setStatus('Cargando mosaicos 3D…');
  // Safety net: if nothing renders, the key/billing/referrer is the usual culprit.
  setTimeout(() => {
    if (!firstContent) {
      setStatus('Sin mosaicos — verifica API key, facturación y restricción de referente', 'error');
    }
  }, 12000);
}

// ---- Loop ------------------------------------------------------------------
const attrTarget = [];
function tick() {
  requestAnimationFrame(tick);
  controls.update();
  camera.updateMatrixWorld();
  if (tiles) {
    tiles.setResolutionFromRenderer(camera, renderer);
    tiles.setCamera(camera);
    tiles.update();
    if (typeof tiles.getAttributions === 'function') {
      attrTarget.length = 0;
      tiles.getAttributions(attrTarget);
      const txt = attrTarget.map((a) => a.value).filter(Boolean).join(' · ');
      attribEl.textContent = txt || '© Google';
    }
  }
  zoomEl.textContent = camera.zoom.toFixed(2) + '×';
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  applyFrustum();
});

// ---- Boot ------------------------------------------------------------------
(async function boot() {
  let key = getStoredKey();
  if (!key) {
    setStatus('Esperando clave de API…');
    key = await promptForKey();
  }
  initTiles(key);
  tick();
})();
