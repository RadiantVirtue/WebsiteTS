/** Animation timing constants for the Tetris replay visualiser. */
export const ANIM = {
  // Base frame duration formula: SPEED_BASE_MS + (10 - speed) * SPEED_FACTOR_MS
  SPEED_BASE_MS:   260,
  SPEED_FACTOR_MS: 260,

  // How frameDuration splits between the two phases
  CANDIDATE_PHASE_FRAC: 0.65,
  PLACED_PHASE_FRAC:    0.35,

  // Sub-phases within candidateDuration: sweep-in then fade-out
  SWEEP_IN_FRAC: 0.65,
  FADE_OUT_FRAC: 0.35,

  // Ghost opacity levels
  GHOST_BASE_ALPHA:         0.20, // non-chosen ghost (sweep + static)
  GHOST_CHOSEN_INIT_ALPHA:  0.20, // chosen ghost at start of fade-in
  GHOST_CHOSEN_DELTA_ALPHA: 0.65, // delta added over fade-in (→ 0.85 max)
  GHOST_CHOSEN_STATIC_ALPHA: 0.45, // chosen ghost in static renderFrame()
} as const;

/** UI interaction timing constants. */
export const UI = {
  LOAD_FADE_DELAY_MS: 650, // Wait for run-info fade-out before swapping game data
  TOAST_DURATION_MS:  2000,
} as const;

/** Canvas visual constants. */
export const CANVAS = {
  BG_COLOR:        '#0d0d0d',
  GRID_COLOR:      '#333333',
  GRID_LINE_WIDTH: 0.5,
  FALLBACK_COLOR:  '#888', // used when a piece ID has no colour entry
} as const;
