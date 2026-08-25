// Floating "Ask about my work" widget: a small three.js rocket falls in,
// lands, and cross-fades into the chat launcher, which then pulses gently
// until the visitor opens it. See worker/index.js and README.txt for the
// backend this talks to.
import * as THREE from '../libs/three.module.min.js';

// The deployed Worker (worker/index.js). Redeploy with `npx wrangler deploy`
// from worker/ if this ever moves.
const DEPLOYED_WORKER_URL = 'https://portfolio-rag.ajayport2.workers.dev';
// On localhost, talk to scripts/dev_worker.py instead so the widget can be
// exercised end-to-end without deploying anything.
const IS_LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const WORKER_URL = IS_LOCAL ? 'http://localhost:8787' : DEPLOYED_WORKER_URL;

const RM = matchMedia('(prefers-reduced-motion:reduce)').matches;

const canvas = document.getElementById('askRocket');
const launcher = document.getElementById('askLauncher');
const panel = document.getElementById('askPanel');
const closeBtn = document.getElementById('askClose');
const form = document.getElementById('askForm');
const input = document.getElementById('askInput');
const submit = document.getElementById('askSubmit');
const log = document.getElementById('askLog');

// Conversation state. `history` is what gets replayed to the Worker so the model
// can follow a back-and-forth; `session` ties the turns together in the chat log
// on the backend. Both are per panel-open and die with the page.
const GREETING = "Hey, this is Ajay :) How are you doing today?";
const history = [];
const session = Math.random().toString(36).slice(2) + Date.now().toString(36);
let greeted = false;

// ---------- rocket-flight-to-launcher intro ----------
// Full-viewport orthographic camera, 1 world unit = 1 CSS px, origin top-left
// -- lets the flight path be authored directly in screen coordinates.

// Where the launcher ends up (must match .askw-launcher's CSS: left:18+12,
// bottom:18+12, 60x60), read here rather than off getBoundingClientRect()
// since the launcher is display:none (hidden attribute) until it lands.
function landingSpot() {
  const cx = innerWidth - (18 + 12 + 30);
  const cy = innerHeight - (18 + 12 + 30);
  return { x: cx, y: cy };
}

function landLauncher() {
  launcher.hidden = false;
  // Launcher pops in first, canvas fades a beat later, so the two overlap and
  // the rocket reads as becoming the logo rather than being swapped for it.
  //
  // Reading offsetWidth rather than waiting a frame: an element that has just
  // stopped being hidden needs its start styles committed before the class can
  // transition off them, and requestAnimationFrame does not fire in a
  // background tab. This forces the same commit synchronously, so the reveal
  // survives being opened in a tab the visitor is not looking at yet.
  void launcher.offsetWidth;
  launcher.classList.add('show');
  canvas.classList.add('gone');
  setTimeout(() => {
    canvas.remove();
    launcher.classList.add('blink');
  }, 420);

  // Let the landing settle before speaking. Arriving and talking at the same
  // instant reads as a popup; a beat of silence first reads as someone landing
  // and then turning to you.
  setTimeout(() => {
    const call = document.getElementById('askCallout');
    if (!call) return;
    call.hidden = false;
    void call.offsetWidth; // commit the start styles -- see landLauncher above
    call.classList.add('show');
    // It withdraws on its own. A permanent bubble beside a chat button is
    // clutter, and anyone who wants it can still see the launcher pulsing.
    setTimeout(() => call.classList.remove('show'), 9000);
    setTimeout(() => { call.hidden = true; }, 9600);
  }, 1100);
}

