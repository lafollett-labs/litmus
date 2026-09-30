<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { load, state } from './store.ts'
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

const failed = ref<string | null>(null)
onMounted(() => load().catch(e => (failed.value = (e as Error).message)))
</script>

<template>
  <div class="app">
    <header class="top">
      <h1>litmus</h1>
      <AppToolbar />
      <nav class="views" role="tablist" aria-label="View">
        <button role="tab" :aria-selected="state.view === 'tree'" :class="{ on: state.view === 'tree' }" @click="state.view = 'tree'">Runner</button>
        <button role="tab" :aria-selected="state.view === 'compare'" :class="{ on: state.view === 'compare' }" @click="state.view = 'compare'">Compare</button>
      </nav>
      <button class="theme" :aria-label="`switch to ${theme === 'dark' ? 'light' : 'dark'} theme`" @click="theme = theme === 'dark' ? 'light' : 'dark'">{{ theme === 'dark' ? '☀' : '☾' }}</button>
    </header>
    <p v-if="failed" class="banner error" role="alert">Could not reach litmus: {{ failed }}</p>
    <p v-if="state.message" class="banner" role="status">{{ state.message }}</p>
    <p v-if="state.run" class="runline muted" role="status" :data-run="state.run.id" :data-done="state.run.done">
      run <code>{{ state.run.id }}</code> · {{ state.run.done }}
    </p>
    <main v-if="state.view === 'tree'" class="split">
      <TestTree />
      <TrialDetail />
    </main>
    <main v-else class="single"><CompareView /></main>
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
