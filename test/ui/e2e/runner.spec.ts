import { expect, test, type Page } from '@playwright/test'

// docs/PLAN.md M9: Playwright drives `litmus serve` over the fake suites
// through run all, run one, rerun failed, cancel, opening a trial, and compare.
// Tests run in order on one server, so each starts from the run before it.

const row = (page: Page, id: string) => page.locator(`li[data-id="${id}"]`)
const done = (page: Page, state: string) => expect(page.locator('.runline')).toHaveAttribute('data-done', state, { timeout: 15_000 })
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
  await expect(page.getByLabel('counts for smoke', { exact: true })).toHaveText(/✓ 1\s*✗ 1\s*~ 1\s*! 0\s*\? 0/)
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
  await expect(page.getByLabel('Transcript').locator('li')).not.toHaveCount(0)
  await expect(page.getByLabel('Transcript')).toContainText('LGTM, ship it')
  await page.getByRole('tab', { name: 'graders' }).click()
  await expect(page.getByLabel('Graders')).toContainText('regex')
  await expect(page.getByLabel('Graders')).toContainText('passed')
  await page.getByRole('tab', { name: 'usage' }).click()
  await expect(page.getByLabel('Usage')).toContainText('120 in · 8 out')
  await expect(page.getByLabel('Usage')).toContainText('$0.0012')
  await shot(page, 'trial')
})

test('a review trial shows its findings against the ground truth', async ({ page }) => {
  await open(page)
  await done(page, 'finished')
  await expand(page, 'review', 'review/finds', 'review/finds@fake')
  await row(page, 'review/finds@fake#1').click()
  await page.getByRole('tab', { name: 'findings' }).click()
  const findings = page.getByLabel('Findings')
  await expect(findings).toContainText('Matched bugs 1')
  await expect(findings).toContainText('nil-token')
  await expect(findings).toContainText('Missed bugs 1')
  await expect(findings).toContainText('off-by-one')
  await shot(page, 'findings')
})

test('run one: a checked case runs alone', async ({ page }) => {
  await open(page)
  await done(page, 'finished')
  const before = await page.locator('.runline').getAttribute('data-run')
  await page.getByLabel('select smoke/passes', { exact: true }).check()
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
  await page.getByLabel('select smoke', { exact: true }).check()
  await page.getByRole('button', { name: 'Run selected' }).click()
  await done(page, 'finished')
  await page.getByRole('button', { name: 'Rerun failed' }).click()
  await done(page, 'running').catch(() => undefined)
  await done(page, 'finished')
  await expand(page, 'smoke/fails', 'smoke/fails@fake', 'smoke/passes', 'smoke/passes@fake')
  await expect(row(page, 'smoke/fails@fake#1')).toHaveAttribute('data-status', 'fail')
  await expect(row(page, 'smoke/passes@fake#1')).toHaveCount(0)
})

test('cancel stops a run: its trials end cancelled and nothing settles', async ({ page }) => {
  await open(page)
  await page.getByLabel('select slow', { exact: true }).check()
  await page.getByRole('button', { name: 'Run selected' }).click()
  await done(page, 'running')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await done(page, 'cancelled')
  await expand(page, 'slow/waits', 'slow/waits@fake')
  await expect(row(page, 'slow/waits@fake#1')).toHaveAttribute('data-status', 'cancelled')
})

test('compare: two configs in one run, with the grid, the comparison and its flips', async ({ page }) => {
  await open(page)
  await page.getByRole('group', { name: 'configs' }).getByLabel('fake-b').check()
  await page.getByLabel('select smoke', { exact: true }).check()
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

test('the dark theme applies and survives a reload', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: /switch to dark theme/ }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await done(page, 'finished')
  await expand(page, 'smoke/passes', 'smoke/passes@fake')
  await row(page, 'smoke/passes@fake#1').click()
  await shot(page, 'dark')
})
