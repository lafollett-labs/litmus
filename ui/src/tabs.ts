// The WAI-ARIA tabs pattern's keys, with automatic activation: the arrows,
// Home and End pick a tab and move focus to it. Each tab carries data-tab.
export function tabKey<T extends string>(e: KeyboardEvent, tabs: readonly T[], current: T, pick: (t: T) => void): void {
  const i = tabs.indexOf(current)
  const next = { ArrowRight: tabs[(i + 1) % tabs.length], ArrowLeft: tabs[(i - 1 + tabs.length) % tabs.length], Home: tabs[0], End: tabs.at(-1) }[e.key]
  if (next === undefined) return
  e.preventDefault()
  pick(next)
  const list = (e.currentTarget as HTMLElement).closest('[role="tablist"]')
  queueMicrotask(() => list?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus())
}
