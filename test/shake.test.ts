import { test } from 'node:test'
import assert from 'node:assert/strict'
import { countReversals } from '../app/pick/reversals.ts'

test('moving in one direction is not a shake', () => {
  assert.equal(countReversals([0, 20, 40, 60, 80, 100, 120], 40), 0)
})

test('each swing back of at least the amplitude counts once', () => {
  assert.equal(countReversals([0, 50, 0, 50, 0], 40), 3)
})

test('jitter smaller than the amplitude is ignored', () => {
  assert.equal(countReversals([0, 30, 0, 30, 0, 30], 40), 0)
  assert.equal(countReversals([0, 60, 30, 60, 30, 60], 40), 0)
})

test('a swing is measured from the farthest point reached, not from where it turned', () => {
  assert.equal(countReversals([0, 50, 100, 70], 40), 0)
  assert.equal(countReversals([0, 50, 100, 70, 40], 40), 1)
})

test('the first leg must also travel the amplitude before direction is set', () => {
  assert.equal(countReversals([100, 70, 100, 70], 40), 0)
  assert.equal(countReversals([100, 70, 50, 90, 60], 40), 1)
})

test('a lone sample has no reversals', () => {
  assert.equal(countReversals([10], 40), 0)
})
