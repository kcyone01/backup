import * as THREE from "https://unpkg.com/three@0.160.0/build/three.module.js";

// ─── Loading ─────────────────────────────────────────────────────────────────
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

// ─── High Score Storage ───────────────────────────────────────────────────────
const HS_KEYS = { recon: "cs_hs_recon", standard: "cs_hs_standard", blacksite: "cs_hs_blacksite" };
function getHighScore(diff) { return parseInt(localStorage.getItem(HS_KEYS[diff]) || "0", 10); }
function setHighScore(diff, val) { localStorage.setItem(HS_KEYS[diff], val); }

// ─── Difficulty Presets ───────────────────────────────────────────────────────
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
  if ((XORKEY ^ state._score) !== state._shadowScore ||
      (XORKEY ^ state._health) !== state._shadowHealth) {
    console.error("TACTICAL ERROR: MEMORY CORRUPTION DETECTED");
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

// ─── Combo / Streak ───────────────────────────────────────────────────────────
let currentStreak    = 0;
let bestStreak       = 0;
let comboMultiplier  = 1;
let comboTimer       = 0;
const COMBO_WINDOW   = 3000;
const COMBO_THRESHOLDS = [5, 10];

// ─── Stats ────────────────────────────────────────────────────────────────────
let totalShots = 0;
let totalHits  = 0;

// ─── Daily Challenge ─────────────────────────────────────────────────────────
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

// ─── Power-up system ─────────────────────────────────────────────────────────
// Types: 'health' | 'rapidfire' | 'shield'
const POWERUP_TYPES = ['health', 'rapidfire', 'shield'];
const POWERUP_DROP_CHANCE = 0.18; // 18% chance per kill
const POWERUP_COLORS = { health: 0x00ff88, rapidfire: 0xff6600, shield: 0x00aaff };
const POWERUP_LABELS = { health: '❤️', rapidfire: '⚡', shield: '🛡️' };
const POWERUP_DURATION = { rapidfire: 5000, shield: 6000 }; // ms

let powerups = []; // { mesh, labelEl, type, vel, life, bobPhase }

// Active buff timers
let rapidFireUntil = 0;
let shieldUntil    = 0;
let shieldActive   = false;

// DOM indicators for active buffs
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
    background:rgba(0,0,0,0.85); border:2px solid ${color};
    padding:4px 12px; font-size:0.7rem; letter-spacing:2px; color:${color};
    font-weight:900; box-shadow:0 0 12px ${color}44;
  `;
  el.innerHTML = `${icon} <span id="${id}-timer"></span>`;
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

// Small floating toast for pickup feedback
let toastTimeout = null;
const elToast = document.createElement("div");
elToast.style.cssText = `
  position:fixed; top:50%; left:50%; transform:translate(-50%,-50%);
  font-size:1.4rem; font-weight:900; letter-spacing:4px;
  pointer-events:none; z-index:200; opacity:0;
  transition:opacity 0.15s; text-shadow:0 0 20px currentColor;
`;
document.body.appendChild(elToast);
function showPickupToast(msg, color) {
  elToast.innerText = msg;
  elToast.style.color = color;
  elToast.style.opacity = "1";
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => (elToast.style.opacity = "0"), 900);
}

// Spawn a floating power-up orb at a 3D position
function spawnPowerup(pos) {
  const type  = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
  const color = POWERUP_COLORS[type];

  // Glowing orb mesh
  const geo  = new THREE.SphereGeometry(0.9, 10, 10);
  const mat  = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.92 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.copy(pos);
  mesh.position.z = Math.min(pos.z + 2, 4); // pull toward player a bit
  scene.add(mesh);

  // HTML label floating over it
  const labelEl = document.createElement("div");
  labelEl.style.cssText = `
    position:fixed; pointer-events:none; z-index:30;
    font-size:1.4rem; transform:translate(-50%,-50%);
    filter:drop-shadow(0 0 6px white);
  `;
  labelEl.innerText = POWERUP_LABELS[type];
  document.body.appendChild(labelEl);

  powerups.push({ mesh, labelEl, type, life: 6.0, bobPhase: Math.random() * Math.PI * 2 });
}

// Project 3D position to screen coords for label placement
function toScreen(pos3d) {
  const v = pos3d.clone().project(camera);
  return {
    x: (v.x * 0.5 + 0.5) * window.innerWidth,
    y: (-v.y * 0.5 + 0.5) * window.innerHeight,
  };
}

// Update all floating power-ups each frame
function updatePowerups(dt) {
  const now = Date.now();
  for (let i = powerups.length - 1; i >= 0; i--) {
    const p = powerups[i];
    p.life -= dt / 1000;

    // Bob gently
    p.bobPhase += dt * 0.003;
    p.mesh.position.y += Math.sin(p.bobPhase) * 0.01;

    // Drift toward camera
    p.mesh.position.z += 0.04;

    // Pulse opacity
    p.mesh.material.opacity = 0.7 + 0.3 * Math.sin(p.bobPhase * 2);

    // Update label position
    const sc = toScreen(p.mesh.position);
    p.labelEl.style.left = sc.x + "px";
    p.labelEl.style.top  = (sc.y - 30) + "px";

    // Player collision — close enough in Z and roughly centered on screen
    const distZ = Math.abs(p.mesh.position.z - camera.position.z);
    if (distZ < 8 && p.mesh.position.z > 3) {
      // Collect it!
      activatePowerup(p.type);
      scene.remove(p.mesh);
      p.labelEl.remove();
      powerups.splice(i, 1);
      continue;
    }

    // Expire
    if (p.life <= 0 || p.mesh.position.z > 10) {
      scene.remove(p.mesh);
      p.labelEl.remove();
      powerups.splice(i, 1);
    }
  }
}

function clearPowerups() {
  powerups.forEach(p => { scene.remove(p.mesh); p.labelEl.remove(); });
  powerups = [];
}

// ─── Screen shake + red flash ─────────────────────────────────────────────────
let shakeTimer     = 0;
let shakeMagnitude = 0;
const camOrigin    = new THREE.Vector3(0, 0, 5);

const elDamageFlash = document.createElement("div");
elDamageFlash.style.cssText = `
  position:fixed; inset:0; pointer-events:none; z-index:60;
  background:rgba(255,0,0,0); transition:background 0.08s;
`;
document.body.appendChild(elDamageFlash);

function triggerDamageEffect() {
  // Flash
  elDamageFlash.style.background = "rgba(255,0,0,0.35)";
  setTimeout(() => (elDamageFlash.style.background = "rgba(255,0,0,0)"), 180);
  // Shake
  shakeTimer     = 400; // ms
  shakeMagnitude = 0.22;
}

function updateShake(dt) {
  if (shakeTimer <= 0) {
    camera.position.copy(camOrigin);
    return;
  }
  shakeTimer -= dt;
  const t = shakeTimer / 400;
  const mag = shakeMagnitude * t;
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
elLevelWrap.style.cssText = `position:absolute;top:${isMobile?"20px":"40px"};right:${isMobile?"20px":"60px"};color:#00ff00;font-size:${isMobile?"0.8rem":"1.1rem"};font-weight:700;letter-spacing:3px;text-shadow:0 0 12px #00ff00;pointer-events:none`;
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

// ─── Combo HUD ────────────────────────────────────────────────────────────────
function updateComboHud() {
  if (comboMultiplier <= 1 && currentStreak === 0) {
    elComboHud.style.display = "none"; return;
  }
  elComboHud.style.display = "block";
  elComboVal.innerText = `x${comboMultiplier}  🔥${currentStreak}`;
  const pct = Math.max(0, 1 - comboTimer / COMBO_WINDOW) * 100;
  elComboBar.style.width = pct + "%";
}

// ─── Level-up flash ───────────────────────────────────────────────────────────
function triggerLevelUpFlash(lvl) {
  elLevelFlash.innerHTML = `<div id="levelup-flash-text">⚡ LEVEL ${lvl} ⚡</div>`;
  elLevelFlash.classList.remove("active");
  void elLevelFlash.offsetWidth;
  elLevelFlash.classList.add("active");
}

// ─── Spawn cactus ─────────────────────────────────────────────────────────────
function spawnCactus() {
  if (!cactusMaterial || !gameRunning) return;
  const fovRad = THREE.MathUtils.degToRad(camera.fov);
  const frustH = 2 * Math.tan(fovRad / 2) * Math.abs(-40);
  const frustW = frustH * camera.aspect * (window.innerWidth < 768 ? 0.6 : 0.7);
  const sprite = new THREE.Sprite(cactusMaterial);
  const sz = window.innerWidth < 768 ? 3.8 : 7.3;
  sprite.scale.set(sz * mobileScale, sz * mobileScale, 1);
  const x = (rng() - 0.5) * frustW;
  const y = (rng() - 0.5) * (0.38 * frustH) + 2.2;
  sprite.position.set(x, y, -42);
  sprite.userData = {
    rotSpeed:  0.13 * (rng() - 0.5),
    strafeDir: rng() > 0.5 ? 1 : -1,
    limitX:    frustW / 2,
    canStrafe: level >= 11,
  };
  scene.add(sprite);
  cacti.push(sprite);
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

// ─── High score / stats helpers ───────────────────────────────────────────────
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

function shoot() {
  if (!gameRunning) return;
  const now = performance.now();
  const cooldown = (rapidFireUntil > Date.now()) ? 25 : 65; // rapid fire halves cooldown
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
    bestStreak     = Math.max(bestStreak, currentStreak);
    comboTimer     = 0;
    comboMultiplier = currentStreak >= COMBO_THRESHOLDS[1] ? 3
                    : currentStreak >= COMBO_THRESHOLDS[0] ? 2 : 1;

    playSound(sndHit);
    spawnParticles(target.position);

    // Power-up drop
    if (Math.random() < POWERUP_DROP_CHANCE) spawnPowerup(target.position);

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
    // Miss
    currentStreak    = 0;
    comboMultiplier  = 1;
    comboTimer       = 0;
  }
}

// ─── Input ────────────────────────────────────────────────────────────────────
function handlePointer(e) {
  if (!gameRunning) return;
  let cx, cy;
  if (e.type.includes("touch")) { cx = e.touches[0].clientX; cy = e.touches[0].clientY; }
  else                          { cx = e.clientX;             cy = e.clientY; }
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
  cacti.length = 0;
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
  shakeTimer = 0;
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
window.addEventListener("touchstart", handlePointer);
window.addEventListener("mousemove",  handlePointer);
window.addEventListener("touchmove",  handlePointer);
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
  const dt  = now - lastFrameTime;
  lastFrameTime = now;

  if (gameRunning) {
    updateBuffPills(now);
    updateShake(dt);

    // Combo decay
    comboTimer += dt;
    if (comboTimer >= COMBO_WINDOW && currentStreak > 0) {
      currentStreak = 0; comboMultiplier = 1;
    }
    updateComboHud();

    // Spawn
    accumulator += dt;
    while (accumulator >= spawnInterval && cacti.length < (isMobile ? 26 : 42)) {
      spawnCactus();
      accumulator -= spawnInterval;
    }

    // Move cacti
    for (let i = cacti.length - 1; i >= 0; i--) {
      const c  = cacti[i];
      const ud = c.userData;
      c.position.z += cactusSpeed;
      if (ud.canStrafe) {
        c.position.x += ud.strafeDir * strafeSpeed;
        if (Math.abs(c.position.x) > ud.limitX) {
          ud.strafeDir *= -1;
          c.position.x = ud.limitX * Math.sign(c.position.x);
        }
      }
      c.material.rotation += ud.rotSpeed;

      if (c.position.z > 7) {
        scene.remove(c);
        cacti.splice(i, 1);
        currentStreak = 0; comboMultiplier = 1;

        if (shieldActive) {
          // Shield absorbs the hit — show feedback but no damage
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

    // Power-ups
    updatePowerups(dt);
  }

  renderer.render(scene, camera);
})();
