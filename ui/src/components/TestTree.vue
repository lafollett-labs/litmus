<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { BADGE, type Node, type Status } from '../model.ts'
import { openTrial, state, toggle, visible } from '../store.ts'
import StatusIcon from './StatusIcon.vue'

const CHIPS: Status[] = ['pass', 'fail', 'flaky', 'error', 'inconclusive']

type Row = { node: Node; level: number; size: number; pos: number; parent: string | null; open: boolean }

// A filter opens every branch it keeps.
const filtering = computed(() => state.filter.trim() !== '' || state.chips.size > 0)
const isOpen = (n: Node) => n.children.length > 0 && (filtering.value || state.expanded.has(n.id))

// The visible tree flattened into rows, each with what a flat ARIA tree needs
// to say where it sits.
const rows = computed(() => {
  const out: Row[] = []
  const walk = (siblings: Node[], level: number, parent: string | null) =>
    siblings.forEach((n, i) => {
      const open = isOpen(n)
      out.push({ node: n, level, size: siblings.length, pos: i + 1, parent, open })
      if (open) walk(n.children, level + 1, n.id)
    })
  walk(visible.value, 1, null)
  return out
})

// Roving tabindex: one row is the tree's tab stop, and the arrows move it.
const current = ref<string | null>(null)
const focusable = computed(() => (rows.value.some(r => r.node.id === current.value) ? current.value : (rows.value[0]?.node.id ?? null)))
const list = ref<HTMLElement | null>(null)
watch(focusable, id => (current.value = id))

function focus(id: string | undefined) {
  if (id === undefined) return
  current.value = id
  void nextTick(() => list.value?.querySelector<HTMLElement>(`li[data-id="${CSS.escape(id)}"]`)?.focus())
}

const activate = (n: Node) => (n.kind === 'trial' ? openTrial(n.id) : toggle(state.expanded, n.id))
const check = (n: Node) => n.selectable && toggle(state.checked, n.id)
const chip = (s: Status) => (state.chips.has(s) ? state.chips.delete(s) : state.chips.add(s))

function key(e: KeyboardEvent, r: Row) {
  const all = rows.value
  const i = all.indexOf(r)
  const go: Record<string, () => void> = {
    ArrowDown: () => focus(all[i + 1]?.node.id),
    ArrowUp: () => focus(all[i - 1]?.node.id),
    Home: () => focus(all[0]?.node.id),
    End: () => focus(all.at(-1)?.node.id),
    ArrowRight: () => {
      if (!r.node.children.length) return
      if (!r.open) state.expanded.add(r.node.id)
      else focus(all[i + 1]?.node.id)
    },
    ArrowLeft: () => {
      if (r.open && !filtering.value) state.expanded.delete(r.node.id)
      else focus(r.parent ?? undefined)
    },
    Enter: () => activate(r.node),
    ' ': () => check(r.node),
  }
  const act = go[e.key]
  if (!act) return
  e.preventDefault()
  act()
}
</script>

<template>
  <section class="tree" aria-label="Cases">
    <div class="filters">
      <input v-model="state.filter" type="search" placeholder="Filter cases" aria-label="Filter cases" />
      <button v-for="s in CHIPS" :key="s" class="chip" :class="{ on: state.chips.has(s) }" :aria-pressed="state.chips.has(s)" @click="chip(s)">
        <StatusIcon :status="s" decorative /> {{ s }}
      </button>
    </div>
    <!-- Space checks a row and Enter opens it; the checkbox is the mouse's way to the same aria-checked. The open trial is aria-current: aria-selected would mean checked in a multi-select tree. -->
    <ul ref="list" role="tree" class="rows" aria-label="Case tree" aria-multiselectable="true">
      <li
        v-for="r in rows"
        :key="r.node.id"
        role="treeitem"
        class="row"
        :class="[r.node.kind, { selected: state.detail?.key === r.node.id }]"
        :style="{ paddingLeft: `${8 + (r.level - 1) * 16}px` }"
        :tabindex="r.node.id === focusable ? 0 : -1"
        :aria-level="r.level"
        :aria-setsize="r.size"
        :aria-posinset="r.pos"
        :aria-expanded="r.node.children.length ? r.open : undefined"
        :aria-checked="r.node.selectable ? state.checked.has(r.node.id) : undefined"
        :aria-current="r.node.kind === 'trial' && state.detail?.key === r.node.id ? 'true' : undefined"
        :data-id="r.node.id"
        :data-status="r.node.status"
        @click="(current = r.node.id), activate(r.node)"
        @keydown="key($event, r)"
      >
        <span class="caret" aria-hidden="true">{{ r.node.children.length ? (r.open ? '▾' : '▸') : '' }}</span>
        <input type="checkbox" tabindex="-1" aria-hidden="true" :checked="state.checked.has(r.node.id)" :disabled="!r.node.selectable" :title="r.node.selectable ? undefined : 'beyond the case\'s own trial count: rerun it from its config row'" @click.stop @change="check(r.node)" />
        <StatusIcon :status="r.node.status" />
        <span class="label" :class="{ mono: r.node.kind !== 'suite' }">{{ r.node.label }}</span>
        <span v-if="!r.node.selectable" class="sr-only">, past the case's own trial count, so it cannot be checked</span>
        <span v-if="r.node.kind !== 'trial'" class="badge" :data-counts="r.node.id">
          <span class="sr-only">{{ BADGE.map(([k]) => `${r.node.counts[k]} ${k}`).join(', ') }}</span>
          <span v-for="[k, glyph] in BADGE" :key="k" aria-hidden="true" :class="[k, { zero: !r.node.counts[k] }]">{{ glyph }} {{ r.node.counts[k] }}</span>
        </span>
      </li>
      <li v-if="!rows.length" class="empty muted" role="none">No cases match.</li>
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
.row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.row.suite .label { font-weight: 600; }
.caret { width: 10px; color: var(--muted); font-size: 11px; }
.label { overflow: hidden; text-overflow: ellipsis; }
.badge { margin-left: auto; display: flex; gap: 7px; font-family: var(--mono); font-size: 11px; }
.badge .pass { color: var(--pass); }
.badge .fail { color: var(--fail); }
.badge .flaky { color: var(--flaky); }
.badge .error { color: var(--error); }
.badge .inconclusive { color: var(--unsure); }
.badge .zero { color: var(--muted); }
.empty { padding: 12px; }
</style>
