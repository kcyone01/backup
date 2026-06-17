import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

// ─── Loading ──────────────────────────────────────────────────────────────────
const loadFill   = document.getElementById("load-fill");
const loadScreen = document.getElementById("loading-screen");
const loadStatus = document.getElementById("load-status");
const loadMgr    = new THREE.LoadingManager();
loadMgr.onProgress = (_, loaded, total) => {
  const pct = (loaded / total) * 100;
  if (loadFill)   loadFill.style.width = pct + "%";
  if (loadStatus) loadStatus.innerText = "DEPLOYING ASSETS: " + Math.round(pct) + "%";
};
loadMgr.onLoad = () => {
  loadScreen.style.opacity = "0";
  setTimeout(() => (loadScreen.style.display = "none"), 500);
};

// ─── Renderer / Scene / Camera ────────────────────────────────────────────────
const scene    = new THREE.Scene();
const camera   = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.8));
renderer.setSize(window.innerWidth, window.innerHeight);
document.body.appendChild(renderer.domElement);
camera.position.z = 5;
const camOrigin = new THREE.Vector3(0, 0, 5);

const isMobile    = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
const mobileScale = isMobile ? 0.78 : 1;

// ─── Audio ────────────────────────────────────────────────────────────────────
const listener    = new THREE.AudioListener();
camera.add(listener);
const sndShoot    = new THREE.Audio(listener);
const sndHit      = new THREE.Audio(listener);
const sndDamage   = new THREE.Audio(listener);
const sndGameover = new THREE.Audio(listener);
const audioLoader = new THREE.AudioLoader(loadMgr);
const loadAudio   = (path, snd) => audioLoader.load(path, buf => snd.setBuffer(buf));
loadAudio("./assets/sounds/shoot.mp3",    sndShoot);
loadAudio("./assets/sounds/hit.mp3",      sndHit);
loadAudio("./assets/sounds/damage.mp3",   sndDamage);
loadAudio("./assets/sounds/gameover.mp3", sndGameover);
function playSound(snd) {
  if (snd.buffer) { if (snd.isPlaying) snd.stop(); snd.play(); }
}

// ─── Textures ─────────────────────────────────────────────────────────────────
const texLoader = new THREE.TextureLoader(loadMgr);
let cactusMaterial = null;
texLoader.load("./assets/images/cactus.webp", tex => {
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  cactusMaterial = new THREE.SpriteMaterial({
    map: tex, transparent: true, depthTest: true, depthWrite: false
  });
});
texLoader.load("./assets/images/background.png", tex => (scene.background = tex));

// ─── High Score ───────────────────────────────────────────────────────────────
const HS_KEYS = { recon: "cs_hs_recon", standard: "cs_hs_standard", blacksite: "cs_hs_blacksite" };
function getHighScore(diff) { return parseInt(localStorage.getItem(HS_KEYS[diff]) || "0", 10); }
function setHighScore(diff, val) { localStorage.setItem(HS_KEYS[diff], val); }

// ─── Difficulty ───────────────────────────────────────────────────────────────
const DIFFICULTIES = {
  recon:     { speed: 0.09,  interval: 1300, strafeSpeed: 0.07,  label: "RECON"     },
  standard:  { speed: 0.145, interval: 950,  strafeSpeed: 0.11,  label: "STANDARD"  },
  blacksite: { speed: 0.22,  interval: 580,  strafeSpeed: 0.16,  label: "BLACKSITE" },
};
let selectedDifficulty = "standard";

// ─── Anti-cheat state ─────────────────────────────────────────────────────────
const XORKEY = 0xCAFE;
const state = {
  _score: 0, _shadowScore: 0, _health: 100, _shadowHealth: 0,
  get score()  { return this._score; },
  set score(v) { this._score  = v; this._shadowScore  = XORKEY ^ v; },
  get health() { return this._health; },
  set health(v){ this._health = v; this._shadowHealth = XORKEY ^ v; },
};
state.score = 0; state.health = 100;

function checkIntegrity() {
  if ((XORKEY ^ state._score)  !== state._shadowScore ||
      (XORKEY ^ state._health) !== state._shadowHealth) {
    location.reload(); return false;
  }
  return true;
}

// ─── Game variables ───────────────────────────────────────────────────────────
let gameRunning      = false;
let level            = 1;
let lastFrameTime    = 0;
let accumulator      = 0;
let missionStartTime = 0;
let cactusSpeed      = 0.145;
let spawnInterval    = 950;
let strafeSpeed      = 0.11;

