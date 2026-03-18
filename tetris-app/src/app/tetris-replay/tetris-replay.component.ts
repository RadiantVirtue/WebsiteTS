import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  DestroyRef,
  ElementRef,
  NgZone,
  OnDestroy,
  ViewChild,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { HttpClient } from '@angular/common/http';
import { RouterLink } from '@angular/router';

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
  imports: [FormsModule, RouterLink],
  templateUrl: './tetris-replay.component.html',
  styleUrls: ['./tetris-replay.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TetrisReplayComponent implements AfterViewInit, OnDestroy {
  @ViewChild('boardCanvas') boardCanvasRef!: ElementRef<HTMLCanvasElement>;

  // ── Layout ─────────────────────────────────────────────────────────────────
  readonly CELL    = 28;
  readonly COLS    = 10;
  readonly ROWS    = 20;
  readonly BOARD_W = 10 * 28;
  readonly BOARD_H = 20 * 28;

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
  selectedGame = 5;
  isPlaying    = false;
  speed        = 5;
  showGhosts   = true;
  loading      = false;
  runInfoVisible = false;

  // ── Replay state ───────────────────────────────────────────────────────────
  replay: ReplayData | null = null;
  currentFrameIdx = 0;
  phase: 'candidates' | 'placed' = 'candidates';

  // ── Stats ──────────────────────────────────────────────────────────────────
  totalFrames = 0;

  // ── Timing ────────────────────────────────────────────────────────────────
  private rafId        = 0;
  private lastTs       = 0;
  private phaseElapsed = 0;
  private staggerRafId = 0;

  // ── Visibility ────────────────────────────────────────────────────────────
  private wasPlayingBeforeHide = false;
  private visibilityHandler!: () => void;

  private readonly el = inject(ElementRef);
  private readonly destroyRef = inject(DestroyRef);

  constructor(
    private readonly http: HttpClient,
    private readonly ngZone: NgZone,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngAfterViewInit(): void {
    const bc = this.boardCanvasRef.nativeElement;
    bc.width  = this.BOARD_W;
    bc.height = this.BOARD_H;
    this.loadGame();
    this.initScrollReveal();
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

  private initScrollReveal(): void {
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    }, { threshold: 0.08 });

    this.el.nativeElement
      .querySelectorAll('.reveal')
      .forEach((el: Element) => observer.observe(el));
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
    cancelAnimationFrame(this.staggerRafId);
    document.removeEventListener('visibilitychange', this.visibilityHandler);
  }

  // ── Timing helpers ─────────────────────────────────────────────────────────
  private get frameDuration(): number {
    return 200 + (10 - this.speed) * 200;
  }
  private get candidateDuration(): number { return this.frameDuration * 0.65; }
  private get placedDuration():    number { return this.frameDuration * 0.35; }

  // ── Controls ───────────────────────────────────────────────────────────────

  loadGame(): void {
    cancelAnimationFrame(this.rafId);
    this.isPlaying = false;
    this.loading   = true;
    if (this.replay) {
      // Fade out existing stats, then load
      this.runInfoVisible = false;
      this.cdr.markForCheck();
      setTimeout(() => this.doLoad(), 650);
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
        this.replay          = data;
        this.currentFrameIdx = 0;
        this.phase           = 'candidates';
        this.phaseElapsed    = 0;
        this.loading         = false;
        this.totalFrames = data.frames.length;
        // Draw the board without ghosts so animateCandidates() sweeps them in
        const canvas = this.boardCanvasRef.nativeElement;
        const ctx    = canvas.getContext('2d')!;
        this.drawBoard(ctx, data.frames[0].board_before);
            // Fade in new stats; also re-observe any *ngIf reveal elements now in DOM
        this.cdr.markForCheck();
        setTimeout(() => {
          this.runInfoVisible = true;
          this.cdr.markForCheck();
          this.initScrollReveal();
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

  onBoardClick(): void {
    this.togglePlay();
  }

  onGhostToggle(): void {
    this.renderFrame();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private startPlay(): void {
    this.isPlaying = true;
    this.lastTs    = 0;
    this.cdr.markForCheck();
    this.ngZone.runOutsideAngular(() => {
      this.rafId = requestAnimationFrame(t => this.tick(t));
    });
  }

  private pause(): void {
    cancelAnimationFrame(this.rafId);
    this.isPlaying = false;
    this.cdr.markForCheck();
  }

  private tick(ts: number): void {
    if (!this.isPlaying || !this.replay) return;
    if (this.lastTs === 0) this.lastTs = ts;

    const dt = ts - this.lastTs;
    this.lastTs = ts;
    this.phaseElapsed += dt;

    const threshold = this.phase === 'candidates' ? this.candidateDuration : this.placedDuration;

    if (this.phaseElapsed >= threshold) {
      this.phaseElapsed -= threshold;

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

    this.rafId = requestAnimationFrame(t => this.tick(t));
  }


  /** Dispatches to the appropriate staggered animation for the current phase. */
  private animateTransition(): void {
    cancelAnimationFrame(this.staggerRafId);
    if (this.phase === 'placed') {
      this.animatePlaced();
    } else {
      this.animateCandidates();
    }
  }

  /** Placed phase: cleared rows fade out while the stack above drifts down. */
  private animatePlaced(): void {
    if (!this.replay || !this.boardCanvasRef) return;
    const frame = this.replay.frames[this.currentFrameIdx];

    if (frame.lines_cleared_step === 0) {
      this.renderFrame();
      return;
    }

    // Build intermediate board: board_before + chosen piece placed (before clearing)
    const pieceId       = this.PIECE_IDS[frame.piece];
    const chosen        = frame.candidates[frame.chosen_idx];
    const boardWithPiece = frame.board_before.map(row => [...row]);
    for (const [r, c] of chosen.cells) boardWithPiece[r][c] = pieceId;

    const clearedRows: number[] = [];
    for (let r = 0; r < this.ROWS; r++) {
      if (boardWithPiece[r].every(v => v !== 0)) clearedRows.push(r);
    }
    if (clearedRows.length === 0) { this.renderFrame(); return; }

    const canvas   = this.boardCanvasRef.nativeElement;
    const ctx      = canvas.getContext('2d')!;
    const C        = this.CELL;
    const duration = this.placedDuration;
    const start    = performance.now();

    const tick = (now: number) => {
      const t    = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - t, 2); // ease-out quad

      ctx.fillStyle = '#0d0d0d';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      this.drawGrid(ctx);

      // Non-cleared rows drift down into their final positions
      for (let r = 0; r < this.ROWS; r++) {
        if (clearedRows.includes(r)) continue;
        const shift = clearedRows.filter(cr => cr > r).length;
        const y     = r * C + shift * C * ease;
        for (let c = 0; c < this.COLS; c++) {
          const val = boardWithPiece[r][c];
          if (!val) continue;
          this.drawBlock(ctx, c * C, y, C, this.PIECE_COLORS[val] ?? '#888', 1);
        }
      }

      // Cleared rows fade out in place
      const fadeAlpha = 1 - ease;
      if (fadeAlpha > 0) {
        for (const r of clearedRows) {
          for (let c = 0; c < this.COLS; c++) {
            const val = boardWithPiece[r][c];
            if (!val) continue;
            this.drawBlock(ctx, c * C, r * C, C, this.PIECE_COLORS[val] ?? '#888', fadeAlpha);
          }
        }
      }

  
      if (t >= 1) return;
      this.staggerRafId = requestAnimationFrame(tick);
    };
    this.staggerRafId = requestAnimationFrame(tick);
  }

  /**
   * Candidates phase — two sub-phases:
   *   1. Sweep all ghost candidates in left→right over ~65% of candidateDuration
   *   2. Fade out non-chosen candidates over remaining ~35%, leaving only the chosen
   */
  private animateCandidates(): void {
    if (!this.replay || !this.boardCanvasRef) return;
    const frame   = this.replay.frames[this.currentFrameIdx];
    const canvas  = this.boardCanvasRef.nativeElement;
    const ctx     = canvas.getContext('2d')!;
    const C       = this.CELL;

    this.drawBoard(ctx, frame.board_before);

    if (!this.showGhosts) return;

    const pieceId   = this.PIECE_IDS[frame.piece];
    const baseColor = this.PIECE_COLORS[pieceId] ?? '#888';
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
    const sweepFrac     = 0.65; // first 65% = sweep in
    const fadeFrac      = 0.35; // last 35%  = fade out non-chosen
    const start         = performance.now();

    const tick = (now: number) => {
      const elapsed = now - start;
      const tTotal  = Math.min(elapsed / totalDuration, 1);

      this.drawBoard(ctx, frame.board_before);
  
      if (tTotal <= sweepFrac) {
        // ── Phase 1: sweep in ────────────────────────────────────────────
        const tSweep      = tTotal / sweepFrac;
        const visibleCols = Math.floor(tSweep * this.COLS);

        for (let c = 0; c < visibleCols; c++) {
          for (const { r } of byCol[c]) {
            this.drawBlock(ctx, c * C, r * C, C, baseColor, 0.20);
          }
        }
      } else {
        // ── Phase 2: fade out non-chosen, fade in chosen ──────────────────
        const tFade           = (tTotal - sweepFrac) / fadeFrac;
        const nonAlpha        = (1 - tFade) * 0.20;    // 0.20 → 0
        const chosenFillAlpha = 0.20 + tFade * 0.65;   // 0.20 → 0.85

        // Non-chosen: fade out
        if (nonAlpha > 0) {
          for (let c = 0; c < this.COLS; c++) {
            for (const { r, isChosen } of byCol[c]) {
              if (!isChosen) {
                this.drawBlock(ctx, c * C, r * C, C, baseColor, nonAlpha);
              }
            }
          }
        }

        // Chosen: fade in
        for (const [r, c] of chosen.cells) {
          this.drawBlock(ctx, c * C, r * C, C, baseColor, chosenFillAlpha);
        }
      }

      if (tTotal < 1) this.staggerRafId = requestAnimationFrame(tick);
    };
    this.staggerRafId = requestAnimationFrame(tick);
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  renderFrame(): void {
    if (!this.replay || !this.boardCanvasRef) return;
    const frame  = this.replay.frames[this.currentFrameIdx];
    const canvas = this.boardCanvasRef.nativeElement;
    const ctx    = canvas.getContext('2d')!;

    const board = this.phase === 'placed' ? frame.board_after : frame.board_before;
    this.drawBoard(ctx, board);

    if (this.showGhosts && this.phase === 'candidates') {
      this.drawGhosts(ctx, frame);
    }
  }

  private drawBoard(ctx: CanvasRenderingContext2D, board: number[][]): void {
    const C = this.CELL;
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    this.drawGrid(ctx);

    for (let r = 0; r < this.ROWS; r++) {
      for (let c = 0; c < this.COLS; c++) {
        const val = board[r][c];
        if (!val) continue;
        this.drawBlock(ctx, c * C, r * C, C, this.PIECE_COLORS[val] ?? '#888', 1);
      }
    }
  }

  /**
   * Merges all candidate cells into one unified ghost in the current piece's
   * colour. The chosen placement is drawn on top at higher opacity.
   */
  private drawGhosts(ctx: CanvasRenderingContext2D, frame: Frame): void {
    const C         = this.CELL;
    const pieceId   = this.PIECE_IDS[frame.piece];
    const baseColor = this.PIECE_COLORS[pieceId] ?? '#888';
    const chosen    = frame.candidates[frame.chosen_idx];

    // Collect all non-chosen cells (deduplicated)
    const seen = Array.from({ length: this.ROWS }, () => new Uint8Array(this.COLS));
    const allCells: [number, number][] = [];
    for (let i = 0; i < frame.candidates.length; i++) {
      if (i === frame.chosen_idx) continue;
      for (const [r, c] of frame.candidates[i].cells) {
        if (!seen[r][c]) { seen[r][c] = 1; allCells.push([r, c]); }
      }
    }

    // Draw merged ghost (low opacity)
    for (const [r, c] of allCells) {
      this.drawBlock(ctx, c * C, r * C, C, baseColor, 0.20);
    }

    // Draw chosen placement on top (higher opacity)
    for (const [r, c] of chosen.cells) {
      this.drawBlock(ctx, c * C, r * C, C, baseColor, 0.45);
    }
  }

  /** Draw subtle grid lines as a guide. Call after clearing the background. */
  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const C = this.CELL;
    ctx.strokeStyle = '#333333';
    ctx.lineWidth   = 0.5;
    for (let r = 0; r <= this.ROWS; r++) {
      ctx.beginPath(); ctx.moveTo(0, r * C); ctx.lineTo(ctx.canvas.width, r * C); ctx.stroke();
    }
    for (let c = 0; c <= this.COLS; c++) {
      ctx.beginPath(); ctx.moveTo(c * C, 0); ctx.lineTo(c * C, ctx.canvas.height); ctx.stroke();
    }
  }

  /** Draw a single matte block at grid position (px, py). */
  private drawBlock(
    ctx: CanvasRenderingContext2D,
    px: number, py: number, size: number,
    color: string, fillAlpha: number
  ): void {
    ctx.fillStyle = this.withAlpha(color, fillAlpha);
    ctx.fillRect(px + 1, py + 1, size - 2, size - 2);
  }

  /** Parse a CSS hex/rgb colour and return it with the given alpha. */
  private withAlpha(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
}
