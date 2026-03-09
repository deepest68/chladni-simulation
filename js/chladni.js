/**
 * chladni.js — 클라드니 패턴 인터랙티브 시뮬레이션
 *
 * 수학적 모드:  z = sin(m·π·x) · sin(n·π·y)
 * 물리적 모드:  고정점 + 활 위치 기반 파동 중첩 시뮬레이션
 * 입자들은 진동 강도가 낮은 노드 라인으로 이동합니다.
 */

'use strict';

/* ─────────────────────────────────────────────
   Configuration
───────────────────────────────────────────── */
const CONFIG = {
  // Canvas grid resolution for the vibration field cache
  FIELD_RES: 256,

  // Particle physics
  DAMPING:              0.85,  // velocity damping per frame
  FORCE_SCALE:          1.0,   // gradient → force multiplier (0.1 ~ 2.0)
  VIBRATION_AMPLITUDE:  0.5,   // excitation amplitude for physical mode (0.0 ~ 1.0)
  EXCITATION_DECAY:     3,     // controls how quickly excitation falls off with distance (lower = wider spread)
  NOISE_SCALE:          0.3,   // random perturbation magnitude
  MAX_SPEED:            4.0,   // maximum particle speed (px/frame)

  // Rendering
  PARTICLE_RADIUS: 1.5,
  PARTICLE_COLOR:  '#f0f0e0',
  HEATMAP_ALPHA:   0.55,  // opacity of the heatmap overlay

  // Canvas padding (px, accounts for 2 × 1 rem wrapper padding)
  CANVAS_PADDING: 32,

  // FPS counter update interval (ms)
  FPS_INTERVAL: 500,

  // Physical mode: total fixed-point limit (1 center + 2 user)
  MAX_FIXED_POINTS: 3,

  // Physical mode: normalised radius for hit-testing fixed points on click
  FP_HIT_RADIUS: 0.05,
};

/* ─────────────────────────────────────────────
   Chladni Field
   Computes z = |sin(m·π·x) · sin(n·π·y)|
   over a unit square, cached in a Float32Array.
───────────────────────────────────────────── */
class ChladniField {
  constructor(res) {
    this.res = res;
    this.data = new Float32Array(res * res);
  }

  /**
   * Rebuild the vibration-amplitude field for modes (m, n).
   */
  compute(m, n) {
    const { res, data } = this;
    const pi = Math.PI;
    for (let row = 0; row < res; row++) {
      const y = row / (res - 1);
      const sy = Math.sin(n * pi * y);
      for (let col = 0; col < res; col++) {
        const x = col / (res - 1);
        data[row * res + col] = Math.abs(Math.sin(m * pi * x) * sy);
      }
    }
  }

  /**
   * Bilinear sample of the field at normalised coords (nx, ny) ∈ [0,1].
   */
  sample(nx, ny) {
    const { res, data } = this;
    const fx = Math.max(0, Math.min(1, nx)) * (res - 1);
    const fy = Math.max(0, Math.min(1, ny)) * (res - 1);
    const col = Math.floor(fx);
    const row = Math.floor(fy);
    const tx  = fx - col;
    const ty  = fy - row;
    const c1  = Math.min(col + 1, res - 1);
    const r1  = Math.min(row + 1, res - 1);
    return (1 - ty) * ((1 - tx) * data[row * res + col]  + tx * data[row * res + c1])
          +     ty  * ((1 - tx) * data[r1  * res + col]  + tx * data[r1  * res + c1]);
  }

  /**
   * Compute the spatial gradient of the amplitude at (nx, ny).
   * Returns {gx, gy} pointing in the direction of increasing amplitude.
   */
  gradient(nx, ny) {
    const eps = 1 / (this.res - 1);
    const gx = (this.sample(nx + eps, ny) - this.sample(nx - eps, ny)) / (2 * eps);
    const gy = (this.sample(nx, ny + eps) - this.sample(nx, ny - eps)) / (2 * eps);
    return { gx, gy };
  }
}

/* ─────────────────────────────────────────────
   Realistic Chladni Field (Physical Mode)
   Computes vibration amplitude based on:
   - Fixed points (nodes where amplitude = 0)
   - Bow position (excitation source at edge)
   using wave superposition.
───────────────────────────────────────────── */
class RealisticChladniField {
  constructor(res) {
    this.res = res;
    this.data = new Float32Array(res * res);
    // Default state
    this.fixedPoints = [{ x: 0.5, y: 0.5, type: 'center', removable: false }];
    this.bowPosition = 'bottom';
  }

