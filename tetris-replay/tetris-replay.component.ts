import {
  AfterViewInit,
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  Input,
  NgZone,
  OnDestroy,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpClientModule } from '@angular/common/http';

// ── Data interfaces ─────────────────────────────────────────────────────────

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

// ── Component ────────────────────────────────────────────────────────────────

/**
 * Replays pre-recorded DQN Tetris games.
 *
 * Place web_replay_1.json … web_replay_5.json in your Angular project's
 * src/assets/ folder (or override the [assetsPath] input).
 *
 * Provide HttpClient at the app level (provideHttpClient() in app.config.ts)
 * or keep the legacy HttpClientModule import below.
 */
@Component({
  selector: 'app-tetris-replay',
  standalone: true,
  imports: [CommonModule, FormsModule, HttpClientModule],
  templateUrl: './tetris-replay.component.html',
  styleUrls: ['./tetris-replay.component.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TetrisReplayComponent implements AfterViewInit, OnDestroy {
  /** Base URL/path for the web_replay_N.json files. */
  @Input() assetsPath = 'assets';

  @ViewChild('boardCanvas') boardCanvasRef!: ElementRef<HTMLCanvasElement>;
  @ViewChild('nextCanvas')  nextCanvasRef!:  ElementRef<HTMLCanvasElement>;

  // ── Layout constants ───────────────────────────────────────────────────────
  readonly CELL    = 28;
  readonly COLS    = 10;
  readonly ROWS    = 20;
  readonly BOARD_W = 10 * 28; // 280 px
  readonly BOARD_H = 20 * 28; // 560 px
  readonly NEXT_C  = 24;      // px per cell in next-piece preview

  // ── Piece data ─────────────────────────────────────────────────────────────
  /** Colour for each piece ID (1–7, matching metadata.piece_ids). */
  readonly PIECE_COLORS: Record<number, string> = {
    1: '#00d8d8', // I – cyan
    2: '#c8c800', // O – yellow
    3: '#9000d8', // T – purple
    4: '#00a800', // S – green
    5: '#c80000', // Z – red
    6: '#2828c8', // J – blue
    7: '#d87800', // L – orange
  };

  /** Canonical spawn shapes (row, col) in a 4×4 bounding box. */
  private readonly PIECE_SHAPES: Record<string, [number, number][]> = {
    I: [[1,0],[1,1],[1,2],[1,3]],
    O: [[0,1],[0,2],[1,1],[1,2]],
    T: [[0,1],[1,0],[1,1],[1,2]],
    S: [[0,1],[0,2],[1,0],[1,1]],
    Z: [[0,0],[0,1],[1,1],[1,2]],
    J: [[0,0],[1,0],[1,1],[1,2]],
    L: [[0,2],[1,0],[1,1],[1,2]],
  };

  private readonly PIECE_IDS: Record<string, number> = {
    I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7,
  };

  // ── Game-selector data ─────────────────────────────────────────────────────
  readonly games: { id: number; label: string }[] = [
    { id: 1, label: 'Game 1 — 1205 pieces · 466 lines' },
    { id: 2, label: 'Game 2 — 5405 pieces · 2147 lines' },
    { id: 3, label: 'Game 3 — 662 pieces · 250 lines' },
    { id: 4, label: 'Game 4 — 1887 pieces · 738 lines' },
    { id: 5, label: 'Game 5 — 299 pieces · 104 lines' },
  ];

  // ── Controls (template-bound) ──────────────────────────────────────────────
  selectedGame = 5;
  isPlaying    = false;
  speed        = 5;   // 1 (slow) – 10 (fast)
  showGhosts   = true;
  loading      = false;

  // ── Replay state ───────────────────────────────────────────────────────────
  replay: ReplayData | null = null;
  currentFrameIdx = 0;

  /**
   * 'candidates' — board_before + Q-value ghost overlays are drawn.
   * 'placed'     — board_after is drawn (result of chosen placement).
   */
  phase: 'candidates' | 'placed' = 'candidates';

  // ── Stats (template-bound) ────────────────────────────────────────────────
  currentPiece = '';
  nextPiece    = '';
  linesCleared = 0;
  score        = 0;
  totalFrames  = 0;
  totalLines   = 0;
  finalScore   = 0;

  // ── Private timing ─────────────────────────────────────────────────────────
  private rafId        = 0;
  private lastTs       = 0;
  private phaseElapsed = 0;

  constructor(
    private readonly http: HttpClient,
    private readonly ngZone: NgZone,
    private readonly cdr: ChangeDetectorRef,
  ) {}

  ngAfterViewInit(): void {
    const bc = this.boardCanvasRef.nativeElement;
    bc.width  = this.BOARD_W;
    bc.height = this.BOARD_H;

    const nc = this.nextCanvasRef.nativeElement;
    nc.width  = 4 * this.NEXT_C;
    nc.height = 3 * this.NEXT_C;

    this.loadGame();
  }

  ngOnDestroy(): void {
    cancelAnimationFrame(this.rafId);
  }

  // ── Timing helpers ─────────────────────────────────────────────────────────

  /** Total time allotted per frame (ms). speed 1 → 2000 ms, speed 10 → 200 ms. */
  private get frameDuration(): number {
    return 200 + (10 - this.speed) * 200;
  }

  /** Time spent showing candidate ghosts (65 % of frame). */
  private get candidateDuration(): number { return this.frameDuration * 0.65; }

  /** Time spent showing the placed result (35 % of frame). */
  private get placedDuration():    number { return this.frameDuration * 0.35; }

  // ── Public control handlers ────────────────────────────────────────────────

  loadGame(): void {
    cancelAnimationFrame(this.rafId);
    this.isPlaying = false;
    this.loading   = true;
    this.replay    = null;

    this.http
      .get<ReplayData>(`${this.assetsPath}/web_replay_${this.selectedGame}.json`)
      .subscribe({
        next: data => {
          this.replay          = data;
          this.currentFrameIdx = 0;
          this.phase           = 'candidates';
          this.phaseElapsed    = 0;
          this.loading         = false;
          this.totalFrames     = data.frames.length;
          this.totalLines      = data.metadata.total_lines;
          this.finalScore      = data.metadata.final_score;
          this.updateStats();
          this.renderFrame();
          this.cdr.markForCheck();
        },
        error: () => {
          this.loading = false;
          this.cdr.markForCheck();
        },
      });
  }

  togglePlay(): void {
    if (!this.replay) return;
    this.isPlaying = !this.isPlaying;

    if (this.isPlaying) {
      this.lastTs = 0;
      this.ngZone.runOutsideAngular(() => {
        this.rafId = requestAnimationFrame(t => this.tick(t));
      });
    } else {
      cancelAnimationFrame(this.rafId);
    }
  }

  stepForward(): void {
    if (!this.replay) return;
    this.pause();

    if (this.phase === 'candidates') {
      this.phase = 'placed';
    } else {
      this.currentFrameIdx = Math.min(
        this.currentFrameIdx + 1,
        this.replay.frames.length - 1,
      );
      this.phase = 'candidates';
      this.updateStats();
    }
    this.renderFrame();
    this.cdr.markForCheck();
  }

  stepBack(): void {
    if (!this.replay) return;
    this.pause();

    if (this.phase === 'placed') {
      this.phase = 'candidates';
    } else {
      this.currentFrameIdx = Math.max(0, this.currentFrameIdx - 1);
      this.phase = 'placed';
      this.updateStats();
    }
    this.renderFrame();
    this.cdr.markForCheck();
  }

  onScrub(event: Event): void {
    if (!this.replay) return;
    this.pause();
    this.currentFrameIdx = +(event.target as HTMLInputElement).value;
    this.phase           = 'candidates';
    this.phaseElapsed    = 0;
    this.updateStats();
    this.renderFrame();
    this.cdr.markForCheck();
  }

  /** Called from template when showGhosts checkbox changes. */
  onGhostToggle(): void {
    this.renderFrame();
  }

  // ── Animation loop ─────────────────────────────────────────────────────────

  private tick(ts: number): void {
    if (!this.isPlaying || !this.replay) return;
    if (this.lastTs === 0) this.lastTs = ts;

    const dt = ts - this.lastTs;
    this.lastTs = ts;
    this.phaseElapsed += dt;

    const threshold =
      this.phase === 'candidates' ? this.candidateDuration : this.placedDuration;

    if (this.phaseElapsed >= threshold) {
      this.phaseElapsed -= threshold;

      if (this.phase === 'candidates') {
        this.phase = 'placed';
        this.renderFrame();
      } else {
        this.currentFrameIdx++;
        if (this.currentFrameIdx >= this.replay.frames.length) {
          // Replay finished
          this.currentFrameIdx = this.replay.frames.length - 1;
          this.ngZone.run(() => {
            this.isPlaying = false;
            this.updateStats();
            this.cdr.markForCheck();
          });
          return;
        }
        this.phase = 'candidates';
        this.renderFrame();
        this.ngZone.run(() => {
          this.updateStats();
          this.cdr.markForCheck();
        });
      }
    }

    this.rafId = requestAnimationFrame(t => this.tick(t));
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private pause(): void {
    cancelAnimationFrame(this.rafId);
    this.isPlaying = false;
  }

  private updateStats(): void {
    if (!this.replay?.frames.length) return;
    const f          = this.replay.frames[this.currentFrameIdx];
    this.currentPiece = f.piece;
    this.nextPiece    = f.next_piece;
    this.linesCleared = f.lines_cleared_total;
    this.score        = Math.round(f.score * 10) / 10;
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  renderFrame(): void {
    if (!this.replay || !this.boardCanvasRef) return;

    const frame  = this.replay.frames[this.currentFrameIdx];
    const canvas = this.boardCanvasRef.nativeElement;
    const ctx    = canvas.getContext('2d')!;

    const board = this.phase === 'placed' ? frame.board_after : frame.board_before;
    this.drawBoard(ctx, board);
    this.drawGrid(ctx);

    if (this.showGhosts && this.phase === 'candidates') {
      this.drawCandidates(ctx, frame.candidates, frame.chosen_idx);
    }

    this.drawNextPiece(frame.next_piece);
  }

  private drawBoard(ctx: CanvasRenderingContext2D, board: number[][]): void {
    const C = this.CELL;

    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);

    for (let r = 0; r < this.ROWS; r++) {
      for (let c = 0; c < this.COLS; c++) {
        const val = board[r][c];
        if (!val) continue;

        const color = this.PIECE_COLORS[val] ?? '#888';
        ctx.fillStyle = color;
        ctx.fillRect(c * C + 1, r * C + 1, C - 2, C - 2);

        // Top-edge highlight for depth
        ctx.fillStyle = 'rgba(255,255,255,0.20)';
        ctx.fillRect(c * C + 2, r * C + 2, C - 4, 4);
      }
    }
  }

  private drawGrid(ctx: CanvasRenderingContext2D): void {
    const C = this.CELL;
    ctx.strokeStyle = 'rgba(255,255,255,0.045)';
    ctx.lineWidth   = 0.5;

    ctx.beginPath();
    for (let c = 0; c <= this.COLS; c++) {
      ctx.moveTo(c * C, 0);
      ctx.lineTo(c * C, this.ROWS * C);
    }
    for (let r = 0; r <= this.ROWS; r++) {
      ctx.moveTo(0, r * C);
      ctx.lineTo(this.COLS * C, r * C);
    }
    ctx.stroke();
  }

  private drawCandidates(
    ctx: CanvasRenderingContext2D,
    candidates: Candidate[],
    chosenIdx: number,
  ): void {
    const C = this.CELL;

    const qVals  = candidates.map(cd => cd.q_value);
    const qMin   = Math.min(...qVals);
    const qMax   = Math.max(...qVals);
    const qRange = Math.max(qMax - qMin, 1e-9);

    // Draw non-chosen candidates first so the chosen one renders on top
    const drawOrder = [
      ...candidates.map((_, i) => i).filter(i => i !== chosenIdx),
      chosenIdx,
    ];

    for (const i of drawOrder) {
      const cand     = candidates[i];
      const t        = (cand.q_value - qMin) / qRange; // 0 = worst, 1 = best
      const isChosen = i === chosenIdx;

      ctx.fillStyle   = this.qFill(t);
      ctx.strokeStyle = isChosen ? '#ffffff' : this.qStroke(t);
      ctx.lineWidth   = isChosen ? 2.5 : 1.5;

      for (const [row, col] of cand.cells) {
        ctx.fillRect(col * C + 1, row * C + 1, C - 2, C - 2);
        ctx.strokeRect(col * C + 1.5, row * C + 1.5, C - 3, C - 3);
      }

      // Label chosen candidate with a subtle marker
      if (isChosen) {
        const rows = cand.cells.map(([r]) => r);
        const cols = cand.cells.map(([, c]) => c);
        const topR = Math.min(...rows);
        const midC = (Math.min(...cols) + Math.max(...cols)) / 2;
        ctx.fillStyle = 'rgba(255,255,255,0.7)';
        ctx.font = 'bold 9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('✓', midC * C + C / 2, topR * C + 2);
      }
    }
    ctx.textAlign = 'left'; // reset
  }

  /** Semi-transparent fill colour interpolated red→green by t. */
  private qFill(t: number): string {
    const r = Math.round(200 * (1 - t));
    const g = Math.round(200 * t);
    return `rgba(${r},${g},40,0.28)`;
  }

  /** Opaque stroke colour interpolated red→green by t. */
  private qStroke(t: number): string {
    const r = Math.round(240 * (1 - t));
    const g = Math.round(200 * t + 55);
    return `rgba(${r},${g},50,0.88)`;
  }

  private drawNextPiece(pieceName: string): void {
    if (!this.nextCanvasRef) return;

    const canvas = this.nextCanvasRef.nativeElement;
    const ctx    = canvas.getContext('2d')!;
    const C      = this.NEXT_C;

    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const shape = this.PIECE_SHAPES[pieceName];
    const id    = this.PIECE_IDS[pieceName];
    if (!shape || !id) return;

    const color = this.PIECE_COLORS[id];
    ctx.fillStyle = color;
    for (const [r, c] of shape) {
      ctx.fillRect(c * C + 1, r * C + 1, C - 2, C - 2);
    }
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    for (const [r, c] of shape) {
      ctx.fillRect(c * C + 2, r * C + 2, C - 4, 4);
    }
  }
}