function runRocketIntro() {
  if (RM) { landLauncher(); return; }

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  } catch {
    landLauncher();
    return;
  }
  const W = innerWidth, H = innerHeight;
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.setSize(W, H, false);
  renderer.shadowMap.enabled = false; // fake ground shadow instead -- see below

  const scene = new THREE.Scene();
  // top=0,bottom=H gives a Y-down frustum matching CSS pixel coordinates directly.
  const camera = new THREE.OrthographicCamera(0, W, 0, H, 0.1, 1000);
  camera.position.z = 500;

  scene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const key = new THREE.DirectionalLight(0xfff3e0, 1.15);
  key.position.set(120, -200, 300);
  scene.add(key);

  // A soft dark ellipse on the ground plane that grows/darkens as the rocket
  // nears landing -- the classic cheap "shadow beneath a falling object"
  // trick, far more reliable than real shadow-mapping for a ~1.6s flourish.
  const land = landingSpot();
  const shadowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(0,0,0,0.55)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(70, 26),
    new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false })
  );
  shadow.position.set(land.x, land.y + 34, -1);
  shadow.scale.set(0.3, 0.3, 1);
  shadow.material.opacity = 0;
  scene.add(shadow);

  // ---- rocket, built a bit larger and with more shape detail than a first pass ----
  const rocket = new THREE.Group();
  const S = 1.7; // overall scale-up vs. the original in-place version

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(15 * S, 16 * S, 68 * S, 16),
    new THREE.MeshStandardMaterial({ color: 0xf4eddd, roughness: 0.4, metalness: 0.3 })
  );
  rocket.add(body);

  const collar = new THREE.Mesh(
    new THREE.CylinderGeometry(17 * S, 17 * S, 6 * S, 16),
    new THREE.MeshStandardMaterial({ color: 0x332a1e, roughness: 0.5, metalness: 0.4 })
  );
  collar.position.y = 20 * S;
  rocket.add(collar);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(15 * S, 32 * S, 16),
    new THREE.MeshStandardMaterial({ color: 0xe8ad3f, roughness: 0.35, metalness: 0.2 })
  );
  nose.position.y = 50 * S;
  rocket.add(nose);

  // porthole
  const porthole = new THREE.Mesh(
    new THREE.CircleGeometry(6 * S, 20),
    new THREE.MeshStandardMaterial({ color: 0x3a8975, roughness: 0.2, metalness: 0.6, emissive: 0x1a3d33, emissiveIntensity: 0.4 })
  );
  porthole.position.set(0, 4 * S, 15.1 * S);
  rocket.add(porthole);

  const finGeo = new THREE.ConeGeometry(9 * S, 30 * S, 3);
  const finMat = new THREE.MeshStandardMaterial({ color: 0xbc5a34, roughness: 0.55 });
  for (let i = 0; i < 3; i++) {
    const fin = new THREE.Mesh(finGeo, finMat);
    const a = (i / 3) * Math.PI * 2;
    fin.position.set(Math.cos(a) * 17 * S, -30 * S, Math.sin(a) * 17 * S);
    fin.rotation.x = Math.PI / 2;
    fin.rotation.z = a;
    fin.scale.set(1, 1.5, 0.35);
    rocket.add(fin);
  }

  const flameMat = new THREE.MeshStandardMaterial({
    color: 0xe8ad3f, emissive: 0xf0805a, emissiveIntensity: 1.4, roughness: 0.3,
  });
  const flame = new THREE.Mesh(new THREE.ConeGeometry(9 * S, 34 * S, 12), flameMat);
  flame.position.y = -50 * S;
  flame.rotation.x = Math.PI;
  rocket.add(flame);

  scene.add(rocket);

  // Exhaust trail: a ribbon of fading puffs dropped along the flight path, so
  // the rocket reads as travelling fast rather than sliding.
  const TRAIL_N = 26;
  const trailTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,225,170,0.95)');
    g.addColorStop(0.45, 'rgba(240,128,90,0.55)');
    g.addColorStop(1, 'rgba(240,128,90,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const trail = [];
  for (let i = 0; i < TRAIL_N; i++) {
    const puff = new THREE.Mesh(
      new THREE.PlaneGeometry(26, 26),
      new THREE.MeshBasicMaterial({
        map: trailTex, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.AdditiveBlending,
      })
    );
    puff.position.z = -0.5;
    scene.add(puff);
    trail.push(puff);
  }

  // Expanding ring flash marking the moment the rocket becomes the logo.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(18, 26, 40),
    new THREE.MeshBasicMaterial({
      color: 0xe8ad3f, transparent: true, opacity: 0,
      depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    })
  );
  ring.position.set(land.x, land.y, 1);
  scene.add(ring);

  // ---- flight path: wavy diagonal, top-left in -> bottom-right landing spot ----
  const start = { x: -70, y: -70 };
  // Integer wave count so sin(t*PI*waves) is exactly 0 at t=1 -- otherwise the
  // path ends slightly off the landing spot and the morph visibly jumps.
  const waves = 2;
  const amplitude = Math.min(H * 0.13, 130);

  // Stretched from 1700+420. At two seconds the rocket read as a transition
  // effect; at three and a half it reads as an arrival, which is the point now
  // that it lands into the world behind the torn page rather than over the top
  // of it. The descent below also eases harder at the end, so the last stretch
  // is a settle rather than a stop.
  const FLY_MS = 2800;
  const MORPH_MS = 600;
  const TOTAL_MS = FLY_MS + MORPH_MS;

  function easeInOutSine(t) { return -(Math.cos(Math.PI * t) - 1) / 2; }

  // The wave is applied perpendicular to the straight start->land line, so the
  // rocket genuinely S-curves along its heading instead of only wobbling in x.
  const dx = land.x - start.x, dy = land.y - start.y;
  const len = Math.hypot(dx, dy);
  const nx = -dy / len, ny = dx / len; // unit normal to the flight line

  function pathAt(t) {
    const e = easeInOutSine(t);
    const wave = Math.sin(t * Math.PI * waves) * amplitude * (1 - t * 0.85);
    return { x: start.x + dx * e + nx * wave, y: start.y + dy * e + ny * wave };
  }

  const t0 = performance.now();
  let raf;
  let prev = pathAt(0);
  let trailIdx = 0;

  function tick(now) {
    const elapsed = now - t0;

    if (elapsed < FLY_MS) {
      const t = elapsed / FLY_MS;
      const p = pathAt(t);
      rocket.position.set(p.x, p.y, 0);

      // Point the nose along the velocity vector. Model +Y renders as screen-down
      // under this Y-down ortho camera, so rotating +Y by z gives screen direction
      // (-sin z, cos z); solving for the heading gives atan2(-vx, vy).
      const vx = p.x - prev.x, vy = p.y - prev.y;
      if (Math.hypot(vx, vy) > 0.01) rocket.rotation.z = Math.atan2(-vx, vy);
      rocket.rotation.y += 0.05; // slow barrel roll for depth

      // drop an exhaust puff behind the rocket
      const puff = trail[trailIdx % TRAIL_N];
      trailIdx++;
      puff.position.x = p.x - vx * 2.5;
      puff.position.y = p.y - vy * 2.5;
      puff.material.opacity = 0.85;
      puff.scale.setScalar(0.75 + Math.random() * 0.4);

      prev = p;

      shadow.position.set(p.x, land.y + 34, -1);
      const closeness = t * t; // shadow tightens as it nears the ground
      shadow.scale.setScalar(0.25 + closeness * 0.75);
      shadow.material.opacity = 0.12 + closeness * 0.5;
    } else {
      // ---- morph: rocket spins down into the launcher, ring flashes outward ----
      const k = (elapsed - FLY_MS) / MORPH_MS;
      rocket.position.set(land.x, land.y, 0);
      rocket.rotation.z += 0.34;         // spin up as it collapses
      rocket.scale.setScalar(Math.max(0.001, 1 - k * 1.1));
      ring.material.opacity = Math.sin(Math.min(1, k) * Math.PI) * 0.9;
      ring.scale.setScalar(0.5 + k * 2.4);
      shadow.material.opacity = Math.max(0, 0.62 * (1 - k));
    }

    // fade the exhaust ribbon out continuously
    for (const puff of trail) {
      if (puff.material.opacity > 0) puff.material.opacity -= 0.035;
    }

    flame.scale.y = 1 + Math.sin(elapsed * 0.045) * 0.22 + Math.random() * 0.08;
    flameMat.emissiveIntensity = 1.2 + Math.random() * 0.5;

    renderer.render(scene, camera);

    if (elapsed < TOTAL_MS) {
      raf = requestAnimationFrame(tick);
    } else {
      cancelAnimationFrame(raf);
      landLauncher();
      setTimeout(() => {
        renderer.dispose();
        [body, collar, nose, porthole].forEach((m) => { m.geometry.dispose(); m.material.dispose(); });
        finGeo.dispose(); finMat.dispose();
        flame.geometry.dispose(); flameMat.dispose();
        shadow.geometry.dispose(); shadow.material.dispose(); shadowTex.dispose();
        ring.geometry.dispose(); ring.material.dispose();
        trail.forEach((p) => { p.geometry.dispose(); p.material.dispose(); });
        trailTex.dispose();
      }, 500);
    }
  }
  raf = requestAnimationFrame(tick);
}

