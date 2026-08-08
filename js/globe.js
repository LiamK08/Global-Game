// Interactive 3D globe wrapper around globe.gl (loaded as the global `Globe`).
// Handles country rendering, proximity colouring, fly-to animation and theming.

import { heatColor } from './colors.js';

const THEMES = {
  dark: {
    ocean: '#16233f',
    land: '#5a6b86',
    landMuted: '#3b475d',
    stroke: '#0a0f1f',
    atmosphere: '#5b8cff',
  },
  light: {
    ocean: '#9ec8ff',
    land: '#8097bd',
    landMuted: '#a9b8d2',
    stroke: '#54688f',
    atmosphere: '#cfe0ff',
  },
};

const BASE_ALTITUDE = 0.01;
const GUESS_ALTITUDE = 0.012;
const WINNER_ALTITUDE = 0.06;
const FLY_ALTITUDE = 1.7;

export class GlobeView {
  /**
   * @param {HTMLElement} container
   * @param {object} geojson  FeatureCollection of country polygons
   * @param {'dark'|'light'} theme
   */
  constructor(container, geojson, theme = 'dark') {
    this.container = container;
    this.colors = THEMES[theme] || THEMES.dark;
    /** @type {Map<string, {proximity:number, correct:boolean}>} */
    this.state = new Map();
    this.winnerId = null;

    const world = window.Globe()(container)
      .backgroundColor('rgba(0,0,0,0)')
      .showAtmosphere(true)
      .atmosphereColor(this.colors.atmosphere)
      .atmosphereAltitude(0.16)
      .polygonsData(geojson.features)
      .polygonCapColor((f) => this.capColor(f))
      .polygonSideColor(() => this.sideColor())
      .polygonStrokeColor(() => this.colors.stroke)
      .polygonAltitude((f) => this.altitude(f))
      .polygonLabel((f) => this.label(f))
      .polygonsTransitionDuration(0); // no per-update geometry tween — much lighter

    this.world = world;

    // Balance sharpness vs. speed: allow up to 1.5x device pixels so the globe
    // looks crisp on high-DPI screens without the cost of full native rendering.
    try {
      world.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    } catch {
      /* renderer not ready; ignore */
    }
    try {
      world.globeMaterial().color.set(this.colors.ocean);
    } catch {
      /* material not ready; ignore */
    }
    this.boostLighting();

    world.pointOfView({ lat: 20, lng: 0, altitude: 2.5 }, 0);

    const controls = world.controls();
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.5;
    controls.enablePan = false;
    controls.minDistance = 120;
    controls.maxDistance = 600;
    this._autoRotated = true;

    // Stop the idle spin as soon as the player grabs the globe.
    container.addEventListener('pointerdown', () => this.stopAutoRotate(), { once: true });

    this.resize();
    this._onResize = () => this.resize();
    window.addEventListener('resize', this._onResize);
  }

  capColor(feat) {
    const p = feat.properties;
    const g = this.state.get(p.id);
    if (g) return heatColor(g.proximity);
    return p.guessable ? this.colors.land : this.colors.landMuted;
  }

  sideColor() {
    return 'rgba(0, 0, 0, 0.18)';
  }

  /** Hover tooltip: only countries you've guessed reveal their name + proximity. */
  label(feat) {
    const g = this.state.get(feat.properties.id);
    if (!g) return ''; // un-guessed countries stay anonymous
    return `<div class="globe-tip"><b>${escapeHtml(feat.properties.name)}</b><span>${Math.round(g.proximity * 100)}%</span></div>`;
  }

  altitude(feat) {
    const id = feat.properties.id;
    if (id === this.winnerId) return WINNER_ALTITUDE;
    return this.state.has(id) ? GUESS_ALTITUDE : BASE_ALTITUDE;
  }

  /** Even out the lighting so heat colours read on the night side too. */
  boostLighting() {
    try {
      for (const light of this.world.lights()) {
        if (light.isAmbientLight) light.intensity = 1.5;
        else if (light.isDirectionalLight) light.intensity = 0.7;
      }
    } catch {
      /* lighting API unavailable; defaults are acceptable */
    }
  }

  /** Record/replace a guess's proximity and re-colour. */
  applyGuess({ id, proximity, correct }) {
    this.state.set(id, { proximity, correct: !!correct });
    if (correct) this.winnerId = id;
    this.refresh();
  }

  /** Smoothly rotate the globe to centre on a point. */
  flyTo({ lat, lng }, ms = 900) {
    this.world.pointOfView({ lat, lng, altitude: FLY_ALTITUDE }, ms);
  }

  markWinner(id) {
    this.winnerId = id;
    this.refresh();
  }

  /** Re-evaluate polygon accessors to trigger a redraw with current state. */
  refresh() {
    this.world
      .polygonCapColor((f) => this.capColor(f))
      .polygonAltitude((f) => this.altitude(f))
      .polygonLabel((f) => this.label(f));
  }

  stopAutoRotate() {
    if (!this._autoRotated) return;
    this.world.controls().autoRotate = false;
    this._autoRotated = false;
  }

  setTheme(theme) {
    this.colors = THEMES[theme] || THEMES.dark;
    try {
      this.world.globeMaterial().color.set(this.colors.ocean);
    } catch {
      /* ignore */
    }
    this.world.atmosphereColor(this.colors.atmosphere).polygonStrokeColor(() => this.colors.stroke);
    this.refresh();
  }

  /** Reset to a fresh game: clear all guesses, recolour and resume idle spin. */
  reset() {
    this.state.clear();
    this.winnerId = null;
    this.refresh();
    this.world.pointOfView({ lat: 20, lng: 0, altitude: 2.5 }, 700);
    this.world.controls().autoRotate = true;
    this._autoRotated = true;
    this.container.addEventListener('pointerdown', () => this.stopAutoRotate(), { once: true });
  }

  resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.world.width(w).height(h);
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
