import { expect, test, type Page } from '@playwright/test'

// docs/PLAN.md M9: Playwright drives `litmus serve` over the fake suites
// through run all, run one, rerun failed, cancel, opening a trial, and compare.
// Tests run in order on one server, so each starts from the run before it:
// serial, so a failure skips the rest rather than failing them for its sake.
test.describe.configure({ mode: 'serial' })

const row = (page: Page, id: string) => page.locator(`li[data-id="${id}"]`)
// The mouse's way to check a row; the keyboard's is Space on the row.
const tick = (page: Page, id: string) => row(page, id).locator('input[type="checkbox"]').check()
const panel = (page: Page, tab: string) => page.getByRole('tabpanel', { name: tab })
const focused = (page: Page) => page.locator('li[role="treeitem"]:focus')
const done = (page: Page, state: string) => expect(page.locator('.runline')).toHaveAttribute('data-done', state, { timeout: 15_000 })
// Kept for the PR and the README: docs/images/ui-<name>.png is copied from here by hand.
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/screenshots/${name}.png` })

async function open(page: Page) {
  await page.goto('/')
  await expect(row(page, 'smoke')).toBeVisible()
}

async function expand(page: Page, ...ids: string[]) {
  for (const id of ids) {
    const r = row(page, id)
    if ((await r.getAttribute('aria-expanded')) !== 'true') await r.locator('.label').click()
  }
}

test('run all settles every case, and the tree shows each verdict and its counts', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Run all' }).click()
  await expect(row(page, 'slow')).toHaveAttribute('data-status', /running|queued/)
  await done(page, 'finished')
  await expand(page, 'smoke/passes', 'smoke/fails', 'smoke/flaky')
  await expect(row(page, 'smoke/passes@fake')).toHaveAttribute('data-status', 'pass')
  await expect(row(page, 'smoke/fails@fake')).toHaveAttribute('data-status', 'fail')
  await expect(row(page, 'smoke/flaky@fake')).toHaveAttribute('data-status', 'flaky')
  await expect(row(page, 'smoke')).toHaveAttribute('data-status', 'fail')
  await expect(page.locator('[data-counts="smoke"] > [aria-hidden]')).toHaveText(['✓ 1', '✗ 1', '~ 1', '! 0', '? 0'])
  // A screen reader hears the counts in the row's name.
  await expect(row(page, 'smoke')).toHaveAccessibleName(/1 pass, 1 fail, 1 flaky, 0 error, 0 inconclusive/)
  await expand(page, 'smoke/passes@fake')
  await expect(row(page, 'smoke/passes@fake#1')).toHaveAttribute('data-status', 'pass')
  await shot(page, 'run-all')
})

test('opening a trial shows its transcript, graders, and usage', async ({ page }) => {
  await open(page)
  await done(page, 'finished')
  await expand(page, 'smoke/passes', 'smoke/passes@fake')
  await row(page, 'smoke/passes@fake#1').click()
  await expect(page.locator('.detail h2')).toHaveText('smoke/passes@fake#1')
  await expect(panel(page, 'transcript').locator('li')).not.toHaveCount(0)
  await expect(panel(page, 'transcript')).toContainText('LGTM, ship it')
  await page.getByRole('tab', { name: 'graders' }).click()
  await expect(panel(page, 'graders')).toContainText('regex')
  await expect(panel(page, 'graders')).toContainText('passed')
  await page.getByRole('tab', { name: 'usage' }).click()
  await expect(panel(page, 'usage')).toContainText('120 in · 8 out')
  await expect(panel(page, 'usage')).toContainText('$0.0012')
  await shot(page, 'trial')
})

test('a review trial shows its findings against the ground truth', async ({ page }) => {
  await open(page)
  await done(page, 'finished')
  await expand(page, 'review', 'review/finds', 'review/finds@fake')
  await row(page, 'review/finds@fake#1').click()
  await page.getByRole('tab', { name: 'findings' }).click()
  const findings = panel(page, 'findings')
  await expect(findings).toContainText('Matched bugs 1')
  await expect(findings).toContainText('nil-token')
  await expect(findings).toContainText('Missed bugs 1')
  await expect(findings).toContainText('off-by-one')
  // A title is the subject's text: markup in it shows as text and never runs.
  await expect(findings).toContainText('slow loop <img src=x onerror=window.__x=1>')
  await expect(findings.locator('img')).toHaveCount(0)
  expect(await page.evaluate(() => (globalThis as { __x?: number }).__x)).toBeUndefined()
  await shot(page, 'findings')
})

test('run one: a checked case runs alone', async ({ page }) => {
  await open(page)
  await done(page, 'finished')
  const before = await page.locator('.runline').getAttribute('data-run')
  await tick(page, 'smoke/passes')
  await page.getByRole('button', { name: 'Run selected' }).click()
  await expect(page.locator('.runline')).not.toHaveAttribute('data-run', before!)
  await done(page, 'finished')
  await expand(page, 'smoke/passes', 'smoke/passes@fake')
  await expect(row(page, 'smoke/passes@fake#2')).toHaveAttribute('data-status', 'pass')
  // Cases this run did not touch keep their latest verdict and show no trials.
  await expand(page, 'smoke/fails')
  await expect(row(page, 'smoke/fails@fake')).toHaveAttribute('data-status', 'fail')
  await expect(row(page, 'smoke/fails@fake#1')).toHaveCount(0)
})

test('rerun failed runs only what failed in the run shown', async ({ page }) => {
  await open(page)
  await done(page, 'finished')
  await tick(page, 'smoke')
  await page.getByRole('button', { name: 'Run selected' }).click()
  await done(page, 'finished')
  const before = await page.locator('.runline').getAttribute('data-run')
  await page.getByRole('button', { name: 'Rerun failed' }).click()
  await expect(page.locator('.runline')).not.toHaveAttribute('data-run', before!)
  await done(page, 'finished')
  await expand(page, 'smoke/fails', 'smoke/fails@fake', 'smoke/passes', 'smoke/passes@fake')
  await expect(row(page, 'smoke/fails@fake#1')).toHaveAttribute('data-status', 'fail')
  await expect(row(page, 'smoke/passes@fake#1')).toHaveCount(0)
})

test('cancel stops a run: its trials end cancelled and nothing settles', async ({ page }) => {
  await open(page)
  await tick(page, 'slow')
  await page.getByRole('button', { name: 'Run selected' }).click()
  await done(page, 'running')
  // A trial opened while it runs says so in the header, not "queued".
  await expand(page, 'slow/waits', 'slow/waits@fake')
  await expect(row(page, 'slow/waits@fake#1')).toHaveAttribute('data-status', 'running')
  await row(page, 'slow/waits@fake#1').locator('.label').click()
  await expect(page.locator('.detail h2')).toHaveText('slow/waits@fake#1')
  await expect(page.locator('.detail header [role="img"]')).toHaveAttribute('aria-label', 'running')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await done(page, 'cancelled')
  // Cancel disabled itself; the focus it held lands on the run line, not the page.
  await expect(page.locator('.runline')).toBeFocused()
  await expand(page, 'slow/waits', 'slow/waits@fake')
  await expect(row(page, 'slow/waits@fake#1')).toHaveAttribute('data-status', 'cancelled')
})

test('compare: two configs in one run, with the grid, the comparison and its flips', async ({ page }) => {
  await open(page)
  await page.getByRole('group', { name: 'configs' }).getByLabel('fake-b').check()
  await tick(page, 'smoke')
  await page.getByRole('button', { name: 'Run selected' }).click()
  await done(page, 'finished')
  await page.getByRole('tab', { name: 'Compare' }).click()
  const card = page.locator('article.comparison').first()
  await expect(card).toContainText('fake → fake-b')
  await expect(card).toHaveAttribute('data-verdict', /INCONCLUSIVE|NO CHANGE/)
  await expect(page.locator('td[data-cell="smoke/fails@fake-b"]')).toContainText('FAIL')
  await expect(page.locator('td[data-cell="smoke/passes@fake"]')).toContainText('PASS')
  await shot(page, 'compare')
})

test('a page load leaves focus alone: the first Tab reaches Run all', async ({ page }) => {
  await open(page)
  await done(page, 'finished')
  await expect(page.locator('.runline')).not.toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Run all' })).toBeFocused()
})

test('the page keeps one main landmark, holding the view\'s tab panel', async ({ page }) => {
  await open(page)
  await expect(page.getByRole('main')).toHaveCount(1)
  await expect(page.getByRole('main').getByRole('tabpanel', { name: 'Runner' })).toBeVisible()
})

test('the dark theme applies and survives a reload', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: /switch to dark theme/ }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await done(page, 'finished')
  await expand(page, 'smoke/passes', 'smoke/passes@fake')
  await row(page, 'smoke/passes@fake#1').click()
  await expect(panel(page, 'transcript')).toContainText('LGTM, ship it')
  await shot(page, 'dark')
})

test('the tree works from the keyboard: arrows move, Right and Left open and close, Space checks, Enter opens a trial', async ({ page }) => {
  await open(page)
  await done(page, 'finished')
  const tree = page.getByRole('tree')
  await expect(tree.locator('li[tabindex="0"]')).toHaveCount(1)
  await row(page, 'smoke').focus()
  await expect(focused(page)).toHaveAttribute('aria-level', '1')
  await page.keyboard.press('ArrowRight') // open already: to the first case
  await expect(focused(page)).toHaveAttribute('aria-level', '2')
  await expect(focused(page)).toHaveAttribute('aria-posinset', '1')
  await page.keyboard.press('ArrowLeft') // a closed case: up to its suite
  await expect(focused(page)).toHaveAttribute('data-id', 'smoke')
  await page.keyboard.press('ArrowLeft') // an open suite: closes
  await expect(row(page, 'smoke')).toHaveAttribute('aria-expanded', 'false')
  await expect(row(page, 'smoke/passes')).toHaveCount(0)
  await page.keyboard.press('ArrowRight')
  await expect(row(page, 'smoke')).toHaveAttribute('aria-expanded', 'true')

  await row(page, 'smoke/passes').focus()
  await page.keyboard.press(' ')
  await expect(row(page, 'smoke/passes')).toHaveAttribute('aria-checked', 'true')
  await page.keyboard.press(' ')
  await expect(row(page, 'smoke/passes')).toHaveAttribute('aria-checked', 'false')

  await page.keyboard.press('Enter') // a case: opens it
  await expect(row(page, 'smoke/passes')).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(focused(page)).toHaveAttribute('data-id', 'smoke/passes@fake')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await expect(focused(page)).toHaveAttribute('data-id', /^smoke\/passes@fake#\d+$/)
  const trial = await focused(page).getAttribute('data-id')
  await page.keyboard.press('Enter')
  await expect(page.locator('.detail h2')).toHaveText(trial!)
  await expect(focused(page)).toHaveAttribute('aria-current', 'true')

  await page.keyboard.press('Home')
  await expect(focused(page)).toHaveAttribute('aria-posinset', '1')
  await expect(focused(page)).toHaveAttribute('aria-level', '1')
  await page.keyboard.press('End')
  await expect(focused(page)).toHaveAttribute('data-id', await tree.locator('li[role="treeitem"]').last().getAttribute('data-id') ?? '')
})

test('the trial tabs follow the arrow keys, and a tab the next trial lacks falls back to its transcript', async ({ page }) => {
  await open(page)
  await done(page, 'finished')
  // Its own run: a review trial and a plain one, side by side.
  const before = await page.locator('.runline').getAttribute('data-run')
  await tick(page, 'review')
  await tick(page, 'smoke/passes')
  await page.getByRole('button', { name: 'Run selected' }).click()
  await expect(page.locator('.runline')).not.toHaveAttribute('data-run', before!)
  await done(page, 'finished')
  await expand(page, 'review/finds', 'review/finds@fake')
  await row(page, 'review/finds@fake#1').click()
  await page.getByRole('tab', { name: 'findings' }).click()
  await expect(panel(page, 'findings')).toBeVisible()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('tab', { name: 'usage' })).toBeFocused()
  await expect(page.getByRole('tab', { name: 'usage' })).toHaveAttribute('aria-selected', 'true')
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('tab', { name: 'findings' })).toHaveAttribute('aria-selected', 'true')
  // A trial with no review has no findings tab: its transcript shows instead of nothing.
  await expand(page, 'smoke/passes', 'smoke/passes@fake')
  await row(page, 'smoke/passes@fake#1').click()
  await expect(page.getByRole('tab', { name: 'findings' })).toHaveCount(0)
  await expect(page.getByRole('tab', { name: 'transcript' })).toHaveAttribute('aria-selected', 'true')
  await expect(panel(page, 'transcript')).toBeVisible()
})

test('after a run with a larger trial count, a config row runs its case\'s own trials, and the extra trial cannot be checked', async ({ page }) => {
  await open(page)
  await done(page, 'finished')
  let before = await page.locator('.runline').getAttribute('data-run')
  await page.getByLabel('trials').fill('3')
  await tick(page, 'smoke/passes')
  await page.getByRole('button', { name: 'Run selected' }).click()
  await expect(page.locator('.runline')).not.toHaveAttribute('data-run', before!)
  await done(page, 'finished')
  await expand(page, 'smoke/passes', 'smoke/passes@fake')
  await expect(row(page, 'smoke/passes@fake#3')).toHaveAttribute('data-status', 'pass')
  await expect(row(page, 'smoke/passes@fake#3').locator('input[type="checkbox"]')).toBeDisabled()

  before = await page.locator('.runline').getAttribute('data-run')
  await page.getByLabel('trials').fill('')
  await row(page, 'smoke/passes').locator('input[type="checkbox"]').uncheck()
  await tick(page, 'smoke/passes@fake')
  await expect(page.locator('li[aria-checked="true"]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Run selected' }).click()
  await expect(page.locator('.runline')).not.toHaveAttribute('data-run', before!)
  await done(page, 'finished')
  await expect(page.locator('.banner')).toHaveCount(0)
  await expect(row(page, 'smoke/passes@fake#2')).toHaveAttribute('data-status', 'pass')
  await expect(row(page, 'smoke/passes@fake#3')).toHaveCount(0)
})

test('a refusal is announced through a live region that was there before it', async ({ page }) => {
  await open(page)
  await done(page, 'finished')
  const live = page.locator('[data-live="app"][role="status"]')
  await expect(live).toHaveCount(1) // there, and empty, before anything is said
  await expect(live).toHaveText('')
  await page.getByLabel('trials').fill('x')
  await tick(page, 'smoke/passes')
  await page.getByRole('button', { name: 'Run selected' }).click()
  await expect(live).toHaveText(/the trial count must be a whole number/)
  await page.getByLabel('trials').fill('')
})

test('in forced colours (High Contrast) the status shapes still show', async ({ page }) => {
  await page.emulateMedia({ forcedColors: 'active' })
  await open(page)
  // Run in the page; the test files have no DOM types.
  type Styled = { getComputedStyle: (e: unknown) => { backgroundColor: string } }
  const fill = (sel: string) => page.locator(sel).first().evaluate(el => (globalThis as unknown as Styled).getComputedStyle(el).backgroundColor)
  const canvas = await fill('body')
  for (const status of ['pass', 'fail']) expect(await fill(`.chip .icon.${status}`)).not.toBe(canvas)
  await page.emulateMedia({ forcedColors: 'none' })
})
