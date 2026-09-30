import { test } from 'node:test'
import assert from 'node:assert/strict'
import { optimalMatching, type Candidate } from '../../src/graders/matching.ts'

test('cardinality comes before cost: the pairing greedy gets wrong is found', () => {
  // left 0 can reach right 0 (cheap) or right 1; left 1 can reach only right 0.
  // Greedy takes 0–0 and strands left 1. The maximum matching takes both.
  const pairs = optimalMatching(2, 2, [
    { left: 0, right: 0, cost: [1] },
    { left: 0, right: 1, cost: [5] },
    { left: 1, right: 0, cost: [3] },
  ])
  assert.deepEqual(pairs, [{ left: 0, right: 1 }, { left: 1, right: 0 }])
})

test('among maximum matchings the smallest total cost wins, compared component by component', () => {
  const pairs = optimalMatching(2, 2, [
    { left: 0, right: 0, cost: [1, 9] },
    { left: 0, right: 1, cost: [1, 0] },
    { left: 1, right: 0, cost: [1, 0] },
    { left: 1, right: 1, cost: [1, 9] },
  ])
  assert.deepEqual(pairs, [{ left: 0, right: 1 }, { left: 1, right: 0 }])
})

test('no candidates, or no nodes, is an empty matching', () => {
  assert.deepEqual(optimalMatching(3, 2, []), [])
  assert.deepEqual(optimalMatching(0, 0, []), [])
})

// Every matching of a small instance, by brute force: the reference the flow
// has to agree with on size and on total cost.
function bruteForce(nLeft: number, candidates: Candidate[], dim: number): { size: number; cost: number[] } {
  let best = { size: 0, cost: new Array<number>(dim).fill(0) }
  const walk = (l: number, used: Set<number>, size: number, cost: number[]) => {
    if (l === nLeft) {
      if (size > best.size || (size === best.size && lexLess(cost, best.cost))) best = { size, cost }
      return
    }
    walk(l + 1, used, size, cost)
    for (const c of candidates) {
      if (c.left !== l || used.has(c.right)) continue
      used.add(c.right)
      walk(l + 1, used, size + 1, cost.map((x, i) => x + c.cost[i]!))
      used.delete(c.right)
    }
  }
  walk(0, new Set(), 0, best.cost)
  return best
}

function lexLess(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i]! < b[i]!
  return false
}

test('on 500 random instances the flow matches brute force on size and lexicographic cost', () => {
  let seed = 42
  const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n)
  for (let k = 0; k < 500; k++) {
    const nLeft = 1 + rand(4)
    const nRight = 1 + rand(5)
    const candidates: Candidate[] = []
    for (let l = 0; l < nLeft; l++) {
      for (let r = 0; r < nRight; r++) if (rand(3) > 0) candidates.push({ left: l, right: r, cost: [rand(6), rand(3) - 1, rand(4)] })
    }
    const pairs = optimalMatching(nLeft, nRight, candidates)
    const lefts = new Set(pairs.map(p => p.left))
    const rights = new Set(pairs.map(p => p.right))
    assert.equal(lefts.size, pairs.length, 'one-to-one on the left')
    assert.equal(rights.size, pairs.length, 'one-to-one on the right')
    const cost = pairs
      .map(p => candidates.find(c => c.left === p.left && c.right === p.right)!.cost)
      .reduce((a, c) => a.map((x, i) => x + c[i]!), [0, 0, 0])
    const want = bruteForce(nLeft, candidates, 3)
    assert.equal(pairs.length, want.size, `instance ${k}: size`)
    assert.deepEqual(cost, want.cost, `instance ${k}: cost`)
  }
})
