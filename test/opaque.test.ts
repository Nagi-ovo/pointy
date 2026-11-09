import { test } from 'node:test'
import assert from 'node:assert/strict'
import { focusRect, isOpaque } from '../app/pick/opaque.ts'

type Rect = [number, number, number, number]
const win: Rect = [0, 0, 1000, 800]

test('a box that is not much bigger than the focus frame gets no focus frame', () => {
  assert.equal(focusRect([0, 0, 1000, 440], { x: 500, y: 200 }, 1), undefined)
  assert.equal(focusRect([0, 0, 2000, 880], { x: 500, y: 200 }, 2), undefined)
})

test('one long side is enough for a focus frame, cut to the box', () => {
  assert.deepEqual(focusRect([0, 0, 2000, 300], { x: 1000, y: 150 }, 1), [640, 0, 720, 300])
})

test('the focus frame is centred on the pointer', () => {
  assert.deepEqual(focusRect([0, 0, 2000, 1000], { x: 1000, y: 500 }, 1), [640, 340, 720, 320])
})

test('the focus frame stays inside the big box', () => {
  assert.deepEqual(focusRect([100, 100, 2000, 1000], { x: 120, y: 110 }, 1), [100, 100, 720, 320])
  assert.deepEqual(focusRect([100, 100, 2000, 1000], { x: 2090, y: 1090 }, 1), [1380, 780, 720, 320])
})

test('the focus frame scales with screen units per DIP and with zoom', () => {
  assert.deepEqual(focusRect([0, 0, 4000, 2000], { x: 2000, y: 1000 }, 2), [1280, 680, 1440, 640])
  assert.deepEqual(focusRect([0, 0, 4000, 2000], { x: 2000, y: 1000 }, 1, 2), [1280, 680, 1440, 640])
})

test('zooming past the big box is clamped to the box', () => {
  assert.deepEqual(focusRect([0, 0, 1200, 500], { x: 600, y: 250 }, 1, 4), [0, 0, 1200, 500])
})

test('Chromium shells with accessibility off are opaque whatever else they report', () => {
  assert.equal(isOpaque({ cls: 'Chrome_RenderWidgetHostHWND', kids: true, readable: true }), true)
  assert.equal(isOpaque({ cls: 'Chrome_WidgetWin_1' }), true)
  assert.equal(isOpaque({ cls: 'Intermediate D3D Window' }), true)
  assert.equal(isOpaque({ cls: 'Chrome_WidgetWin_x' }), false)
})

test('a control that is the whole window is opaque even if it has children', () => {
  assert.equal(isOpaque({ control: 'ControlType.Window', rect: [0, 0, 1000, 790], win, kids: true, readable: true }), true)
  assert.equal(isOpaque({ control: 'ControlType.Window', rect: [0, 0, 1000, 700], win, kids: true }), false)
})

test('a childless, unreadable control filling most of the window is opaque', () => {
  assert.equal(isOpaque({ control: 'ControlType.Pane', rect: [0, 0, 1000, 720], win }), true)
  assert.equal(isOpaque({ control: 'ControlType.Pane', rect: [0, 0, 1000, 700], win }), false)
})

test('children or a text interface mean the control is readable', () => {
  assert.equal(isOpaque({ control: 'ControlType.Pane', rect: [0, 0, 1000, 800], win, kids: true }), false)
  assert.equal(isOpaque({ control: 'ControlType.Document', rect: [0, 0, 1000, 800], win, readable: true }), false)
})

test('without both rects nothing is opaque by size', () => {
  assert.equal(isOpaque({ control: 'ControlType.Pane', rect: null, win }), false)
  assert.equal(isOpaque({ control: 'ControlType.Pane', rect: [0, 0, 1000, 800], win: null }), false)
})