  /**
   * Rebuild the field based on current fixedPoints, bowPosition and amplitude.
   * @param {Array}  fixedPoints
   * @param {string} bowPosition
   * @param {number} [amplitude=CONFIG.VIBRATION_AMPLITUDE]
   */
  compute(fixedPoints, bowPosition, amplitude = CONFIG.VIBRATION_AMPLITUDE) {
    this.fixedPoints = fixedPoints;
    this.bowPosition = bowPosition;
    const { res, data } = this;

    // Compute raw amplitude at each grid cell
    let maxVal = 0;
    for (let row = 0; row < res; row++) {
      for (let col = 0; col < res; col++) {
        const x = col / (res - 1);
        const y = row / (res - 1);

        // Excitation from bow position (scaled by amplitude)
        const excitation = this._calculateExcitation(x, y, amplitude);

        // Contribution from each fixed point (wave from that point)
        let waveSum = 0;
        for (const fp of fixedPoints) {
          const dist = Math.sqrt((x - fp.x) ** 2 + (y - fp.y) ** 2);
          // Standing wave: sin(dist * π * freq) decays away from fixed point
          waveSum += Math.sin(dist * Math.PI * 8) / (1 + dist * 6);
        }

        // Modulate by excitation
        const val = Math.abs(waveSum * excitation);
        data[row * res + col] = val;
        if (val > maxVal) maxVal = val;
      }
    }

    // Normalise to [0, 1]
    if (maxVal > 0) {
      for (let i = 0; i < data.length; i++) {
        data[i] /= maxVal;
      }
    }
  }

  /**
   * Excitation intensity at (x, y) from the bow position.
   * Uses a gentler decay (coefficient 3 vs. the old 20) so that the entire
   * plate receives vibration energy, plus a standing-wave modulation and a
   * configurable amplitude scale.
   *
   * @param {number} x         - normalised x ∈ [0,1]
   * @param {number} y         - normalised y ∈ [0,1]
   * @param {number} amplitude - scale factor ∈ [0,1]
   */
  _calculateExcitation(x, y, amplitude = 1.0) {
    let dist;
    switch (this.bowPosition) {
      case 'top':    dist = y;       break;
      case 'bottom': dist = 1 - y;   break;
      case 'left':   dist = x;       break;
      case 'right':  dist = 1 - x;   break;
      default:       dist = 0.5;
    }

    // Gentler decay ensures far regions still vibrate.
    // The 0.3 base floor guarantees a minimum energy across the entire plate;
    // the remaining 0.7 ramps up toward the bow edge.
    const baseExcitation = 0.3 + 0.7 * Math.exp(-(dist ** 2) * CONFIG.EXCITATION_DECAY);

    // Standing-wave modulation — adds physical realism (constructive /
    // destructive interference along the propagation axis).
    // The 0.5 ± 0.5 envelope keeps the result in [0, 1].
    const standingWave = Math.cos(dist * Math.PI * 2);

    return amplitude * baseExcitation * (0.5 + 0.5 * standingWave);
  }

  /**
   * Bilinear sample — identical interface to ChladniField.sample().
   */
  sample(nx, ny) {
    const { res, data } = this;
    const fx = Math.max(0, Math.min(1, nx)) * (res - 1);
    const fy = Math.max(0, Math.min(1, ny)) * (res - 1);
    const col = Math.floor(fx);
    const row = Math.floor(fy);
    const tx  = fx - col;
    const ty  = fy - row;
    const c1  = Math.min(col + 1, res - 1);
    const r1  = Math.min(row + 1, res - 1);
    return (1 - ty) * ((1 - tx) * data[row * res + col]  + tx * data[row * res + c1])
          +     ty  * ((1 - tx) * data[r1  * res + col]  + tx * data[r1  * res + c1]);
  }

  /**
   * Spatial gradient — identical interface to ChladniField.gradient().
   */
  gradient(nx, ny) {
    const eps = 1 / (this.res - 1);
    const gx = (this.sample(nx + eps, ny) - this.sample(nx - eps, ny)) / (2 * eps);
    const gy = (this.sample(nx, ny + eps) - this.sample(nx, ny - eps)) / (2 * eps);
    return { gx, gy };
  }
}

