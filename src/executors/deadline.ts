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

// The call, or the clock if it fires first: a provider that ignores its signal
// and never settles would otherwise outlast every deadline. A call that loses
// the race may still reject later, so its rejection is observed here.
export function raced<T>(call: Promise<T>, signal: AbortSignal): Promise<T> {
  call.catch(() => {})
  const stopped = new Promise<never>((_ok, fail) => {
    if (signal.aborted) fail(signal.reason)
    else signal.addEventListener('abort', () => fail(signal.reason), { once: true })
  })
  return Promise.race([call, stopped])
}
