// One signal for the provider or SDK, two reasons behind it. A timeout is the
// model's failure and is graded FAIL; a cancel is the operator's and is never
// graded at all. Sharing one AbortSignal without the reason makes a Ctrl-C
// look like a model that ran out of time.
export type Stop = 'timeout' | 'cancelled'

export function deadline(cancel: AbortSignal, timeoutMs: number): { signal: AbortSignal; stopped: () => Stop | undefined; controller: AbortController; clear: () => void } {
  const controller = new AbortController()
  let why: Stop | undefined
  const stop = (reason: Stop) => {
    if (why) return
    why = reason
    controller.abort(new Error(reason))
  }
  const onCancel = () => stop('cancelled')
  if (cancel.aborted) stop('cancelled')
  else cancel.addEventListener('abort', onCancel, { once: true })
  const timer = setTimeout(() => stop('timeout'), timeoutMs)
  return {
    signal: controller.signal,
    controller,
    stopped: () => why,
    clear: () => {
      clearTimeout(timer)
      cancel.removeEventListener('abort', onCancel)
    },
  }
}