// The rocket used to launch when the WebGL gate finished, which put it on
// screen long before the page had torn open. It now waits for the tear to
// complete, so the sequence reads: paper rips, world behind it, then something
// arrives in that world.
//
// site.js dispatches portfolio:tearcomplete. The fallbacks matter: reduced
// motion and a missing tearzone both mean the tear never runs, and the launcher
// still has to appear or the chat becomes unreachable.
(function () {
  let started = false;
  function once() {
    if (started) return;
    started = true;
    runRocketIntro();
  }

  const zone = document.getElementById('tearzone');
  const reduced = matchMedia('(prefers-reduced-motion:reduce)').matches;

  if (!zone || reduced) {
    // No tear to wait for. Fall back to the old cue so the launcher still lands.
    const replay = document.getElementById('replay');
    if (!replay || !replay.hidden) once();
    else {
      const mo = new MutationObserver(() => { if (!replay.hidden) { mo.disconnect(); once(); } });
      mo.observe(replay, { attributes: true, attributeFilter: ['hidden'] });
      setTimeout(() => { mo.disconnect(); once(); }, 9000);
    }
  } else {
    addEventListener('portfolio:tearcomplete', once, { once: true });
    // If the reader never scrolls far enough to finish the tear, the chat must
    // not stay hidden forever.
    setTimeout(once, 45000);
  }
})();

