<script setup lang="ts">
import { computed, ref } from 'vue'
import { findingsOf, where } from '../findings.ts'
import { state } from '../store.ts'
import { tabKey } from '../tabs.ts'
import StatusIcon from './StatusIcon.vue'

type Tab = 'transcript' | 'graders' | 'findings' | 'usage' | 'artifacts'
const tab = ref<Tab>('transcript')

const data = computed(() => state.detail?.data ?? null)
const findings = computed(() => data.value?.record.graders.map(findingsOf).find(f => f !== undefined))
const start = computed(() => data.value?.transcript[0]?.t ?? 0)
const seconds = (t: number) => `${((t - start.value) / 1000).toFixed(1)}s`
const json = (v: unknown) => JSON.stringify(v, null, 2)
const money = (n: number | undefined) => (n === undefined ? 'unpriced' : `$${n.toFixed(4)}`)
const tabs = computed<Tab[]>(() => (findings.value ? ['transcript', 'graders', 'findings', 'usage', 'artifacts'] : ['transcript', 'graders', 'usage', 'artifacts']))
// A tab the open trial lacks (findings, on a trial with no review) shows its transcript.
const shown = computed<Tab>(() => (tabs.value.includes(tab.value) ? tab.value : 'transcript'))
</script>

<template>
  <section class="detail" aria-label="Trial">
    <p class="sr-only" role="status">{{ state.detail?.error ?? (state.detail?.waiting ? 'Running… its record appears here when it finishes.' : (state.detail?.note ?? '')) }}</p>
    <p v-if="!state.detail" class="muted hint">Open a trial (the <code>#n</code> rows) to see its transcript, graders, findings and usage.</p>
    <template v-else>
      <header>
        <StatusIcon :status="data?.record.status ?? 'queued'" />
        <h2 class="mono">{{ state.detail.key }}</h2>
        <span v-if="data" class="muted">{{ data.record.exit }}<template v-if="data.record.reason"> · {{ data.record.reason }}</template></span>
      </header>
      <p v-if="state.detail.error" class="error">{{ state.detail.error }}</p>
      <p v-else-if="state.detail.waiting" class="muted hint">Running… its record appears here when it finishes.</p>
      <p v-else-if="state.detail.note" class="muted hint">{{ state.detail.note }}</p>
      <p v-else-if="!data" class="muted hint">Loading…</p>
      <template v-else>
        <div role="tablist" aria-label="Trial views" class="tabs">
          <button
            v-for="t in tabs"
            :id="`tab-${t}`"
            :key="t"
            role="tab"
            :data-tab="t"
            :aria-selected="shown === t"
            aria-controls="trial-panel"
            :tabindex="shown === t ? 0 : -1"
            :class="{ on: shown === t }"
            @click="tab = t"
            @keydown="tabKey($event, tabs, shown, x => (tab = x))"
          >{{ t }}</button>
        </div>
        <div id="trial-panel" role="tabpanel" :aria-labelledby="`tab-${shown}`">

        <ol v-if="shown === 'transcript'" class="timeline">
          <li v-for="(e, i) in data.transcript" :key="i" :class="e.kind">
            <span class="time mono">{{ seconds(e.t) }}</span>
            <div class="entry">
              <template v-if="e.kind === 'message'">
                <span class="tag">{{ e.role }}</span>
                <pre>{{ e.text }}</pre>
              </template>
              <details v-else-if="e.kind === 'tool_call'">
                <summary><span class="tag">tool</span> <code>{{ e.tool }}</code></summary>
                <pre>{{ json(e.input) }}</pre>
              </details>
              <details v-else-if="e.kind === 'tool_result'" :open="e.is_error">
                <summary><span class="tag" :class="{ bad: e.is_error }">{{ e.is_error ? 'tool error' : 'result' }}</span></summary>
                <pre>{{ e.text }}</pre>
              </details>
              <template v-else-if="e.kind === 'denied'">
                <span class="tag bad">denied</span> <code>{{ e.tool }}</code> <span class="muted">{{ e.reason }}</span>
              </template>
              <template v-else-if="e.kind === 'usage'">
                <span class="tag">usage</span> <span class="muted mono">{{ e.usage.input_tokens }} in · {{ e.usage.output_tokens }} out</span>
              </template>
            </div>
          </li>
          <li v-if="data.transcript_truncated" class="muted">The transcript is too large to show here; it is in the run's directory.</li>
          <li v-else-if="!data.transcript.length" class="muted">No transcript.</li>
        </ol>

        <ul v-else-if="shown === 'graders'" class="graders">
          <li v-for="(g, i) in data.record.graders" :key="i">
            <header><StatusIcon :status="g.pass ? 'pass' : 'fail'" decorative /> <strong>{{ g.grader }}</strong> <span class="muted">{{ g.pass ? 'passed' : 'failed' }}</span></header>
            <pre v-if="g.rationale">{{ g.rationale }}</pre>
            <dl v-if="g.metrics" class="metrics">
              <template v-for="(v, k) in g.metrics" :key="k"><dt>{{ k }}</dt><dd class="mono">{{ v === null ? 'n/a' : Number.isInteger(v) ? v : v.toFixed(3) }}</dd></template>
            </dl>
          </li>
          <li v-if="!data.record.graders.length" class="muted">Not graded ({{ data.record.exit }}).</li>
        </ul>

        <div v-else-if="shown === 'findings' && findings" class="findings">
          <section><h3>Matched bugs <span class="n">{{ findings.matched.length }}</span></h3><ul><li v-for="m in findings.matched" :key="m.bug"><code>{{ m.bug }}</code> ← {{ where(m) }}</li></ul></section>
          <section><h3>Missed bugs <span class="n">{{ findings.missed.length }}</span></h3><ul><li v-for="m in findings.missed" :key="m"><code>{{ m }}</code></li></ul></section>
          <section><h3>False positives <span class="n">{{ findings.counts.falsePositives }}</span></h3><ul><li v-for="(f, i) in findings.falsePositives" :key="i">{{ where(f) }}</li></ul></section>
          <section><h3>Decoy hits <span class="n">{{ findings.counts.decoyHits }}</span></h3><ul><li v-for="(f, i) in findings.decoyHits" :key="i">{{ where(f) }} <span class="muted">(decoy {{ f.near }})</span></li></ul></section>
          <section><h3>Duplicates <span class="n">{{ findings.counts.duplicates }}</span></h3><ul><li v-for="(f, i) in findings.duplicates" :key="i">{{ where(f) }} <span class="muted">(again {{ f.near }})</span></li></ul></section>
          <section><h3>Nits <span class="n">{{ findings.counts.nits }}</span></h3><ul><li v-for="(f, i) in findings.nits" :key="i">{{ where(f) }}</li></ul></section>
          <p v-if="findings.omitted" class="muted">{{ findings.omitted }} more unmatched findings are counted but not listed.</p>
        </div>

        <dl v-else-if="shown === 'usage'" class="usage">
          <dt>subject tokens</dt><dd class="mono">{{ data.record.usage.input_tokens }} in · {{ data.record.usage.output_tokens }} out</dd>
          <dt>subject cost</dt><dd class="mono">{{ money(data.record.usage.cost_usd) }}</dd>
          <template v-if="data.record.grading_usage">
            <dt>grading tokens</dt><dd class="mono">{{ data.record.grading_usage.input_tokens }} in · {{ data.record.grading_usage.output_tokens }} out</dd>
            <dt>grading cost</dt><dd class="mono">{{ money(data.record.grading_usage.cost_usd) }}</dd>
          </template>
          <dt>time</dt><dd class="mono">{{ (data.record.wall_clock_ms / 1000).toFixed(2) }}s</dd>
          <dt>attempts</dt><dd class="mono">{{ data.record.attempts }}</dd>
          <dt>tool calls</dt><dd class="mono">{{ data.record.tool_calls }}</dd>
        </dl>

        <ul v-else-if="shown === 'artifacts'" class="artifacts">
          <li v-for="a in data.artifacts" :key="a.name">
            <details>
              <summary><code>{{ a.name }}</code> <span class="muted">{{ a.missing ? 'missing' : a.truncated ? `${a.size} bytes, too large to show` : a.binary ? `${a.size} bytes, binary` : `${a.size} bytes` }}</span></summary>
              <pre v-if="a.text !== undefined">{{ a.text }}</pre>
            </details>
          </li>
          <li v-if="!data.artifacts.length" class="muted">No artifacts.</li>
        </ul>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.detail { overflow: auto; padding: 12px 16px; min-height: 0; }
.hint { margin-top: 40px; text-align: center; }
header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
h2 { font-size: 14px; margin: 0; }
h3 { font-size: 12px; margin: 12px 0 4px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.n { font-family: var(--mono); margin-left: 4px; }
.tabs { display: flex; gap: 2px; margin: 12px 0 8px; border-bottom: 1px solid var(--line); }
.tabs button { border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: none; padding: 6px 10px; text-transform: capitalize; }
.tabs button.on { border-bottom-color: var(--accent); color: var(--accent); }
pre { white-space: pre-wrap; word-break: break-word; font-family: var(--mono); font-size: 12px; margin: 4px 0; background: var(--panel); padding: 6px 8px; border-radius: 4px; }
.timeline { list-style: none; margin: 0; padding: 0; border-left: 2px solid var(--line); margin-left: 44px; }
.timeline li { position: relative; padding: 4px 0 8px 14px; }
.timeline .time { position: absolute; left: -58px; top: 6px; width: 48px; text-align: right; color: var(--muted); font-size: 11px; }
.timeline li::before { content: ''; position: absolute; left: -6px; top: 9px; width: 10px; height: 10px; border-radius: 50%; background: var(--bg); border: 2px solid var(--line); }
.timeline li.tool_call::before { border-color: var(--accent); }
.timeline li.denied::before { border-color: var(--fail); }
.tag { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); }
.tag.bad { color: var(--fail); }
summary { cursor: pointer; }
.graders, .artifacts { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; }
.metrics, .usage { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 6px 0; }
dt { color: var(--muted); }
dd { margin: 0; }
.findings ul { margin: 0; padding-left: 18px; }
.error { color: var(--fail); }
</style>