// ─── Combo ────────────────────────────────────────────────────────────────────
let currentStreak   = 0;
let bestStreak      = 0;
let comboMultiplier = 1;
let comboTimer      = 0;
const COMBO_WINDOW  = 3000;
const COMBO_THRESHOLDS = [5, 10];

// ─── Stats ────────────────────────────────────────────────────────────────────
let totalShots = 0;
let totalHits  = 0;

// ─── Daily Challenge ──────────────────────────────────────────────────────────
let isDailyChallenge = false;
function getDailySeed() {
  const d = new Date();
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}
function makeRng(seed) {
  return function() {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
let rng = Math.random;

// ─── Power-up system (tap-to-collect) ────────────────────────────────────────
// On mobile: orbs appear as large tappable HTML buttons overlaid on screen.
// On desktop: orbs appear in 3D and are shot/clicked like cacti.
// This removes all fragile 3D→screen projection and Z-collision logic.

const POWERUP_TYPES    = ['health', 'rapidfire', 'shield'];
const POWERUP_DROP_CHANCE = 0.20;
const POWERUP_DURATION = { rapidfire: 5000, shield: 6000 };
const POWERUP_META = {
  health:    { icon: '❤️', label: 'HEALTH',     color: '#00ff88', glow: '#00ff8855' },
  rapidfire: { icon: '⚡', label: 'RAPID FIRE', color: '#ff6600', glow: '#ff660055' },
  shield:    { icon: '🛡️', label: 'SHIELD',     color: '#00aaff', glow: '#00aaff55' },
};

let powerups      = [];  // { el, type, expireAt, x, y }  — HTML overlay items
let rapidFireUntil = 0;
let shieldUntil    = 0;
let shieldActive   = false;

// Container for all power-up overlay buttons
const elPowerupLayer = document.createElement("div");
elPowerupLayer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:40;";
document.body.appendChild(elPowerupLayer);

function spawnPowerup(screenX, screenY) {
  const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  const meta = POWERUP_META[type];

  // Clamp spawn position to a safe area away from HUD edges
  const margin = 80;
  const sx = Math.min(Math.max(screenX, margin), window.innerWidth  - margin);
  const sy = Math.min(Math.max(screenY, margin + 60), window.innerHeight - margin);

  const el = document.createElement("button");
  el.style.cssText = `
    position:absolute;
    left:${sx}px; top:${sy}px;
    transform:translate(-50%,-50%);
    width:${isMobile ? 68 : 56}px;
    height:${isMobile ? 68 : 56}px;
    border-radius:50%;
    border:3px solid ${meta.color};
    background:rgba(0,0,0,0.82);
    box-shadow:0 0 18px ${meta.glow}, inset 0 0 10px ${meta.glow};
    font-size:${isMobile ? "1.7rem" : "1.4rem"};
    cursor:pointer;
    pointer-events:all;
    display:flex; align-items:center; justify-content:center;
    animation:powerup-bob 0.9s ease-in-out infinite alternate;
    -webkit-tap-highlight-color:transparent;
    touch-action:manipulation;
    z-index:41;
  `;
  el.innerText = meta.icon;
  el.title = meta.label;

  const expireAt = Date.now() + 7000;

  // Shrink ring shows time remaining
  const ring = document.createElement("div");
  ring.style.cssText = `
    position:absolute;inset:-5px;border-radius:50%;
    border:2px solid ${meta.color};
    animation:powerup-shrink 7s linear forwards;
    pointer-events:none;
  `;
  el.appendChild(ring);
  elPowerupLayer.appendChild(el);

  const entry = { el, type, expireAt };
  powerups.push(entry);

  el.addEventListener("click",      () => collectPowerup(entry));
  el.addEventListener("touchstart", (e) => { e.preventDefault(); collectPowerup(entry); }, { passive: false });
}

function collectPowerup(entry) {
  if (!entry.el.isConnected) return;
  entry.el.remove();
  powerups = powerups.filter(p => p !== entry);
  activatePowerup(entry.type);
}

function activatePowerup(type) {
  const now = Date.now();
  if (type === 'health') {
    state.health = Math.min(100, state.health + 25);
    updateHud();
    showPickupToast('❤️ +25 HP', '#00ff88');
  } else if (type === 'rapidfire') {
    rapidFireUntil = now + POWERUP_DURATION.rapidfire;
    showPickupToast('⚡ RAPID FIRE', '#ff6600');
  } else if (type === 'shield') {
    shieldUntil = now + POWERUP_DURATION.shield;
    showPickupToast('🛡️ SHIELD ACTIVE', '#00aaff');
  }
}

function updatePowerups() {
  const now = Date.now();
  for (let i = powerups.length - 1; i >= 0; i--) {
    if (now >= powerups[i].expireAt) {
      powerups[i].el.remove();
      powerups.splice(i, 1);
    }
  }
}

function clearPowerups() {
  powerups.forEach(p => p.el.remove());
  powerups = [];
}

// Convert 3D world position → screen pixel coords (used for spawn placement)
function worldToScreen(pos3d) {
  const v = pos3d.clone().project(camera);
  return {
    x: (v.x *  0.5 + 0.5) * window.innerWidth,
    y: (v.y * -0.5 + 0.5) * window.innerHeight,
  };
}

// Inject keyframe animations for power-up orbs
const styleSheet = document.createElement("style");
styleSheet.textContent = `
  @keyframes powerup-bob {
    from { transform: translate(-50%,-50%) translateY(0px); }
    to   { transform: translate(-50%,-50%) translateY(-8px); }
  }
  @keyframes powerup-shrink {
    from { transform: scale(1);   opacity:1; }
    to   { transform: scale(0.1); opacity:0; }
  }
`;
document.head.appendChild(styleSheet);

// ─── Buff pill indicators ─────────────────────────────────────────────────────
const elBuffBar = document.createElement("div");
elBuffBar.id = "buff-bar";
elBuffBar.style.cssText = `
  position:absolute; bottom:140px; left:60px;
  display:flex; gap:10px; pointer-events:none; z-index:25;
`;
document.getElementById("cs2-hud").appendChild(elBuffBar);

function makeBuffPill(id, icon, color) {
  const el = document.createElement("div");
  el.id = id;
  el.style.cssText = `
    display:none; align-items:center; gap:6px;
    background:rgba(0,0,0,0.88); border:2px solid ${color};
    padding:5px 14px; font-size:0.7rem; letter-spacing:2px; color:${color};
    font-weight:900; box-shadow:0 0 14px ${color}55;
    font-family:'Orbitron',sans-serif;
  `;
  el.innerHTML = `${icon} <span id="${id}-timer" style="min-width:28px;display:inline-block"></span>`;
  elBuffBar.appendChild(el);
  return el;
}
const pillRapid  = makeBuffPill("buff-rapid",  "⚡ RAPID FIRE", "#ff6600");
const pillShield = makeBuffPill("buff-shield", "🛡️ SHIELD",     "#00aaff");

function updateBuffPills(now) {
  const rfLeft = Math.max(0, rapidFireUntil - now);
  const shLeft = Math.max(0, shieldUntil   - now);
  pillRapid.style.display  = rfLeft > 0 ? "flex" : "none";
  pillShield.style.display = shLeft > 0 ? "flex" : "none";
  if (rfLeft > 0) document.getElementById("buff-rapid-timer").innerText  = (rfLeft / 1000).toFixed(1) + "s";
  if (shLeft > 0) document.getElementById("buff-shield-timer").innerText = (shLeft / 1000).toFixed(1) + "s";
  shieldActive = shLeft > 0;
}

// ─── Pickup toast ─────────────────────────────────────────────────────────────
let toastTimeout = null;
const elToast = document.createElement("div");
elToast.style.cssText = `
  position:fixed; top:42%; left:50%; transform:translate(-50%,-50%);
  font-size:1.5rem; font-weight:900; letter-spacing:4px;
  pointer-events:none; z-index:200; opacity:0;
  transition:opacity 0.15s; text-shadow:0 0 20px currentColor;
  font-family:'Orbitron',sans-serif;
`;
document.body.appendChild(elToast);
function showPickupToast(msg, color) {
  elToast.innerText = msg;
  elToast.style.color = color;
  elToast.style.opacity = "1";
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => (elToast.style.opacity = "0"), 950);
}

// ─── Screen shake + red flash ─────────────────────────────────────────────────
let shakeTimer     = 0;
let shakeMagnitude = 0;

const elDamageFlash = document.createElement("div");
elDamageFlash.style.cssText = `
  position:fixed; inset:0; pointer-events:none; z-index:60;
  background:rgba(255,0,0,0); transition:background 0.08s;
`;
document.body.appendChild(elDamageFlash);

function triggerDamageEffect() {
  elDamageFlash.style.background = "rgba(255,0,0,0.35)";
  setTimeout(() => (elDamageFlash.style.background = "rgba(255,0,0,0)"), 180);
  shakeTimer     = 380;
  shakeMagnitude = 0.18;
}

function updateShake(dt) {
  if (shakeTimer <= 0) { camera.position.copy(camOrigin); return; }
  shakeTimer -= dt;
  const mag = shakeMagnitude * (shakeTimer / 380);
  camera.position.set(
    camOrigin.x + (Math.random() - 0.5) * mag,
    camOrigin.y + (Math.random() - 0.5) * mag,
    camOrigin.z
  );
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const elHealthVal    = document.getElementById("health-val");
const elHealthBar    = document.getElementById("health-bar-fill");
const elScoreVal     = document.getElementById("score-val");
const elFinalScore   = document.getElementById("final-score");
const elMenuOverlay  = document.getElementById("menu-overlay");
const elDeathOverlay = document.getElementById("death-overlay");
const elVictOverlay  = document.getElementById("victory-overlay");
const elCrosshair    = document.querySelector(".crosshair");
const elSupport      = document.querySelector(".support-module");
const elComboHud     = document.getElementById("combo-hud");
const elComboVal     = document.getElementById("combo-val");
const elComboBar     = document.getElementById("combo-bar");
const elLevelFlash   = document.getElementById("levelup-flash");

// Level indicator
const elLevelWrap = document.createElement("div");
elLevelWrap.style.cssText = `
  position:absolute;top:${isMobile?"20px":"40px"};right:${isMobile?"20px":"60px"};
  color:#00ff00;font-size:${isMobile?"0.8rem":"1.1rem"};
  font-weight:700;letter-spacing:3px;text-shadow:0 0 12px #00ff00;pointer-events:none;
  font-family:'Orbitron',sans-serif;
`;
elLevelWrap.innerHTML = `LEVEL <span id="level-val" style="font-size:${isMobile?"1.1rem":"1.4rem"};margin-left:8px;">01</span>`;
document.getElementById("cs2-hud").appendChild(elLevelWrap);

// ─── HUD update ───────────────────────────────────────────────────────────────
function updateHud(scoreFlash = false) {
  if (!checkIntegrity()) return;
  elHealthVal.innerText = Math.max(0, Math.floor(state.health));
  elScoreVal.innerText  = state.score.toString().padStart(3, "0");
  document.getElementById("level-val").innerText = level.toString().padStart(2, "0");
  if (scoreFlash) {
    elScoreVal.style.transform = "scale(1.15)";
    setTimeout(() => (elScoreVal.style.transform = "scale(1)"), 80);
  }
  elHealthBar.style.width = `${Math.max(0, state.health)}%`;
  state.health <= 40
    ? elHealthBar.classList.add("low-health-warning")
    : elHealthBar.classList.remove("low-health-warning");
}

function updateComboHud() {
  if (comboMultiplier <= 1 && currentStreak === 0) {
    elComboHud.style.display = "none"; return;
  }
  elComboHud.style.display = "block";
  elComboVal.innerText = `x${comboMultiplier}  🔥${currentStreak}`;
  const pct = Math.max(0, 1 - comboTimer / COMBO_WINDOW) * 100;
  elComboBar.style.width = pct + "%";
}

function triggerLevelUpFlash(lvl) {
  elLevelFlash.innerHTML = `<div id="levelup-flash-text">⚡ LEVEL ${lvl} ⚡</div>`;
  elLevelFlash.classList.remove("active");
  void elLevelFlash.offsetWidth;
  elLevelFlash.classList.add("active");
}

// Small pattern label shown bottom-right when wave type changes
const elPatternLabel = document.createElement("div");
elPatternLabel.style.cssText = `
  position:absolute; bottom:50px; right:60px;
  font-size:0.65rem; letter-spacing:3px; color:rgba(0,255,0,0.55);
  font-weight:700; pointer-events:none; font-family:'Orbitron',sans-serif;
  transition:opacity 0.4s;
`;
document.getElementById("cs2-hud").appendChild(elPatternLabel);

const PATTERN_LABELS = {
  scatter:   'SCATTER',
  flank:     'FLANK',
  cluster:   'CLUSTER BURST',
  crossfire: 'CROSSFIRE',
};

function showPatternLabel(pattern) {
  elPatternLabel.innerText = '▸ ' + (PATTERN_LABELS[pattern] || pattern);
  elPatternLabel.style.opacity = '1';
  setTimeout(() => (elPatternLabel.style.opacity = '0'), 2200);
}

// ─── CS2 Aim-Trainer Spawn System ────────────────────────────────────────────
//
// Core philosophy: targets pop INTO the playfield at a fixed, readable Z plane
// and advance slowly. Players react to POSITION, not to a dot growing from far
// away. This mirrors how CS2 aim trainers work — targets appear, linger just
// long enough to demand a decision, then expire or reach the player.
//
// Wave patterns rotate to keep the player moving their aim:
//   scatter   — targets appear one at a time at random positions
//   flank     — targets appear only on the left or right third
//   cluster   — 3 targets burst in close together, then gap
//   crossfire — alternating left/right in quick succession

const TARGET_Z       = -12;   // targets pop in close — always readable size
const TARGET_LIFE_MS = 2800;  // ms before a target expires on its own (tuned per level)
const BASE_SIZE      = window.innerWidth < 768 ? 3.2 : 5.5;

// Playfield bounds (fraction of screen, tighter on mobile)
const FIELD_X = window.innerWidth  < 768 ? 0.38 : 0.52;
const FIELD_Y = window.innerWidth  < 768 ? 0.28 : 0.36;

// Wave pattern state
const PATTERNS   = ['scatter', 'flank', 'cluster', 'crossfire'];
let   patternIdx = 0;
let   patternTimer    = 0;   // ms until next pattern switch
let   burstQueue      = [];  // pending spawns for cluster/crossfire bursts
let   burstCooldown   = 0;   // ms between burst spawns

function getFrustumDims() {
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const frustH = 2 * Math.tan(fovRad / 2) * Math.abs(TARGET_Z - camera.position.z);
  const frustW = frustH * camera.aspect;
  return { w: frustW, h: frustH };
}

// Core target spawner — place one target at a specific screen-fraction position
// sx: -1 (left) to +1 (right), sy: -1 (bottom) to +1 (top)
function spawnTargetAt(sx, sy, lifeOverride) {
  if (!cactusMaterial || !gameRunning) return;
  const { w, h } = getFrustumDims();

  // Small jitter so targets never feel pixel-perfect predictable
  const jx = (rng() - 0.5) * 0.6;
  const jy = (rng() - 0.5) * 0.4;
  const x  = sx * w * FIELD_X + jx;
  const y  = sy * h * FIELD_Y + jy + 0.8; // +0.8 keeps targets out of HUD zone

  // Size varies ±15% for variety; slightly smaller on high levels = harder
  const diffScale = Math.max(0.65, 1 - (level - 1) * 0.022);
  const sz = BASE_SIZE * mobileScale * diffScale * (0.88 + rng() * 0.24);

  const sprite = new THREE.Sprite(cactusMaterial);
  sprite.scale.set(sz, sz, 1);
  sprite.position.set(x, y, TARGET_Z);

  // Advance speed: targets still drift toward the player, but gently
  // so there's consequence for ignoring them — they don't just hover forever
  const advanceSpeed = 0.012 + level * 0.004;

  const lifeMs = lifeOverride ?? Math.max(1000, TARGET_LIFE_MS - level * 60);

  sprite.userData = {
    rotSpeed:     0.07 * (rng() - 0.5),
    advanceSpeed,
    spawnTime:    Date.now(),
    lifeMs,
  };
  scene.add(sprite);
  cacti.push(sprite);
}

// Queue a burst of targets to be spawned with small delays between them
function enqueueBurst(positions, delayMs) {
  positions.forEach((pos, i) => {
    burstQueue.push({ sx: pos[0], sy: pos[1], fireAt: Date.now() + i * delayMs });
  });
}

// Called every frame — fires queued burst spawns at the right time
function processBurstQueue() {
  const now = Date.now();
  for (let i = burstQueue.length - 1; i >= 0; i--) {
    if (now >= burstQueue[i].fireAt) {
      spawnTargetAt(burstQueue[i].sx, burstQueue[i].sy);
      burstQueue.splice(i, 1);
    }
  }
}

// Rotate through patterns; each lasts ~8–12 seconds
function tickPattern(dt) {
  patternTimer -= dt;
  if (patternTimer > 0) return;

  patternIdx   = (patternIdx + 1) % PATTERNS.length;
  patternTimer = 8000 + rng() * 4000;
  burstQueue   = [];
  showPatternLabel(PATTERNS[patternIdx]);
}

// Called each time the spawn accumulator fires
function spawnCactus() {
  if (!cactusMaterial || !gameRunning) return;
  const pattern = PATTERNS[patternIdx];

  if (pattern === 'scatter') {
    // Single random target anywhere in the field
    const sx = (rng() - 0.5) * 2;
    const sy = (rng() - 0.5) * 2;
    spawnTargetAt(sx, sy);

  } else if (pattern === 'flank') {
    // Force player to track left or right side only
    const side   = rng() > 0.5 ? 1 : -1;
    const sx     = side * (0.5 + rng() * 0.5);
    const sy     = (rng() - 0.5) * 2;
    spawnTargetAt(sx, sy);

  } else if (pattern === 'cluster') {
    // 3 targets near each other — burst out with 120ms gaps
    const cx = (rng() - 0.5) * 1.2;
    const cy = (rng() - 0.5) * 1.2;
    enqueueBurst([
      [cx,              cy             ],
      [cx + 0.25,       cy - 0.22      ],
      [cx - 0.22,       cy + 0.28      ],
    ], 120);

  } else if (pattern === 'crossfire') {
    // Alternating left and right — forces rapid side-to-side aim
    const side = rng() > 0.5 ? 1 : -1;
    enqueueBurst([
      [ side * 0.7,  (rng() - 0.5) * 1.5 ],
      [-side * 0.7,  (rng() - 0.5) * 1.5 ],
    ], 180);
  }
}

// ─── Level threshold ──────────────────────────────────────────────────────────
function scoreForLevel(lvl) {
  let t = 0;
  for (let n = 1; n <= lvl; n++) t += 5 + 5 * n;
  return t;
}

// ─── Particles ────────────────────────────────────────────────────────────────
function spawnParticles(pos) {
  for (let i = 0; i < 8; i++) {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.55, 0.55),
      new THREE.MeshBasicMaterial({ color: 0xFF0059, transparent: true })
    );
    mesh.position.copy(pos);
    scene.add(mesh);
    particles.push({
      mesh,
      vel: new THREE.Vector3(
        0.65 * (Math.random() - 0.5),
        0.65 * (Math.random() - 0.5),
        0.35 * (Math.random() - 0.5)
      ),
      life: 1,
    });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function refreshMenuHighScore() {
  const hs = getHighScore(selectedDifficulty);
  document.getElementById("menu-highscore").innerText = hs.toString().padStart(3, "0");
  document.getElementById("menu-highscore-diff").innerText =
    DIFFICULTIES[selectedDifficulty].label + " MODE";
}

function showEndScreenStats(won) {
  const accuracy    = totalShots > 0 ? Math.round((totalHits / totalShots) * 100) : 0;
  const elapsed     = Math.round((Date.now() - missionStartTime) / 1000);
  const hs          = getHighScore(selectedDifficulty);
  const isNewRecord = state.score > hs;
  if (isNewRecord) setHighScore(selectedDifficulty, state.score);
  if (won) {
    document.getElementById("victory-score").innerText     = state.score.toString().padStart(3, "0");
    document.getElementById("victory-highscore").innerText = Math.max(state.score, hs).toString().padStart(3, "0");
    document.getElementById("victory-accuracy").innerText  = accuracy + "%";
    document.getElementById("victory-streak").innerText    = bestStreak;
    document.getElementById("victory-time").innerText      = elapsed + "s";
    document.getElementById("victory-record-badge").style.display = isNewRecord ? "block" : "none";
  } else {
    elFinalScore.innerText = state.score.toString().padStart(3, "0");
    document.getElementById("death-highscore").innerText   = Math.max(state.score, hs).toString().padStart(3, "0");
    document.getElementById("final-level-val").innerText   = level.toString().padStart(2, "0");
    document.getElementById("final-accuracy").innerText    = accuracy + "%";
    document.getElementById("final-streak").innerText      = bestStreak;
    document.getElementById("final-time").innerText        = elapsed + "s";
    document.getElementById("new-record-badge").style.display = isNewRecord ? "block" : "none";
  }
}

// ─── Shooting ─────────────────────────────────────────────────────────────────
const raycaster  = new THREE.Raycaster();
const pointer    = new THREE.Vector2();
let lastShotTime = 0;

// Last known raw screen tap position (for power-up spawn placement)
let lastTapX = window.innerWidth  / 2;
let lastTapY = window.innerHeight / 2;

function shoot() {
  if (!gameRunning) return;
  const now = performance.now();
  const cooldown = (rapidFireUntil > Date.now()) ? 22 : 65;
  if (now - lastShotTime < cooldown) return;
  lastShotTime = now;
  totalShots++;
  playSound(sndShoot);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(cacti);
  if (hits.length > 0) {
    const target = hits[0].object;
    totalHits++;

    // Combo
    currentStreak++;
    bestStreak      = Math.max(bestStreak, currentStreak);
    comboTimer      = 0;
    comboMultiplier = currentStreak >= COMBO_THRESHOLDS[1] ? 3
                    : currentStreak >= COMBO_THRESHOLDS[0] ? 2 : 1;

    playSound(sndHit);
    spawnParticles(target.position);

    // Power-up: spawn near where the player tapped, not at the cactus 3D pos
    if (Math.random() < POWERUP_DROP_CHANCE) {
      spawnPowerup(lastTapX, lastTapY);
    }

    scene.remove(target);
    cacti.splice(cacti.indexOf(target), 1);
    state.score += comboMultiplier;
    updateHud(true);

    if (state.score >= 1000) { endGame(true); return; }

    if (state.score >= scoreForLevel(level)) {
      level++;
      triggerLevelUpFlash(level);
      playSound(sndShoot);
      const preset = DIFFICULTIES[selectedDifficulty];
      if (level === 11) {
        cactusSpeed   = preset.speed * 1.5;
        spawnInterval = Math.max(220, preset.interval * 0.68);
      } else if (level > 11) {
        cactusSpeed   += 0.015;
        strafeSpeed   += 0.018;
        spawnInterval  = Math.max(220, spawnInterval - 25);
      } else {
        cactusSpeed   += 0.022;
        spawnInterval  = Math.max(350, spawnInterval - 55);
      }
    }
  } else {
    currentStreak   = 0;
    comboMultiplier = 1;
    comboTimer      = 0;
  }
}

// ─── Input ────────────────────────────────────────────────────────────────────
function handlePointer(e) {
  if (!gameRunning) return;
  let cx, cy;
  if (e.type.includes("touch")) {
    cx = e.touches[0].clientX;
    cy = e.touches[0].clientY;
  } else {
    cx = e.clientX;
    cy = e.clientY;
  }
  lastTapX = cx;
  lastTapY = cy;
  if (elCrosshair && gameRunning) {
    const n = isMobile ? 12 : 16;
    elCrosshair.style.display   = "block";
    elCrosshair.style.transform = `translate(${cx - n}px, ${cy - n}px)`;
  }
  pointer.x = (cx / window.innerWidth)  *  2 - 1;
  pointer.y = (cy / window.innerHeight) * -2 + 1;
  if (e.type === "mousedown" || e.type === "touchstart") shoot();
}

// ─── Start / Reset ────────────────────────────────────────────────────────────
function startGame() {
  cacti.forEach(c => scene.remove(c));
  particles.forEach(p => scene.remove(p.mesh));
  cacti.length     = 0;
  particles.length = 0;
  clearPowerups();

  state.score  = 0;
  state.health = 100;
  level        = 1;
  accumulator  = 0;
  lastFrameTime    = Date.now();
  missionStartTime = Date.now();
  totalShots = 0; totalHits = 0;
  currentStreak = 0; bestStreak = 0;
  comboMultiplier = 1; comboTimer = 0;
  rapidFireUntil = 0; shieldUntil = 0; shieldActive = false;
  shakeTimer = 0; patternIdx = 0; patternTimer = 8000; burstQueue = []; burstCooldown = 0;
  camera.position.copy(camOrigin);

  const preset  = DIFFICULTIES[selectedDifficulty];
  cactusSpeed   = preset.speed;
  spawnInterval = preset.interval;
  strafeSpeed   = preset.strafeSpeed;

  rng = isDailyChallenge ? makeRng(getDailySeed()) : Math.random;

  updateHud();
  elComboHud.style.display = "none";
  gameRunning = true;
  document.body.classList.add("game-running");
  document.body.classList.remove("menu-active");
  elMenuOverlay.style.display  = "none";
  elDeathOverlay.style.display = "none";
  elVictOverlay.style.display  = "none";
  elSupport.style.display      = "none";
  elCrosshair.style.display    = "none";
}

function endGame(won) {
  gameRunning = false;
  document.body.classList.remove("game-running");
  elCrosshair.style.display = "none";
  elSupport.style.display   = "block";
  elComboHud.style.display  = "none";
  pillRapid.style.display   = "none";
  pillShield.style.display  = "none";
  clearPowerups();
  camera.position.copy(camOrigin);
  showEndScreenStats(won);
  won ? (elVictOverlay.style.display = "flex") : (elDeathOverlay.style.display = "flex");
  document.body.classList.add("menu-active");
  playSound(sndGameover);
}

// ─── Difficulty buttons ───────────────────────────────────────────────────────
document.querySelectorAll(".btn-diff").forEach(btn => {
  btn.addEventListener("click", () => {
    selectedDifficulty = btn.dataset.diff;
    document.querySelectorAll(".btn-diff").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    refreshMenuHighScore();
  });
});

// ─── Menu buttons ─────────────────────────────────────────────────────────────
document.getElementById("start-btn").onclick           = () => { isDailyChallenge = false; startGame(); };
document.getElementById("daily-btn").onclick           = () => { isDailyChallenge = true; selectedDifficulty = "standard"; startGame(); };
document.getElementById("restart-btn").onclick         = () => { isDailyChallenge = false; startGame(); };
document.getElementById("main-menu-btn").onclick       = () => location.reload();
document.getElementById("victory-restart-btn").onclick = () => { isDailyChallenge = false; startGame(); };
document.getElementById("victory-menu-btn").onclick    = () => location.reload();

window.addEventListener("mousedown",  handlePointer);
window.addEventListener("touchstart", handlePointer, { passive: false });
window.addEventListener("mousemove",  handlePointer);
window.addEventListener("touchmove",  handlePointer, { passive: false });
window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

refreshMenuHighScore();

// ─── Entities ─────────────────────────────────────────────────────────────────
const cacti     = [];
const particles = [];

// ─── Game Loop ────────────────────────────────────────────────────────────────
(function loop() {
  requestAnimationFrame(loop);
  const now = Date.now();
  const dt  = Math.min(now - lastFrameTime, 100); // cap dt to avoid spiral
  lastFrameTime = now;

  if (gameRunning) {
    updateBuffPills(now);
    updateShake(dt);
    updatePowerups();

    // Combo decay
    comboTimer += dt;
    if (comboTimer >= COMBO_WINDOW && currentStreak > 0) {
      currentStreak = 0; comboMultiplier = 1;
    }
    updateComboHud();

    // Pattern rotation & burst queue
    tickPattern(dt);
    processBurstQueue();

    // Spawn — only when burst queue is clear, keep target count tight
    accumulator += dt;
    const cap = isMobile ? 7 : 10;
    if (accumulator >= spawnInterval && cacti.length < cap && burstQueue.length === 0) {
      spawnCactus();
      accumulator = 0;
    }

    // Move & expire cacti
    const nowMs = Date.now();
    for (let i = cacti.length - 1; i >= 0; i--) {
      const c  = cacti[i];
      const ud = c.userData;

      // Gentle drift toward player (consequence for ignoring targets)
      c.position.z += ud.advanceSpeed;
      c.material.rotation += ud.rotSpeed;

      // Fade out in last 400ms so expiry is telegraphed
      const age      = nowMs - ud.spawnTime;
      const timeLeft = ud.lifeMs - age;
      if (timeLeft < 400) c.material.opacity = Math.max(0, timeLeft / 400);

      const expired  = age >= ud.lifeMs;
      const breached = c.position.z > 6;

      if (expired || breached) {
        scene.remove(c);
        cacti.splice(i, 1);
        currentStreak = 0; comboMultiplier = 1;

        if (shieldActive) {
          showPickupToast('🛡️ BLOCKED!', '#00aaff');
        } else {
          state.health -= 20;
          updateHud();
          playSound(sndDamage);
          triggerDamageEffect();
          if (state.health <= 0) { endGame(false); break; }
        }
      }
    }

    // Particles
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.mesh.position.add(p.vel);
      p.life -= 0.045;
      p.mesh.material.opacity = Math.max(0, p.life);
      if (p.life <= 0) { scene.remove(p.mesh); particles.splice(i, 1); }
    }
  }

  renderer.render(scene, camera);
})();
