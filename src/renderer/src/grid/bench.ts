import type { DataGrid } from './create-data-grid';

/** GRID-SPEC §11: underlying measureText calls per frame. */
export const MEASURE_BUDGET_PER_FRAME = 2000;

export interface BenchResult {
  readonly frames: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly dropped: number;
  readonly measureTextCalls: number;
  readonly measureTextMisses: number;
  readonly wallMs: number;
  /** Frames the paint loop actually completed per second. */
  readonly sustainedFps: number;
  readonly budgetP95Ms: number;
  readonly withinBudget: boolean;
  /** GRID-SPEC §11 caps underlying measureText calls at 2,000 per frame. */
  readonly missesPerFrame: number;
  readonly withinMeasureBudget: boolean;
}

export interface BenchOptions {
  readonly frames?: number;
  readonly rowsPerFrame?: number;
  readonly rowCount: number;
  /**
   * p95 budget for the *paint* work of one frame, which is what RenderLoop
   * measures. GRID-SPEC §11 sets that at 10ms, leaving ~6.6ms of a 16.6ms vsync
   * interval for compositing and input.
   */
  readonly budgetMs?: number;
}

function scrollPass(
  grid: DataGrid,
  span: number,
  frames: number,
  rowsPerFrame: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let index = 0;
    const step = (): void => {
      grid.scrollToRow(Math.min(span, index * rowsPerFrame), 'top');
      index += 1;
      if (index >= frames) resolve();
      else requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/**
 * Synthetic maximum-velocity scroll (GRID-SPEC §11).
 *
 * Perf is a feature that silently rots, so it is measured rather than eyeballed.
 *
 * Two things make the number trustworthy:
 *
 *  - **The warm-up pass.** Without it the measured frames paint skeleton
 *    placeholders for blocks that have not arrived yet, which is far cheaper
 *    than painting text and understates real cost. The span is sized to fit
 *    inside the block cache's LRU capacity so warm blocks are still resident.
 *  - **Running in isolation.** `sustainedFps` reflects rAF *delivery* rate, not
 *    paint cost, so it collapses under CPU contention: measured 24.2fps when
 *    launched straight after a test run versus 60.0fps on an idle machine, with
 *    near-identical paint timings. Always run `npm run bench` on its own. Gate
 *    on the p50/p95 paint figures and treat fps as corroboration.
 */
export async function runScrollBench(grid: DataGrid, options: BenchOptions): Promise<BenchResult> {
  const frames = Math.max(1, options.frames ?? 600);
  const rowsPerFrame = Math.max(1, options.rowsPerFrame ?? 40);
  const budgetMs = options.budgetMs ?? 10;
  const span = Math.max(1, options.rowCount - rowsPerFrame * frames);

  await scrollPass(grid, span, frames, rowsPerFrame);
  // Let the last prefetches land before measuring.
  await new Promise((resolve) => setTimeout(resolve, 400));

  grid.resetStats();
  const started = performance.now();
  await scrollPass(grid, span, frames, rowsPerFrame);
  const wallMs = performance.now() - started;

  const stats = grid.stats();
  const missesPerFrame = stats.frames > 0 ? stats.measureTextMisses / stats.frames : 0;

  return {
    ...stats,
    wallMs,
    sustainedFps: wallMs > 0 ? (stats.frames / wallMs) * 1000 : 0,
    budgetP95Ms: budgetMs,
    withinBudget: stats.p95 <= budgetMs,
    missesPerFrame,
    withinMeasureBudget: missesPerFrame <= MEASURE_BUDGET_PER_FRAME,
  };
}
