import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  NgZone,
  OnDestroy,
  ViewChild,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import { ElementRef } from '@angular/core';
import { ScrollRevealDirective } from '../shared/scroll-reveal.directive';
import { TetrisCanvasRenderer } from './tetris-canvas.renderer';
import { ANIM, UI, CANVAS } from './replay.constants';

// ── Interfaces ───────────────────────────────────────────────────────────────

interface Candidate {
  rotation: number;
  col: number;
  drop_row: number;
  cells: [number, number][];
  q_value: number;
}

interface Frame {
  step: number;
  board_before: number[][];
  piece: string;
  next_piece: string;
  candidates: Candidate[];
  chosen_idx: number;
  board_after: number[][];
  lines_cleared_step: number;
  lines_cleared_total: number;
  score: number;
  pieces_placed: number;
  game_over: boolean;
}

interface ReplayData {
  metadata: {
    piece_ids: Record<string, number>;
    board_width: number;
    board_height: number;
    total_pieces: number;
    total_lines: number;
    final_score: number;
    seed: number;
    top_k_candidates: number;
  };
  frames: Frame[];
}

// ── Component ─────────────────────────────────────────────────────────────────

@Component({
  selector: 'app-tetris-replay',
  standalone: true,
  imports: [FormsModule, RouterLink, ScrollRevealDirective],
  templateUrl: './tetris-replay.component.html',
  styleUrls: ['./tetris-replay.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TetrisReplayComponent implements AfterViewInit, OnDestroy {
  @ViewChild('boardCanvas') boardCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild(ScrollRevealDirective) private revealDir!: ScrollRevealDirective;

  // ── Layout ─────────────────────────────────────────────────────────────────
  readonly CELL = 28;
  readonly COLS = 10;
  readonly ROWS = 20;

  // ── Piece colours (matte Material Design palette) ─────────────────────────
  readonly PIECE_COLORS: Record<number, string> = {
    1: '#455A64', // I – slate blue-grey
    2: '#FFA000', // O – deep amber
    3: '#7B1FA2', // T – muted plum
    4: '#388E3C', // S – forest green
    5: '#D32F2F', // Z – brick red
    6: '#1565C0', // J – deep blue
    7: '#E65100', // L – dark orange
  };

  private readonly PIECE_IDS: Record<string, number> = {
    I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7,
  };

  // ── Game selector ──────────────────────────────────────────────────────────
  readonly games: { id: number; label: string }[] = [
    { id: 1, label: 'Game 1 — 1205 pieces' },
    { id: 2, label: 'Game 2 — 5405 pieces' },
    { id: 3, label: 'Game 3 — 662 pieces'  },
    { id: 4, label: 'Game 4 — 1887 pieces' },
    { id: 5, label: 'Game 5 — 299 pieces'  },
  ];

  // ── Controls ───────────────────────────────────────────────────────────────
  selectedGame   = 3;
  isPlaying      = false;
  speed          = 5;
  showGhosts     = true;
  loading        = false;
  runInfoVisible = false;

  // ── Replay state ───────────────────────────────────────────────────────────
  replay: ReplayData | null = null;
  currentFrameIdx = 0;
  phase: 'candidates' | 'placed' = 'candidates';

  // ── Stats ──────────────────────────────────────────────────────────────────
  totalFrames = 0;

  // ── Animation state ────────────────────────────────────────────────────────
  private anim = { rafId: 0, lastTs: 0, phaseElapsed: 0, staggerRafId: 0 };

  // ── Visibility ────────────────────────────────────────────────────────────
  private wasPlayingBeforeHide = false;
  private visibilityHandler!: () => void;

  // ── Canvas renderer ───────────────────────────────────────────────────────
  private renderer!: TetrisCanvasRenderer;

  private readonly destroyRef = inject(DestroyRef);

  constructor(
    private readonly http: HttpClient,
    private readonly ngZone: NgZone,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngAfterViewInit(): void {
    const canvas  = this.boardCanvasRef.nativeElement;
    canvas.width  = this.COLS * this.CELL;
    canvas.height = this.ROWS * this.CELL;
    this.renderer = new TetrisCanvasRenderer(
      canvas.getContext('2d')!,
      this.CELL, this.ROWS, this.COLS,
      this.PIECE_COLORS, this.PIECE_IDS,
    );
    this.loadGame();
    this.initVisibility();
  }

  private initVisibility(): void {
    this.visibilityHandler = () => {
      if (document.hidden) {
        this.wasPlayingBeforeHide = this.isPlaying;
        if (this.isPlaying) this.pause();
      } else {
        if (this.wasPlayingBeforeHide) this.startPlay();
        this.wasPlayingBeforeHide = false;
      }
    };
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.anim.rafId);
    cancelAnimationFrame(this.anim.staggerRafId);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
  }

  // ── Timing helpers ─────────────────────────────────────────────────────────
  private get frameDuration(): number {
    return ANIM.SPEED_BASE_MS + (10 - this.speed) * ANIM.SPEED_FACTOR_MS;
  }
  private get candidateDuration(): number { return this.frameDuration * ANIM.CANDIDATE_PHASE_FRAC; }
  private get placedDuration():    number { return this.frameDuration * ANIM.PLACED_PHASE_FRAC; }

  // ── Controls ───────────────────────────────────────────────────────────────

  loadGame(): void {
    cancelAnimationFrame(this.anim.rafId);
    this.isPlaying = false;
    this.loading   = true;
    if (this.replay) {
      // Fade out existing stats, then load
      this.runInfoVisible = false;
      this.cdr.markForCheck();
      setTimeout(() => this.doLoad(), UI.LOAD_FADE_DELAY_MS);
    } else {
      this.doLoad();
    }
  }

  private doLoad(): void {
    this.replay = null;
    this.cdr.markForCheck();

    this.http.get<ReplayData>(`replays/web_replay_${this.selectedGame}.json`).pipe(
      takeUntilDestroyed(this.destroyRef),
    ).subscribe({
      next: data => {
        this.replay              = data;
        this.currentFrameIdx     = 0;
        this.phase               = 'candidates';
        this.anim.phaseElapsed   = 0;
        this.loading             = false;
        this.totalFrames         = data.frames.length;
        // Draw the board without ghosts so animateCandidates() sweeps them in
        this.renderer.drawBoard(data.frames[0].board_before);
        // Fade in new stats; also re-observe any @if reveal elements now in DOM
        this.cdr.markForCheck();
        setTimeout(() => {
          this.runInfoVisible = true;
          this.cdr.markForCheck();
          this.revealDir.observeAll();
          this.animateCandidates();
          this.startPlay();
        });
      },
      error: () => {
        this.loading = false;
        this.cdr.markForCheck();
      },
    });
  }

  togglePlay(): void {
    if (!this.replay) return;
    this.isPlaying ? this.pause() : this.startPlay();
  }

  onBoardClick(): void { this.togglePlay(); }

  onGhostToggle(): void { this.renderFrame(); }

  // ── Internal ───────────────────────────────────────────────────────────────

  private startPlay(): void {
    this.isPlaying   = true;
    this.anim.lastTs = 0;
    this.cdr.markForCheck();
    this.ngZone.runOutsideAngular(() => {
      this.anim.rafId = requestAnimationFrame(t => this.tick(t));
    });
  }

  private pause(): void {
    cancelAnimationFrame(this.anim.rafId);
    this.isPlaying = false;
    this.cdr.markForCheck();
  }

  private tick(ts: number): void {
    if (!this.isPlaying || !this.replay) return;
    if (this.anim.lastTs === 0) this.anim.lastTs = ts;

    const dt = ts - this.anim.lastTs;
    this.anim.lastTs = ts;
    this.anim.phaseElapsed += dt;

    const threshold = this.phase === 'candidates' ? this.candidateDuration : this.placedDuration;

    if (this.anim.phaseElapsed >= threshold) {
      this.anim.phaseElapsed -= threshold;

      if (this.phase === 'candidates') {
        this.phase = 'placed';
        this.animateTransition();
      } else {
        this.currentFrameIdx++;
        if (this.currentFrameIdx >= this.replay.frames.length) {
          this.currentFrameIdx = this.replay.frames.length - 1;
          this.ngZone.run(() => {
            this.isPlaying = false;
            this.cdr.markForCheck();
          });
          return;
        }
        this.phase = 'candidates';
        this.animateTransition();
        this.ngZone.run(() => { this.cdr.markForCheck(); });
      }
    }

    this.anim.rafId = requestAnimationFrame(t => this.tick(t));
  }

  /** Dispatches to the appropriate staggered animation for the current phase. */
  private animateTransition(): void {
    cancelAnimationFrame(this.anim.staggerRafId);
    if (this.phase === 'placed') {
      this.animatePlaced();
    } else {
      this.animateCandidates();
    }
  }

  /** Placed phase: cleared rows fade out while the stack above drifts down. */
  private animatePlaced(): void {
    if (!this.replay) return;
    const frame = this.replay.frames[this.currentFrameIdx];

    if (frame.lines_cleared_step === 0) { this.renderFrame(); return; }

    // Build intermediate board: board_before + chosen piece placed (before clearing)
    const pieceId        = this.PIECE_IDS[frame.piece];
    const chosen         = frame.candidates[frame.chosen_idx];
    const boardWithPiece = frame.board_before.map(row => [...row]);
    for (const [r, c] of chosen.cells) boardWithPiece[r][c] = pieceId;

    const clearedRows: number[] = [];
    for (let r = 0; r < this.ROWS; r++) {
      if (boardWithPiece[r].every(v => v !== 0)) clearedRows.push(r);
    }
    if (clearedRows.length === 0) { this.renderFrame(); return; }

    const C        = this.CELL;
    const duration = this.placedDuration;
    const start    = performance.now();

    const tick = (now: number) => {
      const t    = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 2); // ease-out quad

      this.renderer.clearBoard();

      // Non-cleared rows drift down into their final positions
      for (let r = 0; r < this.ROWS; r++) {
        if (clearedRows.includes(r)) continue;
        const shift = clearedRows.filter(cr => cr > r).length;
        const y     = r * C + shift * C * ease;
        for (let c = 0; c < this.COLS; c++) {
          const val = boardWithPiece[r][c];
          if (!val) continue;
          this.renderer.drawBlock(c * C, y, C, this.PIECE_COLORS[val] ?? CANVAS.FALLBACK_COLOR, 1);
        }
      }

      // Cleared rows fade out in place
      const fadeAlpha = 1 - ease;
      if (fadeAlpha > 0) {
        for (const r of clearedRows) {
          for (let c = 0; c < this.COLS; c++) {
            const val = boardWithPiece[r][c];
            if (!val) continue;
            this.renderer.drawBlock(c * C, r * C, C, this.PIECE_COLORS[val] ?? CANVAS.FALLBACK_COLOR, fadeAlpha);
          }
        }
      }

      if (t >= 1) return;
      this.anim.staggerRafId = requestAnimationFrame(tick);
    };
    this.anim.staggerRafId = requestAnimationFrame(tick);
  }

  /**
   * Candidates phase — two sub-phases:
   *   1. Sweep all ghost candidates in left→right over SWEEP_IN_FRAC of candidateDuration
   *   2. Fade out non-chosen candidates over FADE_OUT_FRAC, leaving only the chosen
   */
  private animateCandidates(): void {
    if (!this.replay) return;
    const frame = this.replay.frames[this.currentFrameIdx];
    const C     = this.CELL;

    this.renderer.drawBoard(frame.board_before);

    if (!this.showGhosts) return;

    const pieceId   = this.PIECE_IDS[frame.piece];
    const baseColor = this.PIECE_COLORS[pieceId] ?? CANVAS.FALLBACK_COLOR;
    const chosen    = frame.candidates[frame.chosen_idx];

    // Build per-column cell lists: non-chosen (deduped) + chosen
    const nonChosenSeen = new Set<string>();
    const byCol: { r: number; isChosen: boolean }[][] = Array.from({ length: this.COLS }, () => []);

    for (let i = 0; i < frame.candidates.length; i++) {
      if (i === frame.chosen_idx) continue;
      for (const [r, c] of frame.candidates[i].cells) {
        const key = `${r},${c}`;
        if (!nonChosenSeen.has(key)) {
          nonChosenSeen.add(key);
          byCol[c].push({ r, isChosen: false });
        }
      }
    }
    for (const [r, c] of chosen.cells) {
      byCol[c].push({ r, isChosen: true });
    }

    const totalDuration = this.candidateDuration;
    const start         = performance.now();

    const tick = (now: number) => {
      const tTotal = Math.min((now - start) / totalDuration, 1);

      this.renderer.drawBoard(frame.board_before);

      if (tTotal <= ANIM.SWEEP_IN_FRAC) {
        // Phase 1: sweep in left→right
        const tSweep      = tTotal / ANIM.SWEEP_IN_FRAC;
        const visibleCols = Math.floor(tSweep * this.COLS);
        for (let c = 0; c < visibleCols; c++) {
          for (const { r } of byCol[c]) {
            this.renderer.drawBlock(c * C, r * C, C, baseColor, ANIM.GHOST_BASE_ALPHA);
          }
        }
      } else {
        // Phase 2: fade out non-chosen, fade in chosen
        const tFade           = (tTotal - ANIM.SWEEP_IN_FRAC) / ANIM.FADE_OUT_FRAC;
        const nonAlpha        = (1 - tFade) * ANIM.GHOST_BASE_ALPHA;
        const chosenFillAlpha = ANIM.GHOST_CHOSEN_INIT_ALPHA + tFade * ANIM.GHOST_CHOSEN_DELTA_ALPHA;

        if (nonAlpha > 0) {
          for (let c = 0; c < this.COLS; c++) {
            for (const { r, isChosen } of byCol[c]) {
              if (!isChosen) {
                this.renderer.drawBlock(c * C, r * C, C, baseColor, nonAlpha);
              }
            }
          }
        }

        for (const [r, c] of chosen.cells) {
          this.renderer.drawBlock(c * C, r * C, C, baseColor, chosenFillAlpha);
        }
      }

      if (tTotal < 1) this.anim.staggerRafId = requestAnimationFrame(tick);
    };
    this.anim.staggerRafId = requestAnimationFrame(tick);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  renderFrame(): void {
    if (!this.replay) return;
    const frame = this.replay.frames[this.currentFrameIdx];
    const board = this.phase === 'placed' ? frame.board_after : frame.board_before;
    this.renderer.drawBoard(board);

    if (this.showGhosts && this.phase === 'candidates') {
      this.renderer.drawGhosts(frame);
    }
  }
}
