// cdmx-iso — photoreal isometric viewer for CDMX (Scenario A: live whole-city roam)
// Google Photorealistic 3D Tiles streamed live under a fixed iso orthographic camera.
// Pan to recorrer the city, scroll to zoom (city overview ↔ street detail), search to jump.

import {
  Scene, WebGLRenderer, OrthographicCamera, MathUtils, Vector2, Vector3,
  AmbientLight, HemisphereLight, DirectionalLight,
  ACESFilmicToneMapping, SRGBColorSpace, MOUSE, TOUCH,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { TilesRenderer } from '3d-tiles-renderer';
import {
  GoogleCloudAuthPlugin,
  ReorientationPlugin,
  TileCompressionPlugin,
  TilesFadePlugin,
  UnloadTilesPlugin,
  GLTFExtensionsPlugin,
} from '3d-tiles-renderer/plugins';

// ---- Config ----------------------------------------------------------------
const HOME = { name: 'Plaza Luis Cabrera', secondary: 'Roma Norte · Cuauhtémoc', lat: 19.41633, lon: -99.15955 };
const VIEW_RADIUS = 320;   // metres half-extent the ortho camera frames at zoom 1
const ISO_AZ = MathUtils.degToRad(225);      // iso corner view from the NE → north reads toward top
const ISO_EL = MathUtils.degToRad(35.264);   // elevation: true iso = atan(1/√2)
const CAM_DIST = 60000;    // ortho: only direction matters; sit far back so geometry stays in [near,far]
const ERROR_TARGET = 14;   // tile screen-space error: lower = sharper + more tiles + more $$
const MIN_ZOOM = 0.015;    // ≈ whole-city overview (half-height ~21 km)
const MAX_ZOOM = 40;       // ≈ street detail (half-height ~8 m)
const DRACO_DECODER = 'https://www.gstatic.com/draco/versioned/decoders/1.5.6/';
const KEY_STORAGE = 'cdmx_iso_google_key';

// ---- DOM -------------------------------------------------------------------
const canvas = document.getElementById('canvas');
const statusEl = document.getElementById('status');
const attribEl = document.getElementById('attribution');
const keyModal = document.getElementById('key-modal');
const keyInput = document.getElementById('key-input');
const keySubmit = document.getElementById('key-submit');
const searchInput = document.getElementById('search-input');
const searchBtn = document.getElementById('search-btn');
const titleEl = document.getElementById('title');
const locLineEl = document.getElementById('location-line');
const latEl = document.getElementById('stat-lat');
const lonEl = document.getElementById('stat-lon');
const zoomEl = document.getElementById('stat-zoom');
const compassSvg = document.getElementById('compass-svg');

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = 'status-row' + (cls ? ' ' + cls : '');
}
function setTitle(name, secondary) {
  titleEl.textContent = name;
  if (secondary != null) locLineEl.textContent = secondary;
}
function setCoords(lat, lon) {
  latEl.textContent = lat.toFixed(5) + '°';
  lonEl.textContent = lon.toFixed(5) + '°';
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

// Tiles carry baked photographic texture; keep lighting bright + flat so it reads true.
scene.add(new AmbientLight(0xffffff, 2.2));
scene.add(new HemisphereLight(0xffffff, 0x9a8f7a, 1.4));
const sun = new DirectionalLight(0xffffff, 0.8);
sun.position.set(1, 2, 1);
scene.add(sun);

const camera = new OrthographicCamera(-1, 1, 1, -1, 1, 200000);
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
controls.enableRotate = false;
controls.screenSpacePanning = true;
controls.minZoom = MIN_ZOOM;
controls.maxZoom = MAX_ZOOM;
controls.target.set(0, 0, 0);
controls.mouseButtons = { LEFT: MOUSE.PAN, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
controls.touches = { ONE: TOUCH.PAN, TWO: TOUCH.DOLLY_PAN };

// ---- Post-processing: real-time stylization (toggleable) -------------------
const StylizeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uResolution: { value: new Vector2(1, 1) },
    uStyle: { value: 0 },      // 0 raw · 1 pixel-art · 2 flat-poster · 3 painterly · 4 toon
    uPixelSize: { value: 6.0 },
    uLevels: { value: 6.0 },
    uOutline: { value: 1.0 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uResolution;
    uniform float uStyle, uPixelSize, uLevels, uOutline;
    varying vec2 vUv;
    float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
    vec3 posterize(vec3 c, float n){ return floor(c * n) / (n - 1.0); }
    float sobel(vec2 uv, vec2 t){
      float tl=luma(texture2D(tDiffuse,uv+t*vec2(-1.,-1.)).rgb), l=luma(texture2D(tDiffuse,uv+t*vec2(-1.,0.)).rgb), bl=luma(texture2D(tDiffuse,uv+t*vec2(-1.,1.)).rgb);
      float tp=luma(texture2D(tDiffuse,uv+t*vec2(0.,-1.)).rgb), b=luma(texture2D(tDiffuse,uv+t*vec2(0.,1.)).rgb);
      float tr=luma(texture2D(tDiffuse,uv+t*vec2(1.,-1.)).rgb), r=luma(texture2D(tDiffuse,uv+t*vec2(1.,0.)).rgb), br=luma(texture2D(tDiffuse,uv+t*vec2(1.,1.)).rgb);
      float gx=-tl-2.*l-bl+tr+2.*r+br, gy=-tl-2.*tp-tr+bl+2.*b+br;
      return sqrt(gx*gx+gy*gy);
    }
    vec3 kuwahara(vec2 uv, vec2 t){
      const int R=3;
      vec3 best=texture2D(tDiffuse,uv).rgb; float bestVar=1e9;
      for(int q=0;q<4;q++){
        vec2 d = q==0?vec2(-1.,-1.): q==1?vec2(1.,-1.): q==2?vec2(-1.,1.):vec2(1.,1.);
        vec3 sum=vec3(0.); float s2=0., cnt=0.;
        for(int i=0;i<=R;i++) for(int j=0;j<=R;j++){
          vec3 c=texture2D(tDiffuse, uv+t*vec2(float(i)*d.x, float(j)*d.y)).rgb;
          sum+=c; s2+=luma(c)*luma(c); cnt+=1.;
        }
        vec3 m=sum/cnt; float v=s2/cnt - luma(m)*luma(m);
        if(v<bestVar){ bestVar=v; best=m; }
      }
      return best;
    }
    void main(){
      vec2 t = 1.0 / uResolution;
      vec3 lin = texture2D(tDiffuse, vUv).rgb;
      if(uStyle < 0.5){ gl_FragColor = vec4(lin, 1.0); return; }   // raw (OutputPass tonemaps)
      vec2 uv = vUv;
      if(uStyle < 1.5){ vec2 px = uPixelSize * t; uv = (floor(vUv/px)+0.5)*px; } // pixel-art grid
      vec3 src = (uStyle > 2.5 && uStyle < 3.5) ? kuwahara(vUv, t*1.5) : texture2D(tDiffuse, uv).rgb;
      // posterize/quantize in gamma (display) space so bands spread evenly instead of crushing to black
      vec3 col = pow(max(src, 0.0), vec3(0.4545));
      float levels = uLevels;
      if(uStyle > 3.5) levels = 4.0;                       // toon: punchy
      else if(uStyle > 2.5) levels = 8.0;                  // painterly: softer
      col = posterize(col, levels);
      if(uStyle > 3.5){ float l = luma(col); col = clamp(l + (col-l)*1.6, 0.0, 1.0); } // toon saturation
      if(uStyle > 1.5){
        float e = sobel(vUv, t);
        float strength = uStyle > 3.5 ? 1.0 : (uStyle > 2.5 ? 0.4 : 0.75);
        float edge = clamp(smoothstep(0.16, 0.5, e) * strength * uOutline, 0.0, 1.0);
        col = mix(col, vec3(0.10, 0.08, 0.06), edge);
      }
      gl_FragColor = vec4(pow(max(col, 0.0), vec3(2.2)), 1.0);   // back to linear for OutputPass
    }
  `,
};

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const stylizePass = new ShaderPass(StylizeShader);
composer.addPass(stylizePass);
composer.addPass(new OutputPass());

const _bufSize = new Vector2();
function setComposerSize() {
  composer.setSize(window.innerWidth, window.innerHeight);
  renderer.getDrawingBufferSize(_bufSize);
  stylizePass.uniforms.uResolution.value.copy(_bufSize);
}
setComposerSize();

// style switcher UI
const styleBtns = Array.from(document.querySelectorAll('.style-btn'));
styleBtns.forEach((btn) => btn.addEventListener('click', () => {
  stylizePass.uniforms.uStyle.value = parseInt(btn.dataset.style, 10);
  styleBtns.forEach((b) => b.classList.toggle('active', b === btn));
}));
window.__setStyle = (n) => { stylizePass.uniforms.uStyle.value = n; };
window.__stylize = stylizePass;

// ---- Tiles -----------------------------------------------------------------
let tiles = null;
let currentKey = '';
let firstContent = false;
let safetyTimer = null;
let anchorLat = HOME.lat, anchorLon = HOME.lon;

function initTiles(apiToken, lat, lon) {
  tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken, autoRefreshToken: true }));
  tiles.registerPlugin(new TileCompressionPlugin());
  tiles.registerPlugin(new UnloadTilesPlugin());   // free memory when panning across the city
  tiles.registerPlugin(new TilesFadePlugin());
  tiles.registerPlugin(new GLTFExtensionsPlugin({
    dracoLoader: new DRACOLoader().setDecoderPath(DRACO_DECODER),
  }));
  // Re-base the anchor lat/lon to the scene origin, local up → +Y. Plugin wants RADIANS.
  // Panning roams the tangent plane around this anchor (fine over CDMX-scale distances).
  tiles.registerPlugin(new ReorientationPlugin({
    lat: MathUtils.degToRad(lat),
    lon: MathUtils.degToRad(lon),
    height: 0,
  }));

  tiles.errorTarget = ERROR_TARGET;
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  scene.add(tiles.group);
  anchorLat = lat; anchorLon = lon;

  firstContent = false;
  tiles.addEventListener('load-content', () => {
    if (!firstContent) { firstContent = true; setStatus('Listo · arrastra para recorrer', 'ok'); }
  });
  tiles.addEventListener('load-error', (e) => {
    setStatus('Error al cargar mosaicos — revisa la API key / facturación', 'error');
    console.error('[cdmx-iso] tile load error', e);
  });

  setStatus('Cargando mosaicos 3D…');
  clearTimeout(safetyTimer);
  safetyTimer = setTimeout(() => {
    if (!firstContent) setStatus('Sin mosaicos — verifica API key, facturación y restricción de referente', 'error');
  }, 12000);
}

// Jump to a new anchor: dispose, re-create at lat/lon, recenter the camera.
function reanchor(lat, lon, name, secondary) {
  if (tiles) { scene.remove(tiles.group); tiles.dispose(); tiles = null; }
  initTiles(currentKey, lat, lon);
  controls.target.set(0, 0, 0);
  camera.zoom = 1;
  camera.updateProjectionMatrix();
  setCoords(lat, lon);
  if (name) setTitle(name, secondary);
}

// ---- Geocode (Nominatim) → jump --------------------------------------------
async function geocode(query) {
  const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=mx&q=' +
    encodeURIComponent(query);
  const r = await fetch(url, { headers: { 'Accept-Language': 'es' } });
  if (!r.ok) throw new Error('geocode HTTP ' + r.status);
  const j = await r.json();
  if (!j.length) throw new Error('sin resultados');
  return { lat: parseFloat(j[0].lat), lon: parseFloat(j[0].lon), name: j[0].display_name };
}
async function doSearch() {
  const q = searchInput.value.trim();
  if (!q) return;
  searchBtn.disabled = true;
  setStatus('Buscando dirección…');
  try {
    const p = await geocode(q);
    const parts = p.name.split(',').map((s) => s.trim());
    reanchor(p.lat, p.lon, parts[0], parts.slice(1, 3).join(' · '));
  } catch (e) {
    setStatus('✕ ' + (e.message || 'búsqueda falló'), 'error');
    searchBtn.disabled = false;
  }
}
searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSearch(); } });
// re-enable the search button once new tiles start arriving
function watchSearchReady() {
  if (firstContent) { searchBtn.disabled = false; }
  requestAnimationFrame(watchSearchReady);
}

// ---- Compass (points to true north; view never rotates so this is stable) --
const _cE = new Vector3(), _cN = new Vector3(), _cU = new Vector3();
const _cO = new Vector3(), _cP = new Vector3();
function updateCompass() {
  if (!tiles || !tiles.ellipsoid || !compassSvg) return;
  tiles.ellipsoid.getEastNorthUpAxes(MathUtils.degToRad(anchorLat), MathUtils.degToRad(anchorLon), _cE, _cN, _cU);
  _cN.transformDirection(tiles.group.matrixWorld);     // ellipsoid-north → world-north
  _cO.set(0, 0, 0).project(camera);
  _cP.copy(_cN).multiplyScalar(50).project(camera);
  const deg = Math.atan2(_cP.x - _cO.x, _cP.y - _cO.y) * 180 / Math.PI; // 0 = up, + = clockwise
  compassSvg.style.transform = 'rotate(' + deg.toFixed(1) + 'deg)';
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
    updateCompass();
    if (typeof tiles.getAttributions === 'function') {
      attrTarget.length = 0;
      tiles.getAttributions(attrTarget);
      const txt = attrTarget.map((a) => a.value).filter(Boolean).join(' · ');
      attribEl.textContent = txt || '© Google';
    }
  }
  zoomEl.textContent = camera.zoom.toFixed(2) + '×';
  composer.render();
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  applyFrustum();
  setComposerSize();
});

// ---- Boot ------------------------------------------------------------------
(async function boot() {
  let key = getStoredKey();
  if (!key) {
    setStatus('Esperando clave de API…');
    key = await promptForKey();
  }
  currentKey = key;
  setCoords(HOME.lat, HOME.lon);
  setTitle('Plaza Luis Cabrera', HOME.secondary);
  initTiles(currentKey, HOME.lat, HOME.lon);
  watchSearchReady();
  tick();
})();