/* ─────────────────────────────────────────────
   Particle
───────────────────────────────────────────── */
class Particle {
  constructor(canvasW, canvasH) {
    this.reset(canvasW, canvasH);
  }

  reset(canvasW, canvasH) {
    this.x  = Math.random() * canvasW;
    this.y  = Math.random() * canvasH;
    this.vx = (Math.random() - 0.5) * 2;
    this.vy = (Math.random() - 0.5) * 2;
  }

  /**
   * Update velocity and position.
   * The particle is pushed toward lower-amplitude regions (node lines).
   *
   * @param {ChladniField} field
   * @param {number} canvasW
   * @param {number} canvasH
   */
  update(field, canvasW, canvasH) {
    const nx = this.x / canvasW;
    const ny = this.y / canvasH;

    // Gradient points toward higher amplitude → negate to push toward nodes
    const { gx, gy } = field.gradient(nx, ny);

    this.vx = (this.vx - gx * CONFIG.FORCE_SCALE) * CONFIG.DAMPING
              + (Math.random() - 0.5) * CONFIG.NOISE_SCALE;
    this.vy = (this.vy - gy * CONFIG.FORCE_SCALE) * CONFIG.DAMPING
              + (Math.random() - 0.5) * CONFIG.NOISE_SCALE;

    // Clamp speed
    const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
    if (speed > CONFIG.MAX_SPEED) {
      const inv = CONFIG.MAX_SPEED / speed;
      this.vx *= inv;
      this.vy *= inv;
    }

    this.x += this.vx;
    this.y += this.vy;

    // Reflect off walls
    if (this.x < 0)        { this.x  = 0;        this.vx *= -0.5; }
    if (this.x > canvasW)  { this.x  = canvasW;  this.vx *= -0.5; }
    if (this.y < 0)        { this.y  = 0;        this.vy *= -0.5; }
    if (this.y > canvasH)  { this.y  = canvasH;  this.vy *= -0.5; }
  }
}

/* ─────────────────────────────────────────────
   Heatmap Renderer
   Draws the vibration-amplitude field as a
   coloured overlay behind the particles.
───────────────────────────────────────────── */
class HeatmapRenderer {
  constructor(res) {
    this.res = res;
    // Off-screen canvas at field resolution for fast blitting
    this.offscreen = document.createElement('canvas');
    this.offscreen.width  = res;
    this.offscreen.height = res;
    this.ctx = this.offscreen.getContext('2d');
    this.imgData = this.ctx.createImageData(res, res);
  }

  /**
   * Rebuild the RGBA image from the field data.
   */
  update(field) {
    const { res, imgData } = this;
    const buf = imgData.data;
    for (let i = 0; i < res * res; i++) {
      const v = field.data[i];       // amplitude [0,1]
      // Map amplitude to a cool-blue → warm-orange palette
      const t = v;                   // 0 = node (dark), 1 = antinode (bright)
      const r = Math.round(t * 180);
      const g = Math.round(t * 80);
      const b = Math.round(80 + t * 120);
      buf[i * 4]     = r;
      buf[i * 4 + 1] = g;
      buf[i * 4 + 2] = b;
      buf[i * 4 + 3] = Math.round(CONFIG.HEATMAP_ALPHA * 255);
    }
    this.ctx.putImageData(imgData, 0, 0);
  }

  /**
   * Draw scaled heatmap onto the main canvas.
   */
  draw(ctx, w, h) {
    ctx.drawImage(this.offscreen, 0, 0, w, h);
  }
}

/* ─────────────────────────────────────────────
   Main Simulation
───────────────────────────────────────────── */
class ChladniSimulation {
  constructor() {
    this.canvas   = document.getElementById('chladniCanvas');
    this.ctx      = this.canvas.getContext('2d');
    this.mathField    = new ChladniField(CONFIG.FIELD_RES);
    this.physField    = new RealisticChladniField(CONFIG.FIELD_RES);
    this.heatmap  = new HeatmapRenderer(CONFIG.FIELD_RES);
    this.particles = [];

    // Mathematical mode params
    this.m = 3;
    this.n = 2;

    // Physical mode params
    this.fixedPoints = [{ x: 0.5, y: 0.5, type: 'center', removable: false }];
    this.bowPosition = 'bottom';
    this.fixPointMode = false;  // whether clicks add fixed points

    // Shared state
    this.simulationMode = 'math'; // 'math' | 'physical'
    this.particleCount = 5000;
    this.showHeatmap   = true;
    this.rafId         = null;

    // FPS tracking
    this.fps         = 0;
    this.frameCount  = 0;
    this.totalFrames = 0;
    this.lastFpsTime = performance.now();

    this._bindUI();
    this._resize();
    window.addEventListener('resize', () => this._resize());
    this._reset();
    this._loop();
  }

