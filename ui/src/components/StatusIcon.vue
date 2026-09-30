<script setup lang="ts">
import type { Status } from '../model.ts'

// queued hollow, running a spinner, pass green, fail red, flaky amber, error
// grey, inconclusive outlined, cancelled struck through (docs/ARCHITECTURE.md § UI).
defineProps<{ status: Status }>()
</script>

<template>
  <span class="icon" :class="status" role="img" :aria-label="status" :title="status" :data-status="status">
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
.fail { background: var(--fail); }
.flaky { background: var(--flaky); }
.error { background: var(--error); }
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
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spin { animation-duration: 3s; } }
</style>
