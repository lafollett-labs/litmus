import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigError, InfraError, ModelFailure } from '../../src/core/errors.ts'

test('each error class is distinguishable by instanceof and by name', () => {
  const errors = [new InfraError('throttled'), new ModelFailure('timed out'), new ConfigError('bad yaml')]
  assert.deepEqual(errors.map(e => e.name), ['InfraError', 'ModelFailure', 'ConfigError'])
  assert.ok(errors[0] instanceof InfraError && !(errors[0] instanceof ModelFailure))
  assert.ok(errors.every(e => e instanceof Error))
})
