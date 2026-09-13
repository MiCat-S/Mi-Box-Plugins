const canvas = require('canvas')
const { AsyncLocalStorage } = require('node:async_hooks')
const budgets = new AsyncLocalStorage()
const MAX_PIXELS = 20_000_000
const MAX_RENDER_PIXELS = 80_000_000

function checkSignal () { budgets.getStore()?.signal?.throwIfAborted() }
function fail (code) {
  const error = new Error(code)
  const budget = budgets.getStore()
  if (budget) budget.failure = error
  throw error
}
function createCanvas (width, height, ...args) {
  checkSignal()
  const pixels = Math.ceil(width) * Math.ceil(height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 0 || height < 0 || pixels > MAX_PIXELS) {
    fail('QUOTE_CANVAS_BUDGET')
  }
  const budget = budgets.getStore()
  if (budget) {
    budget.pixels += pixels
    if (budget.pixels > MAX_RENDER_PIXELS) fail('QUOTE_RENDER_BUDGET')
  }
  return canvas.createCanvas(width, height, ...args)
}
async function loadImage (...args) {
  checkSignal()
  const value = await canvas.loadImage(...args)
  checkSignal()
  if (value.width * value.height > MAX_PIXELS) fail('QUOTE_IMAGE_BUDGET')
  return value
}
function withCanvasBudget (signal, operation) {
  const budget = {signal, pixels: 0}
  return budgets.run(budget, async () => {
    const result = await operation()
    signal?.throwIfAborted()
    if (budget.failure) throw budget.failure
    return result
  })
}
module.exports = {...canvas, createCanvas, loadImage, withCanvasBudget, checkSignal}
