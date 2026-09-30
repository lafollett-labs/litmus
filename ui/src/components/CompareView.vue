<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Comparison } from '../../../src/core/types.ts'
import { api } from '../api.ts'
import { VERDICT_STATUS } from '../model.ts'
import { state } from '../store.ts'
import StatusIcon from './StatusIcon.vue'

// The shown run's cases × configs, its own comparisons on top, and any two
// sides compared on demand (the addressing forms of docs/ARCHITECTURE.md).
const verdicts = computed(() => Object.values(state.run?.verdicts ?? {}))
const cases = computed(() => [...new Set(verdicts.value.map(v => v.case))].sort())
const configs = computed(() => [...new Set(verdicts.value.map(v => v.config))].sort())
const cell = (c: string, cfg: string) => state.run?.verdicts[`${c}@${cfg}`]

const a = ref('')
const b = ref('')
const adhoc = ref<Comparison | null>(null)
const problem = ref<string | null>(null)
async function compare() {
  problem.value = null
  adhoc.value = null
  try {
    adhoc.value = await api.compare(a.value.trim(), b.value.trim())
  } catch (e) {
    problem.value = (e as Error).message
  }
}
const shown = computed(() => [...state.comparisons, ...(adhoc.value ? [adhoc.value] : [])])
const signed = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(2)}`
const tone = (c: Comparison) => ({ REGRESSION: 'fail', IMPROVEMENT: 'pass', 'NO CHANGE': 'none', INCONCLUSIVE: 'inconclusive' })[c.verdict]
</script>

<template>
  <section class="compare" aria-label="Compare">
    <form class="sides" @submit.prevent="compare">
      <input v-model="a" placeholder="baseline:main, <run id>[:config], config:<name>" aria-label="side A" />
      <span class="muted">→</span>
      <input v-model="b" placeholder="side B" aria-label="side B" />
      <button type="submit" :disabled="!a.trim() || !b.trim()">Compare</button>
      <span v-if="problem" class="error">{{ problem }}</span>
    </form>

    <article v-for="(c, i) in shown" :key="`${c.a}→${c.b}${i < state.comparisons.length ? '' : ' (asked)'}`" class="comparison" :data-verdict="c.verdict">
      <header>
        <strong class="mono">{{ c.a }} → {{ c.b }}</strong>
        <span class="verdict" :class="tone(c)">{{ c.verdict }}</span>
        <span v-if="c.delta !== null && c.interval" class="mono muted">Δ {{ signed(c.delta) }} [{{ signed(c.interval.lo) }}, {{ signed(c.interval.hi) }}] over {{ c.cases }} case{{ c.cases === 1 ? '' : 's' }}</span>
      </header>
      <ul class="flips" aria-label="Flips">
        <li v-for="f in c.flips" :key="f.case"><code>{{ f.case }}</code> <StatusIcon :status="VERDICT_STATUS[f.from]" /> {{ f.from }} → <StatusIcon :status="VERDICT_STATUS[f.to]" /> {{ f.to }}</li>
        <li v-if="!c.flips.length" class="muted">No flips.</li>
      </ul>
      <ul v-if="c.warns.length" class="warns">
        <li v-for="w in c.warns" :key="w.metric">WARN <code>{{ w.metric }}</code> {{ w.a }} → {{ w.b }} (×{{ w.ratio.toFixed(2) }})</li>
      </ul>
      <details v-if="c.excluded.length || c.notes.length">
        <summary class="muted">{{ c.excluded.length }} excluded · {{ c.notes.length }} notes</summary>
        <ul><li v-for="e in c.excluded" :key="e.case"><code>{{ e.case }}</code>: {{ e.reason }}</li><li v-for="n in c.notes" :key="n">{{ n }}</li></ul>
      </details>
    </article>

    <table v-if="cases.length" class="grid" aria-label="Verdicts by case and config">
      <thead><tr><th>case</th><th v-for="cfg in configs" :key="cfg" class="mono">{{ cfg }}</th></tr></thead>
      <tbody>
        <tr v-for="c in cases" :key="c">
          <th class="mono">{{ c }}</th>
          <td v-for="cfg in configs" :key="cfg" :data-cell="`${c}@${cfg}`">
            <template v-if="cell(c, cfg)"><StatusIcon :status="VERDICT_STATUS[cell(c, cfg)!.verdict]" /> {{ cell(c, cfg)!.verdict }}</template>
            <span v-else class="muted">—</span>
          </td>
        </tr>
      </tbody>
    </table>
    <p v-else class="muted">Run something to fill the grid.</p>
  </section>
</template>

<style scoped>
.compare { padding: 12px 16px; overflow: auto; display: grid; gap: 14px; align-content: start; }
.sides { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.sides input { flex: 1 1 220px; }
.comparison { border: 1px solid var(--line); border-radius: 6px; padding: 10px 12px; background: var(--panel); }
.comparison header { display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap; }
.verdict { font-weight: 600; }
.verdict.fail { color: var(--fail); }
.verdict.pass { color: var(--pass); }
.verdict.inconclusive { color: var(--unsure); }
.flips, .warns { list-style: none; padding: 0; margin: 8px 0 0; display: grid; gap: 3px; }
.flips li { display: flex; align-items: center; gap: 6px; }
.warns { color: var(--flaky); }
.grid { border-collapse: collapse; width: max-content; }
.grid th, .grid td { border: 1px solid var(--line); padding: 4px 10px; text-align: left; }
.grid td { white-space: nowrap; }
.grid thead th { background: var(--panel); }
.error { color: var(--fail); }
</style>
