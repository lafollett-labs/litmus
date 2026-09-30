<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import type { RunState } from './model.ts'
import { load, state, type View } from './store.ts'
import { tabKey } from './tabs.ts'
import AppToolbar from './components/AppToolbar.vue'
import CompareView from './components/CompareView.vue'
import TestTree from './components/TestTree.vue'
import TrialDetail from './components/TrialDetail.vue'

const saved = (() => {
  try {
    return localStorage.getItem('litmus.theme')
  } catch {
    return null
  }
})()
const theme = ref<'light' | 'dark'>(saved === 'dark' || saved === 'light' ? saved : matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
watch(
  theme,
  t => {
    document.documentElement.dataset['theme'] = t
    try {
      localStorage.setItem('litmus.theme', t)
    } catch {
      // private mode: the choice lasts until reload
    }
  },
  { immediate: true },
)

const VIEWS: [View, string][] = [['tree', 'Runner'], ['compare', 'Compare']]
const views = VIEWS.map(([v]) => v)
const DONE: Record<RunState['done'], string> = {
  running: 'running',
  finished: 'finished',
  cancelled: 'cancelled',
  failed: 'failed',
  elsewhere: 'running in another process (the CLI): shown as far as it had got; reload to see more',
  lost: 'lost touch with the server',
}
const failed = ref<string | null>(null)
onMounted(() => load().catch(e => (failed.value = (e as Error).message)))
</script>

<template>
  <div class="app">
    <header class="top">
      <h1>litmus</h1>
      <AppToolbar />
      <div class="views" role="tablist" aria-label="View">
        <button
          v-for="[v, label] in VIEWS"
          :id="`view-${v}`"
          :key="v"
          role="tab"
          :data-tab="v"
          :aria-selected="state.view === v"
          aria-controls="view"
          :tabindex="state.view === v ? 0 : -1"
          :class="{ on: state.view === v }"
          @click="state.view = v"
          @keydown="tabKey($event, views, state.view, t => (state.view = t))"
        >{{ label }}</button>
      </div>
      <button class="theme" :aria-label="`switch to ${theme === 'dark' ? 'light' : 'dark'} theme`" @click="theme = theme === 'dark' ? 'light' : 'dark'">{{ theme === 'dark' ? '☀' : '☾' }}</button>
    </header>
    <p v-if="failed" class="banner error" role="alert">Could not reach litmus: {{ failed }}</p>
    <p v-if="state.message" class="banner" role="status">{{ state.message }}</p>
    <p v-if="state.run" class="runline muted" role="status" :data-run="state.run.id" :data-done="state.run.done">
      run <code>{{ state.run.id }}</code> · {{ DONE[state.run.done] }}
    </p>
    <main id="view" role="tabpanel" :aria-labelledby="`view-${state.view}`" :class="state.view === 'tree' ? 'split' : 'single'">
      <template v-if="state.view === 'tree'">
        <TestTree />
        <TrialDetail />
      </template>
      <CompareView v-else />
    </main>
  </div>
</template>

<style scoped>
.app { display: flex; flex-direction: column; height: 100%; }
.top { display: flex; align-items: center; gap: 14px; padding: 8px 12px; border-bottom: 1px solid var(--line); background: var(--panel); flex-wrap: wrap; }
h1 { font-size: 15px; margin: 0; letter-spacing: 0.02em; }
.views { display: flex; gap: 2px; margin-left: auto; }
.views button.on { background: var(--selected); border-color: var(--accent); }
.theme { width: 32px; padding: 4px 0; }
.banner { margin: 0; padding: 6px 12px; border-bottom: 1px solid var(--line); background: var(--hover); }
.banner.error { color: var(--fail); }
.runline { margin: 0; padding: 4px 12px; border-bottom: 1px solid var(--line); font-size: 12px; }
.split { flex: 1; display: grid; grid-template-columns: minmax(340px, 42%) 1fr; min-height: 0; }
.split > :first-child { border-right: 1px solid var(--line); }
.single { flex: 1; min-height: 0; display: flex; }
.single > * { flex: 1; }
</style>
