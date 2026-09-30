<script setup lang="ts">
import { cancel, rerun, runAll, running, runSelected, state } from '../store.ts'

const pick = (name: string, on: boolean) => {
  state.chosen = on ? [...state.chosen, name].filter((n, i, all) => all.indexOf(n) === i) : state.chosen.filter(n => n !== name)
}
</script>

<template>
  <div class="toolbar" role="toolbar" aria-label="Run">
    <button class="primary" :disabled="running || state.busy || !state.chosen.length" @click="runAll">Run all</button>
    <button :disabled="running || state.busy || !state.checked.size" @click="runSelected">Run selected</button>
    <span class="sep" />
    <button :disabled="running || state.busy || !state.run" @click="rerun(['FAIL'])">Rerun failed</button>
    <button :disabled="running || state.busy || !state.run" @click="rerun(['FLAKY'])">Rerun flaky</button>
    <button :disabled="running || state.busy || !state.run" @click="rerun(['ERROR'])">Rerun errored</button>
    <button :disabled="!running" @click="cancel">Cancel</button>
    <span class="sep" />
    <fieldset class="configs">
      <legend class="muted">configs</legend>
      <label v-for="name in state.configs" :key="name">
        <input type="checkbox" :checked="state.chosen.includes(name)" @change="pick(name, ($event.target as HTMLInputElement).checked)" />
        {{ name }}
      </label>
    </fieldset>
    <label class="trials">
      <span class="muted">trials</span>
      <input v-model="state.trials" inputmode="numeric" placeholder="case's own" aria-label="trials" size="8" />
    </label>
  </div>
</template>

<style scoped>
.toolbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.sep { width: 1px; height: 20px; background: var(--line); margin: 0 4px; }
.configs { display: flex; gap: 10px; align-items: center; border: 0; margin: 0; padding: 0; }
.configs legend { float: left; padding: 0 4px 0 0; }
.configs label, .trials { display: inline-flex; gap: 4px; align-items: center; }
</style>
