// A maximum-cardinality one-to-one matching that, among all maximum
// matchings, has the lexicographically smallest total cost vector.
//
// Min-cost max-flow by successive shortest paths: source → left → right →
// sink, unit capacities, and each augmenting path found by Bellman-Ford.
// Costs are vectors compared lexicographically (an ordered group, so the usual
// optimality argument holds unchanged), which lets review-match state its
// tie-breaks as exact priorities instead of weights that could overflow into
// each other. Bellman-Ford rather than Dijkstra because residual costs go
// negative; the graphs are a few dozen nodes.
//
// O(k · V · E · D): k ≤ min(left, right) augmentations, V = left + right + 2,
// E = candidates, D = the cost vector's length.

export type Candidate = { left: number; right: number; cost: number[] }

type Arc = { to: number; cap: number; cost: number[]; rev: number }

export function optimalMatching(nLeft: number, nRight: number, candidates: Candidate[]): { left: number; right: number }[] {
  const dim = candidates[0]?.cost.length ?? 0
  const zero = new Array<number>(dim).fill(0)
  const source = 0
  const sink = nLeft + nRight + 1
  const n = sink + 1
  const graph: Arc[][] = Array.from({ length: n }, () => [])
  const arc = (u: number, v: number, cost: number[]) => {
    graph[u]!.push({ to: v, cap: 1, cost, rev: graph[v]!.length })
    graph[v]!.push({ to: u, cap: 0, cost: cost.map(c => -c), rev: graph[u]!.length - 1 })
  }
  for (let l = 0; l < nLeft; l++) arc(source, 1 + l, zero)
  for (const c of candidates) {
    if (c.cost.length !== dim) throw new Error('every candidate needs a cost vector of the same length')
    arc(1 + c.left, 1 + nLeft + c.right, c.cost)
  }
  for (let r = 0; r < nRight; r++) arc(1 + nLeft + r, sink, zero)

  for (;;) {
    const dist: (number[] | undefined)[] = new Array(n)
    const via: ({ u: number; i: number } | undefined)[] = new Array(n)
    dist[source] = zero
    for (let round = 0; round < n; round++) {
      let changed = false
      for (let u = 0; u < n; u++) {
        const du = dist[u]
        if (!du) continue
        graph[u]!.forEach((a, i) => {
          if (a.cap === 0) return
          const d = add(du, a.cost)
          const dv = dist[a.to]
          if (!dv || less(d, dv)) {
            dist[a.to] = d
            via[a.to] = { u, i }
            changed = true
          }
        })
      }
      if (!changed) break
    }
    if (!dist[sink]) break
    for (let v = sink; v !== source; ) {
      const { u, i } = via[v]!
      const a = graph[u]![i]!
      a.cap -= 1
      graph[a.to]![a.rev]!.cap += 1
      v = u
    }
  }

  const pairs: { left: number; right: number }[] = []
  for (let l = 0; l < nLeft; l++) {
    for (const a of graph[1 + l]!) {
      if (a.to > nLeft && a.to < sink && a.cap === 0) pairs.push({ left: l, right: a.to - 1 - nLeft })
    }
  }
  return pairs
}

function add(a: number[], b: number[]): number[] {
  return a.map((x, i) => x + b[i]!)
}

function less(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!
  return false
}