// ---------- panel open/close ----------

function openPanel() {
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add('show'));
  launcher.setAttribute('aria-expanded', 'true');
  launcher.classList.remove('blink'); // stop nagging once they've engaged
  setTimeout(() => input.focus(), 150);

  // Open the conversation ourselves rather than waiting to be asked something.
  // Held back until the panel has finished animating in so the bubble doesn't
  // arrive mid-transition, and only ever once per page load.
  if (!greeted) {
    greeted = true;
    setTimeout(() => {
      addMessage('them', GREETING);
      history.push({ role: 'assistant', content: GREETING });
    }, 420);
  }
}
function closePanel() {
  panel.classList.remove('show');
  launcher.setAttribute('aria-expanded', 'false');
  setTimeout(() => { panel.hidden = true; }, 220);
}
function togglePanel() {
  if (panel.hidden) openPanel(); else closePanel();
}

launcher.addEventListener('click', togglePanel);
closeBtn.addEventListener('click', closePanel);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !panel.hidden) closePanel();
});
document.addEventListener('click', (e) => {
  if (!panel.hidden && !document.getElementById('askw').contains(e.target)) closePanel();
});

// ---------- transcript ----------

// textContent throughout, never innerHTML: the reply is model output and the
// question is visitor input, so neither is ever treated as markup.
function addMessage(who, text) {
  const el = document.createElement('div');
  el.className = `ask-msg ${who}`;
  el.textContent = text;
  log.appendChild(el);
  scrollToEnd();
  return el;
}

function showTyping() {
  const el = document.createElement('div');
  el.className = 'ask-typing';
  el.innerHTML = '<span></span><span></span><span></span>';
  log.appendChild(el);
  scrollToEnd();
  return el;
}

// Only auto-scroll when the reader is already at the bottom. If they've scrolled
// up to re-read something, a streaming reply shouldn't yank them back down.
function scrollToEnd(force = true) {
  const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  if (force || nearBottom) log.scrollTop = log.scrollHeight;
}

// ---------- ask / streaming ----------

async function ask(question) {
  submit.disabled = true;
  input.value = '';
  addMessage('me', question);

  const typing = showTyping();
  let bubble = null;

  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, history, session }),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let full = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (!chunk) continue;
      // Swap the dots for a real bubble the moment the first token lands, so the
      // reply grows in place instead of appearing all at once at the end.
      if (!bubble) { typing.remove(); bubble = addMessage('them', ''); }
      full += chunk;
      bubble.textContent = full;
      scrollToEnd(false);
    }

    if (!bubble) { typing.remove(); bubble = addMessage('them', full || '...'); }

    history.push({ role: 'user', content: question });
    history.push({ role: 'assistant', content: full });
  } catch (err) {
    typing.remove();
    if (bubble) bubble.remove();
    addMessage('error', "Couldn't reach me just now. The contact section below is the surest way through.");
    console.warn('ask widget error:', err);
  } finally {
    submit.disabled = false;
    input.focus();
  }
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q || submit.disabled) return;
  ask(q);
});