  /* ── Current active field ───────────────────── */
  get field() {
    return this.simulationMode === 'math' ? this.mathField : this.physField;
  }

  /* ── UI binding ─────────────────────────────── */
  _bindUI() {
    // Sliders
    this._bindSlider('modeM',          v => { this.m = v;             this._rebuildField(); });
    this._bindSlider('modeN',          v => { this.n = v;             this._rebuildField(); });
    this._bindSlider('particleCount',  v => { this.particleCount = v; this._adjustParticles(); });

    // Vibration Amplitude slider (physical mode only)
    const ampSlider = document.getElementById('vibration-amplitude');
    const ampBadge  = document.getElementById('vibration-amplitude-value');
    ampSlider.addEventListener('input', () => {
      const v = parseInt(ampSlider.value, 10);
      CONFIG.VIBRATION_AMPLITUDE = v / 100;
      ampBadge.textContent = v + '%';
      if (this.simulationMode === 'physical') {
        this._rebuildField();
      }
    });

    // Force Scale slider
    const fsSlider = document.getElementById('force-scale');
    const fsBadge  = document.getElementById('force-scale-value');
    fsSlider.addEventListener('input', () => {
      const v = parseInt(fsSlider.value, 10);
      CONFIG.FORCE_SCALE = v / 100;
      fsBadge.textContent = v + '%';
    });

    // Heatmap toggle
    document.getElementById('showHeatmap').addEventListener('change', e => {
      this.showHeatmap = e.target.checked;
    });

    // Reset button
    document.getElementById('resetBtn').addEventListener('click', () => this._reset());

    // Save PNG button
    document.getElementById('saveBtn').addEventListener('click', () => this._saveImage());

    // Preset buttons (mathematical)
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const m = parseInt(btn.dataset.m, 10);
        const n = parseInt(btn.dataset.n, 10);
        this._applyPreset(m, n);
      });
    });

    // ── Mode selection ──
    document.querySelectorAll('input[name="simMode"]').forEach(radio => {
      radio.addEventListener('change', e => {
        this.simulationMode = e.target.value;
        this._onModeChange();
      });
    });

    // ── Physical mode controls ──

    // Fix Point Mode toggle
    document.getElementById('fixPointMode').addEventListener('change', e => {
      this.fixPointMode = e.target.checked;
      this._updateFixPointUI();
    });

    // Reset Fixed Points button
    document.getElementById('resetFixedPointsBtn').addEventListener('click', () => {
      this._resetFixedPoints();
    });

    // Bow position buttons
    document.querySelectorAll('.bow-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.bowPosition = btn.dataset.position;
        document.querySelectorAll('.bow-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById('bow-pos').textContent = btn.textContent.trim();
        this._rebuildField();
      });
    });

    // Physical presets
    document.querySelectorAll('.physical-preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const fp   = JSON.parse(btn.dataset.fixedpoints);
        const bow  = btn.dataset.bow;
        this._applyPhysicalPreset(fp, bow);
      });
    });

    // Mouse hover — show vibration intensity
    const hoverInfo  = document.getElementById('hoverInfo');
    const hoverValue = document.getElementById('hoverValue');
    this.canvas.addEventListener('mousemove', e => {
      const rect = this.canvas.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top)  / rect.height;
      const v  = this.field.sample(nx, ny);
      hoverValue.textContent = v.toFixed(3);
      hoverInfo.classList.remove('hidden');
    });
    this.canvas.addEventListener('mouseleave', () => {
      hoverInfo.classList.add('hidden');
    });

    // Canvas click — add / remove fixed points in physical mode
    this.canvas.addEventListener('click', e => {
      if (this.simulationMode !== 'physical' || !this.fixPointMode) return;

      const rect = this.canvas.getBoundingClientRect();
      const nx = (e.clientX - rect.left) / rect.width;
      const ny = (e.clientY - rect.top)  / rect.height;

      // Check if clicking near an existing removable fixed point
      const hitIdx = this.fixedPoints.findIndex(fp =>
        fp.removable &&
        Math.sqrt((nx - fp.x) ** 2 + (ny - fp.y) ** 2) < CONFIG.FP_HIT_RADIUS
      );
      if (hitIdx !== -1) {
        this.fixedPoints.splice(hitIdx, 1);
        this._rebuildField();
        this._updateFixPointUI();
        return;
      }

      // Add new fixed point (max 2 user points = MAX_FIXED_POINTS total)
      if (this.fixedPoints.length < CONFIG.MAX_FIXED_POINTS) {
        this.fixedPoints.push({ x: nx, y: ny, type: 'user', removable: true });
        this._rebuildField();
        this._updateFixPointUI();
      } else {
        this._showFixPointMessage('maximum');
      }
    });

    // Touch support for hover
    this.canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      const rect   = this.canvas.getBoundingClientRect();
      const touch  = e.touches[0];
      const nx = (touch.clientX - rect.left) / rect.width;
      const ny = (touch.clientY - rect.top)  / rect.height;
      const v  = this.field.sample(nx, ny);
      hoverValue.textContent = v.toFixed(3);
      hoverInfo.classList.remove('hidden');
    }, { passive: false });
    this.canvas.addEventListener('touchend', e => {
      hoverInfo.classList.add('hidden');
      // Touch tap — add fixed point
      if (this.simulationMode !== 'physical' || !this.fixPointMode) return;
      if (e.changedTouches.length === 0) return;
      const rect  = this.canvas.getBoundingClientRect();
      const touch = e.changedTouches[0];
      const nx = (touch.clientX - rect.left) / rect.width;
      const ny = (touch.clientY - rect.top)  / rect.height;
      const hitIdx = this.fixedPoints.findIndex(fp =>
        fp.removable &&
        Math.sqrt((nx - fp.x) ** 2 + (ny - fp.y) ** 2) < CONFIG.FP_HIT_RADIUS
      );
      if (hitIdx !== -1) {
        this.fixedPoints.splice(hitIdx, 1);
        this._rebuildField();
        this._updateFixPointUI();
        return;
      }
      if (this.fixedPoints.length < CONFIG.MAX_FIXED_POINTS) {
        this.fixedPoints.push({ x: nx, y: ny, type: 'user', removable: true });
        this._rebuildField();
        this._updateFixPointUI();
      }
    });
  }

  _bindSlider(id, onChange) {
    const slider = document.getElementById(id);
    const badge  = document.getElementById(`${id}-value`);
    const update = () => {
      const v = parseInt(slider.value, 10);
      badge.textContent = v;
      onChange(v);
    };
    slider.addEventListener('input', update);
  }

  /* ── Mode switch ────────────────────────────── */
  _onModeChange() {
    const isMath = this.simulationMode === 'math';
    document.getElementById('math-controls').classList.toggle('hidden', !isMath);
    document.getElementById('physical-controls').classList.toggle('hidden', isMath);
    document.getElementById('math-presets').classList.toggle('hidden', !isMath);
    document.getElementById('physical-presets').classList.toggle('hidden', isMath);
    this._updateInfoPanel();
    this._rebuildField();
  }

  /* ── Fixed point helpers ────────────────────── */
  _resetFixedPoints() {
    this.fixedPoints = [{ x: 0.5, y: 0.5, type: 'center', removable: false }];
    this._rebuildField();
    this._updateFixPointUI();
  }

  _updateFixPointUI() {
    const max = CONFIG.MAX_FIXED_POINTS;
    document.getElementById('fixedPointCount').textContent =
      `${this.fixedPoints.length}/${max}`;
    const msg = document.getElementById('fixPointMessage');
    if (this.fixedPoints.length >= max) {
      msg.textContent = `고정점이 최대 개수(${max}개)에 도달했습니다`;
      msg.className = 'fix-point-message warning';
    } else if (this.fixPointMode) {
      msg.textContent = `캔버스를 클릭하여 고정점 추가 (최대 ${max - 1}개 추가 가능)`;
      msg.className = 'fix-point-message active';
    } else {
      msg.textContent = '고정점 추가 모드를 켜서 고정점을 추가하세요';
      msg.className = 'fix-point-message';
    }
  }

  _showFixPointMessage(type) {
    const msg = document.getElementById('fixPointMessage');
    if (type === 'maximum') {
      msg.textContent = `고정점이 최대 개수(${CONFIG.MAX_FIXED_POINTS}개)에 도달했습니다`;
      msg.className = 'fix-point-message warning';
    }
  }

  /* ── Resize canvas to fill wrapper ─────────── */
  _resize() {
    const wrapper = this.canvas.parentElement;
    const size = Math.min(
      wrapper.clientWidth  - CONFIG.CANVAS_PADDING,
      window.innerHeight   * 0.7
    );
    this.canvas.width  = size;
    this.canvas.height = size;
    // Recompute particle positions relative to new size
    if (this.particles.length) this._reset();
  }

  /* ── Field / particle management ───────────── */
  _rebuildField() {
    if (this.simulationMode === 'math') {
      this.mathField.compute(this.m, this.n);
      this.heatmap.update(this.mathField);
    } else {
      this.physField.compute(this.fixedPoints, this.bowPosition, CONFIG.VIBRATION_AMPLITUDE);
      this.heatmap.update(this.physField);
    }
    // Scatter particles so they find new node lines
    this.particles.forEach(p => p.reset(this.canvas.width, this.canvas.height));
    this._updateInfoPanel();
  }

  _reset() {
    if (this.simulationMode === 'math') {
      this.mathField.compute(this.m, this.n);
      this.heatmap.update(this.mathField);
    } else {
      this.physField.compute(this.fixedPoints, this.bowPosition, CONFIG.VIBRATION_AMPLITUDE);
      this.heatmap.update(this.physField);
    }
    this.particles = Array.from(
      { length: this.particleCount },
      () => new Particle(this.canvas.width, this.canvas.height)
    );
    this._updateInfoPanel();
  }

  _adjustParticles() {
    const target = this.particleCount;
    const cur    = this.particles.length;
    if (target > cur) {
      for (let i = cur; i < target; i++) {
        this.particles.push(new Particle(this.canvas.width, this.canvas.height));
      }
    } else {
      this.particles.length = target;
    }
    document.getElementById('info-particles').textContent = target;
  }

  _applyPreset(m, n) {
    this.m = m;
    this.n = n;
    // Sync slider UI
    const sliderM = document.getElementById('modeM');
    const sliderN = document.getElementById('modeN');
    sliderM.value = m;
    sliderN.value = n;
    document.getElementById('modeM-value').textContent = m;
    document.getElementById('modeN-value').textContent = n;
    // Highlight active preset
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.classList.toggle('active',
        parseInt(btn.dataset.m, 10) === m && parseInt(btn.dataset.n, 10) === n);
    });
    this._rebuildField();
  }

  _applyPhysicalPreset(fixedPoints, bowPosition) {
    this.fixedPoints = fixedPoints;
    this.bowPosition = bowPosition;
    // Sync bow button UI
    document.querySelectorAll('.bow-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.position === bowPosition);
    });
    const bowLabel = { top: 'Top', right: 'Right', bottom: 'Bottom', left: 'Left' };
    document.getElementById('bow-pos').textContent = bowLabel[bowPosition] || bowPosition;
    // Highlight active physical preset
    document.querySelectorAll('.physical-preset-btn').forEach(btn => {
      const bfp  = JSON.parse(btn.dataset.fixedpoints);
      const bbow = btn.dataset.bow;
      btn.classList.toggle('active',
        bbow === bowPosition &&
        JSON.stringify(bfp) === JSON.stringify(fixedPoints)
      );
    });
    this._updateFixPointUI();
    this._rebuildField();
  }

  /* ── Save canvas as PNG ─────────────────────── */
  _saveImage() {
    const link = document.createElement('a');
    if (this.simulationMode === 'math') {
      link.download = `chladni-m${this.m}-n${this.n}.png`;
    } else {
      link.download = `chladni-physical-bow${this.bowPosition}.png`;
    }
    link.href = this.canvas.toDataURL('image/png');
    link.click();
  }

  /* ── Info panel ─────────────────────────────── */
  _updateInfoPanel() {
    if (this.simulationMode === 'math') {
      document.getElementById('info-mode').textContent = `m=${this.m}, n=${this.n}`;
    } else {
      const bowLabel = { top: 'Top', right: 'Right', bottom: 'Bottom', left: 'Left' };
      document.getElementById('info-mode').textContent =
        `Physical / bow=${bowLabel[this.bowPosition] || this.bowPosition}`;
    }
    document.getElementById('info-particles').textContent = this.particleCount;
  }

  _updateFps(now) {
    this.frameCount++;
    const elapsed = now - this.lastFpsTime;
    if (elapsed >= CONFIG.FPS_INTERVAL) {
      this.fps = Math.round((this.frameCount * 1000) / elapsed);
      this.frameCount  = 0;
      this.lastFpsTime = now;
      document.getElementById('info-fps').textContent = this.fps;
    }
  }

  _updateConvergence() {
    // Fraction of particles currently sitting close to a node line
    const threshold = 0.08;
    let converged = 0;
    const w = this.canvas.width;
    const h = this.canvas.height;
    for (const p of this.particles) {
      if (this.field.sample(p.x / w, p.y / h) < threshold) converged++;
    }
    const pct = Math.round((converged / this.particles.length) * 100);
    document.getElementById('info-convergence').textContent = `${pct}%`;
  }

  /* ── Animation loop ─────────────────────────── */
  _loop() {
    this.rafId = requestAnimationFrame(now => {
      this._update();
      this._draw();
      this._updateFps(now);
      this.totalFrames++;
      // Update convergence every ~30 frames (cheap enough)
      if (this.totalFrames % 30 === 0) this._updateConvergence();
      this._loop();
    });
  }

  _update() {
    const { field, particles, canvas } = this;
    for (const p of particles) {
      p.update(field, canvas.width, canvas.height);
    }
  }

  _draw() {
    const { ctx, canvas } = this;
    const { width: w, height: h } = canvas;

    // Clear
    ctx.fillStyle = '#0d0f14';
    ctx.fillRect(0, 0, w, h);

    // Heatmap overlay
    if (this.showHeatmap) {
      this.heatmap.draw(ctx, w, h);
    }

    // Particles
    ctx.fillStyle = CONFIG.PARTICLE_COLOR;
    ctx.beginPath();
    const r = CONFIG.PARTICLE_RADIUS;
    for (const p of this.particles) {
      ctx.moveTo(p.x + r, p.y);
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    }
    ctx.fill();

    // Physical mode overlays
    if (this.simulationMode === 'physical') {
      this._drawPhysicalOverlay(w, h);
    }
  }

  /* ── Physical mode canvas overlays ─────────── */
  _drawPhysicalOverlay(w, h) {
    const ctx = this.ctx;

    // Draw bow position highlight
    ctx.save();
    ctx.strokeStyle = '#ffd700';
    ctx.lineWidth = 4;
    ctx.shadowColor = '#ffd700';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    const PAD = 2;
    switch (this.bowPosition) {
      case 'top':    ctx.moveTo(PAD, PAD);     ctx.lineTo(w - PAD, PAD);     break;
      case 'bottom': ctx.moveTo(PAD, h - PAD); ctx.lineTo(w - PAD, h - PAD); break;
      case 'left':   ctx.moveTo(PAD, PAD);     ctx.lineTo(PAD, h - PAD);     break;
      case 'right':  ctx.moveTo(w - PAD, PAD); ctx.lineTo(w - PAD, h - PAD); break;
    }
    ctx.stroke();
    ctx.restore();

    // Draw fixed points
    for (const fp of this.fixedPoints) {
      const px = fp.x * w;
      const py = fp.y * h;
      const isCenter = fp.type === 'center';
      const radius   = isCenter ? 10 : 8;
      const color    = isCenter ? '#ff4444' : '#ff9944';
      const arm      = isCenter ? 10 : 8;

      ctx.save();
      ctx.strokeStyle = color;
      ctx.fillStyle   = color;
      ctx.lineWidth   = 2;
      ctx.shadowColor = color;
      ctx.shadowBlur  = 6;

      // Circle
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.stroke();

      // Cross
      ctx.beginPath();
      ctx.moveTo(px - arm, py); ctx.lineTo(px + arm, py);
      ctx.moveTo(px, py - arm); ctx.lineTo(px, py + arm);
      ctx.stroke();

      ctx.restore();
    }
  }
}

/* ─────────────────────────────────────────────
   Bootstrap
───────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  const sim = new ChladniSimulation();
  // Set default active bow button
  const defaultBow = document.querySelector('.bow-btn[data-default="true"]');
  if (defaultBow) defaultBow.classList.add('active');
});
