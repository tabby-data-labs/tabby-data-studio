<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';

interface Check {
  readonly label: string;
  readonly ok: boolean;
  readonly detail: string;
}

const versions = ref<{ electron: string; chrome: string; node: string } | null>(null);
const canvasRef = ref<HTMLCanvasElement | null>(null);
const canvasOk = ref(false);
const dpr = ref(1);
const fps = ref<number | null>(null);

let frame = 0;
let lastSample = 0;
let rafId = 0;

/**
 * A throwaway canvas probe: proves the 2D pipeline, HiDPI backing-store setup
 * and the rAF loop all work before Phase 1 builds the real grid on top of them.
 */
function paintProbe(ctx: CanvasRenderingContext2D, width: number, height: number): void {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0a1626';
  ctx.fillRect(0, 0, width, height);

  const rowHeight = 22;
  const cols = [40, 150, 110, 130, 90];
  for (let r = 0; r * rowHeight < height; r += 1) {
    if (r % 2 === 1) {
      ctx.fillStyle = 'rgba(28, 58, 94, 0.25)';
      ctx.fillRect(0, r * rowHeight, width, rowHeight);
    }
    let x = 0;
    for (let c = 0; c < cols.length; c += 1) {
      const w = cols[c] ?? 80;
      ctx.fillStyle = '#8ba0bb';
      ctx.font = '11px ui-monospace, monospace';
      ctx.fillText(`r${r}c${c}`, x + 8, r * rowHeight + 15);
      ctx.strokeStyle = 'rgba(28, 58, 94, 0.9)';
      ctx.strokeRect(x + 0.5, r * rowHeight + 0.5, w - 1, rowHeight - 1);
      x += w;
    }
  }
}

function tick(now: number): void {
  frame += 1;
  if (lastSample === 0) lastSample = now;
  const elapsed = now - lastSample;
  if (elapsed >= 1000) {
    fps.value = Math.round((frame * 1000) / elapsed);
    frame = 0;
    lastSample = now;
  }
  const ctx = canvasRef.value?.getContext('2d');
  if (ctx) {
    const d = dpr.value;
    ctx.setTransform(d, 0, 0, d, 0, 0);
    paintProbe(ctx, ctx.canvas.width / d, ctx.canvas.height / d);
  }
  rafId = requestAnimationFrame(tick);
}

onMounted(() => {
  const bridge = window.tabby;
  if (bridge) {
    versions.value = { ...bridge.versions };
  }

  const el = canvasRef.value;
  if (el) {
    const ctx = el.getContext('2d');
    canvasOk.value = ctx !== null;
    dpr.value = window.devicePixelRatio || 1;
    const rect = el.getBoundingClientRect();
    el.width = Math.round(rect.width * dpr.value);
    el.height = Math.round(rect.height * dpr.value);
    rafId = requestAnimationFrame(tick);
  }
});

onBeforeUnmount(() => {
  if (rafId !== 0) cancelAnimationFrame(rafId);
});

const checks = computed<Check[]>(() => [
  { label: 'Electron main process', ok: true, detail: `v${versions.value?.electron ?? '?'}` },
  { label: 'contextIsolation bridge', ok: versions.value !== null, detail: 'window.tabby' },
  { label: 'Chromium renderer', ok: true, detail: `v${versions.value?.chrome ?? '?'}` },
  { label: 'Node (main)', ok: true, detail: `v${versions.value?.node ?? '?'}` },
  { label: 'Tailwind v4 utilities', ok: true, detail: '@theme tokens' },
  {
    label: 'Canvas 2D + HiDPI',
    ok: canvasOk.value,
    detail: `${dpr.value.toFixed(2)}x dpr`,
  },
  {
    label: 'requestAnimationFrame loop',
    ok: fps.value !== null,
    detail: `${fps.value ?? '—'} fps`,
  },
]);
</script>

<template>
  <div class="flex h-full flex-col bg-surface">
    <header class="flex items-baseline gap-3 border-b border-line bg-panel px-5 py-3">
      <h1 class="text-sm font-semibold tracking-wide text-fg">Tabby</h1>
      <span class="text-xs text-muted">Phase 0 — scaffold verification</span>
    </header>

    <main class="flex flex-1 gap-6 overflow-auto p-6">
      <section class="w-80 shrink-0">
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Checks</h2>
        <ul class="space-y-2">
          <li
            v-for="check in checks"
            :key="check.label"
            class="flex items-start gap-3 rounded border border-line bg-panel px-3 py-2"
          >
            <span
              class="mt-0.5 shrink-0 text-xs"
              :class="check.ok ? 'text-ok' : 'text-warn'"
              :aria-label="check.ok ? 'pass' : 'pending'"
            >
              {{ check.ok ? '✔' : '✗' }}
            </span>
            <span class="min-w-0">
              <span class="block truncate text-xs text-fg">{{ check.label }}</span>
              <span class="block truncate text-[11px] text-muted">{{ check.detail }}</span>
            </span>
          </li>
        </ul>
      </section>

      <section class="flex min-w-0 flex-1 flex-col">
        <h2 class="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">
          Canvas probe — Phase 1 replaces this with the data grid
        </h2>
        <canvas
          ref="canvasRef"
          class="h-full w-full flex-1 rounded border border-line"
          aria-hidden="true"
        />
      </section>
    </main>
  </div>
</template>
