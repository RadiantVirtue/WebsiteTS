import { CANVAS, ANIM } from './replay.constants';

interface Frame {
  piece: string;
  candidates: { cells: [number, number][] }[];
  chosen_idx: number;
}

/** Pure canvas drawing utilities for the Tetris replay board. */
export class TetrisCanvasRenderer {
  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly cell: number,
    private readonly rows: number,
    private readonly cols: number,
    private readonly pieceColors: Record<number, string>,
    private readonly pieceIds: Record<string, number>,
  ) {}

  clearBoard(): void {
    const { ctx } = this;
    ctx.fillStyle = CANVAS.BG_COLOR;
    ctx.fillRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  }

  drawGrid(): void {
    const { ctx, cell, rows, cols } = this;
    ctx.strokeStyle = CANVAS.GRID_COLOR;
    ctx.lineWidth   = CANVAS.GRID_LINE_WIDTH;
    for (let r = 0; r <= rows; r++) {
      ctx.beginPath(); ctx.moveTo(0, r * cell); ctx.lineTo(ctx.canvas.width, r * cell); ctx.stroke();
    }
    for (let c = 0; c <= cols; c++) {
      ctx.beginPath(); ctx.moveTo(c * cell, 0); ctx.lineTo(c * cell, ctx.canvas.height); ctx.stroke();
    }
  }

  drawBlock(px: number, py: number, size: number, color: string, fillAlpha: number): void {
    this.ctx.fillStyle = this.withAlpha(color, fillAlpha);
    this.ctx.fillRect(px + 1, py + 1, size - 2, size - 2);
  }

  drawBoard(board: number[][]): void {
    const { cell, rows, cols } = this;
    this.clearBoard();
    this.ctx.stroke();
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const val = board[r][c];
        if (!val) continue;
        this.drawBlock(c * cell, r * cell, cell, this.pieceColors[val] ?? CANVAS.FALLBACK_COLOR, 1);
      }
    }
  }

  /**
   * Merges all candidate cells into one unified ghost overlay.
   * Non-chosen cells are drawn at low opacity; the chosen placement on top at higher opacity.
   */
  drawGhosts(frame: Frame): void {
    const { cell, rows, cols } = this;
    const pieceId   = this.pieceIds[frame.piece];
    const baseColor = this.pieceColors[pieceId] ?? CANVAS.FALLBACK_COLOR;
    const chosen    = frame.candidates[frame.chosen_idx];

    // Collect all non-chosen cells (deduplicated)
    const seen = Array.from({ length: rows }, () => new Uint8Array(cols));
    const allCells: [number, number][] = [];
    for (let i = 0; i < frame.candidates.length; i++) {
      if (i === frame.chosen_idx) continue;
      for (const [r, c] of frame.candidates[i].cells) {
        if (!seen[r][c]) { seen[r][c] = 1; allCells.push([r, c]); }
      }
    }

    for (const [r, c] of allCells) {
      this.drawBlock(c * cell, r * cell, cell, baseColor, ANIM.GHOST_BASE_ALPHA);
    }
    for (const [r, c] of chosen.cells) {
      this.drawBlock(c * cell, r * cell, cell, baseColor, ANIM.GHOST_CHOSEN_STATIC_ALPHA);
    }
  }

  /** Parse a CSS hex colour and return it with the given alpha. */
  withAlpha(hex: string, alpha: number): string {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
}
