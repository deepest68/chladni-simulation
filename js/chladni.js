/**
 * chladni.js — 클라드니 패턴 인터랙티브 시뮬레이션
 *
 * 클라드니 방정식:  z = sin(m·π·x) · sin(n·π·y)
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
  DAMPING:      0.85,   // velocity damping per frame
  FORCE_SCALE:  0.8,    // gradient → force multiplier
  NOISE_SCALE:  0.3,    // random perturbation magnitude
  MAX_SPEED:    4.0,    // maximum particle speed (px/frame)

  // Rendering
  PARTICLE_RADIUS: 1.5,
  PARTICLE_COLOR:  '#f0f0e0',
  HEATMAP_ALPHA:   0.55,  // opacity of the heatmap overlay

  // Canvas padding (px, accounts for 2 × 1 rem wrapper padding)
  CANVAS_PADDING: 32,

  // FPS counter update interval (ms)
  FPS_INTERVAL: 500,
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
    this.field    = new ChladniField(CONFIG.FIELD_RES);
    this.heatmap  = new HeatmapRenderer(CONFIG.FIELD_RES);
    this.particles = [];

    this.m = 3;
    this.n = 2;
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

  /* ── UI binding ─────────────────────────────── */
  _bindUI() {
    // Sliders
    this._bindSlider('modeM',          v => { this.m = v;             this._rebuildField(); });
    this._bindSlider('modeN',          v => { this.n = v;             this._rebuildField(); });
    this._bindSlider('particleCount',  v => { this.particleCount = v; this._adjustParticles(); });

    // Heatmap toggle
    document.getElementById('showHeatmap').addEventListener('change', e => {
      this.showHeatmap = e.target.checked;
    });

    // Reset button
    document.getElementById('resetBtn').addEventListener('click', () => this._reset());

    // Save PNG button
    document.getElementById('saveBtn').addEventListener('click', () => this._saveImage());

    // Preset buttons
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const m = parseInt(btn.dataset.m, 10);
        const n = parseInt(btn.dataset.n, 10);
        this._applyPreset(m, n);
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

    // Touch support
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
    this.canvas.addEventListener('touchend', () => {
      hoverInfo.classList.add('hidden');
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
    this.field.compute(this.m, this.n);
    this.heatmap.update(this.field);
    // Scatter particles so they find new node lines
    this.particles.forEach(p => p.reset(this.canvas.width, this.canvas.height));
    this._updateInfoPanel();
  }

  _reset() {
    this.field.compute(this.m, this.n);
    this.heatmap.update(this.field);
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

  /* ── Save canvas as PNG ─────────────────────── */
  _saveImage() {
    const link = document.createElement('a');
    link.download = `chladni-m${this.m}-n${this.n}.png`;
    link.href = this.canvas.toDataURL('image/png');
    link.click();
  }

  /* ── Info panel ─────────────────────────────── */
  _updateInfoPanel() {
    document.getElementById('info-mode').textContent     = `m=${this.m}, n=${this.n}`;
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
  }
}

/* ─────────────────────────────────────────────
   Bootstrap
───────────────────────────────────────────── */
window.addEventListener('DOMContentLoaded', () => {
  new ChladniSimulation();
});
