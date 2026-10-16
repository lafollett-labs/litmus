<script setup lang="ts">
import type { Status } from '../model.ts'

// queued hollow, running a spinner, inconclusive outlined, cancelled struck
// through; pass a green circle, fail a red square, flaky an amber diamond,
// error a grey triangle, so the shape carries the status for anyone who cannot
// tell the colours apart (docs/ARCHITECTURE.md § UI). `decorative` when text
// beside it already says the status, so a screen reader hears it once.
defineProps<{ status: Status; decorative?: boolean }>()
</script>

<template>
  <span v-if="decorative" class="icon" :class="status" aria-hidden="true" :data-status="status">
    <svg v-if="status === 'running'" viewBox="0 0 16 16" class="spin"><circle cx="8" cy="8" r="6" /></svg>
  </span>
  <span v-else class="icon" :class="status" role="img" :aria-label="status" :title="status" :data-status="status">
    <svg v-if="status === 'running'" viewBox="0 0 16 16" class="spin"><circle cx="8" cy="8" r="6" /></svg>
  </span>
</template>

<style scoped>
.icon {
  display: inline-block;
  flex: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  position: relative;
  box-sizing: border-box;
}
.none { border: 1px dotted var(--muted); }
.queued { border: 1.5px solid var(--muted); }
.running { width: 14px; height: 14px; }
.spin { width: 100%; height: 100%; animation: spin 0.9s linear infinite; }
.spin circle { fill: none; stroke: var(--accent); stroke-width: 2.5; stroke-dasharray: 26 12; stroke-linecap: round; }
.pass { background: var(--pass); }
.fail { background: var(--fail); border-radius: 1px; width: 11px; height: 11px; }
.flaky { background: var(--flaky); border-radius: 1px; width: 9px; height: 9px; margin: 1.5px; transform: rotate(45deg); }
.error { background: var(--error); border-radius: 0; width: 13px; clip-path: polygon(50% 0, 100% 100%, 0 100%); }
.inconclusive { border: 2px solid var(--unsure); }
.cancelled { border: 1.5px solid var(--muted); }
.cancelled::after {
  content: '';
  position: absolute;
  left: -2px;
  right: -2px;
  top: 50%;
  border-top: 1.5px solid var(--muted);
  transform: rotate(-45deg);
}
/* High Contrast replaces backgrounds, which would erase the filled shapes. */
@media (forced-colors: active) { .pass, .fail, .flaky, .error { forced-color-adjust: none; } }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
