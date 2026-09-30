<script setup lang="ts">
import { computed } from 'vue'
import { BADGE, type Node, type Status } from '../model.ts'
import { openTrial, state, toggle, visible } from '../store.ts'
import StatusIcon from './StatusIcon.vue'

const CHIPS: Status[] = ['pass', 'fail', 'flaky', 'error', 'inconclusive']

// The visible tree flattened into rows; a filter opens every branch it keeps.
const rows = computed(() => {
  const out: { node: Node; depth: number }[] = []
  const open = (n: Node) => state.filter.trim() !== '' || state.chips.size > 0 || state.expanded.has(n.id)
  const walk = (n: Node, depth: number) => {
    out.push({ node: n, depth })
    if (open(n)) for (const c of n.children) walk(c, depth + 1)
  }
  visible.value.forEach(n => walk(n, 0))
  return out
})

const select = (n: Node) => (n.kind === 'trial' ? void openTrial(n.id) : toggle(state.expanded, n.id))
const chip = (s: Status) => (state.chips.has(s) ? state.chips.delete(s) : state.chips.add(s))
</script>

<template>
  <section class="tree" aria-label="Cases">
    <div class="filters">
      <input v-model="state.filter" type="search" placeholder="Filter cases" aria-label="Filter cases" />
      <button v-for="s in CHIPS" :key="s" class="chip" :class="{ on: state.chips.has(s) }" :aria-pressed="state.chips.has(s)" @click="chip(s)">
        <StatusIcon :status="s" /> {{ s }}
      </button>
    </div>
    <ul role="tree" class="rows">
      <li
        v-for="{ node, depth } in rows"
        :key="node.id"
        role="treeitem"
        class="row"
        :class="[node.kind, { selected: state.detail?.key === node.id }]"
        :style="{ paddingLeft: `${8 + depth * 16}px` }"
        :aria-expanded="node.children.length ? state.expanded.has(node.id) : undefined"
        :data-id="node.id"
        :data-status="node.status"
        @click="select(node)"
      >
        <span class="caret">{{ node.children.length ? (state.expanded.has(node.id) || state.filter || state.chips.size ? '▾' : '▸') : '' }}</span>
        <input type="checkbox" :checked="state.checked.has(node.id)" :aria-label="`select ${node.id}`" @click.stop @change="toggle(state.checked, node.id)" />
        <StatusIcon :status="node.status" />
        <span class="label" :class="{ mono: node.kind !== 'suite' }">{{ node.label }}</span>
        <span v-if="node.kind !== 'trial'" class="badge" :aria-label="`counts for ${node.id}`">
          <span v-for="[k, glyph] in BADGE" :key="k" :class="[k, { zero: !node.counts[k] }]">{{ glyph }} {{ node.counts[k] }}</span>
        </span>
      </li>
      <li v-if="!rows.length" class="empty muted">No cases match.</li>
    </ul>
  </section>
</template>

<style scoped>
.tree { display: flex; flex-direction: column; min-height: 0; }
.filters { display: flex; gap: 6px; padding: 8px; border-bottom: 1px solid var(--line); flex-wrap: wrap; align-items: center; }
.filters input { flex: 1 1 160px; }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: 2px 8px; border-radius: 12px; font-size: 12px; }
.chip.on { background: var(--selected); border-color: var(--accent); }
.rows { list-style: none; margin: 0; padding: 4px 0; overflow: auto; flex: 1; }
.row { display: flex; align-items: center; gap: 7px; height: 26px; padding-right: 8px; cursor: pointer; white-space: nowrap; }
.row:hover { background: var(--hover); }
.row.selected { background: var(--selected); }
.row.suite .label { font-weight: 600; }
.caret { width: 10px; color: var(--muted); font-size: 11px; }
.label { overflow: hidden; text-overflow: ellipsis; }
.badge { margin-left: auto; display: flex; gap: 7px; font-family: var(--mono); font-size: 11px; }
.badge .pass { color: var(--pass); }
.badge .fail { color: var(--fail); }
.badge .flaky { color: var(--flaky); }
.badge .error { color: var(--error); }
.badge .inconclusive { color: var(--unsure); }
.badge .zero { opacity: 0.35; }
.empty { padding: 12px; }
</style>
