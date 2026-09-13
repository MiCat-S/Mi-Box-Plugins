'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')

process.env.NODE_PATH = path.resolve(__dirname, '../../TeleBox-Core/node_modules')
Module._initPaths()

const { createCanvas } = require('canvas')
const { generateQuote, clearResources } = require('../quote/generate.js')
const { loadBrand, withAssetRoot } = require('../quote/vendor/emoji-image.js')
const { withCanvasBudget } = require('../quote/vendor/canvas.js')

function png (color) {
  const canvas = createCanvas(12, 12)
  const context = canvas.getContext('2d')
  context.fillStyle = color
  context.fillRect(0, 0, 12, 12)
  return canvas.toBuffer('image/png')
}

async function rootFixture (t, patternColor, emojiColor) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quote-cache-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'emoji'))
  await fs.writeFile(path.join(root, 'pattern_02.png'), png(patternColor))
  await fs.writeFile(path.join(root, 'emoji', 'emoji-apple-image.json'), JSON.stringify({ '😀': png(emojiColor).toString('base64') }))
  return root
}

async function render (root) {
  const controller = new AbortController()
  return withAssetRoot(root, () => withCanvasBudget(controller.signal, () => generateQuote({
    assetRoot: root,
    messages: [{ chatId: 1, from: { id: 1, name: 'Root', photo: {} }, text: '😀', entities: [] }],
    type: 'image',
    format: 'png',
    scale: 1,
    backgroundColor: '#231d2b',
    emojiBrand: 'apple'
  }))).then(result => result.image)
}

test('concurrent roots keep pattern and emoji resources isolated', async t => {
  const first = await rootFixture(t, '#ff0000', '#00ff00')
  const second = await rootFixture(t, '#0000ff', '#ffff00')
  const [firstImage, secondImage] = await Promise.all([render(first), render(second)])
  assert.notDeepEqual(firstImage, secondImage)
  assert.notDeepEqual(
    withAssetRoot(first, () => loadBrand('apple')['😀']),
    withAssetRoot(second, () => loadBrand('apple')['😀'])
  )
})

test('clearResources drops pattern and emoji caches for one root', async t => {
  const root = await rootFixture(t, '#ff0000', '#00ff00')
  const before = await render(root)
  const emojiBefore = withAssetRoot(root, () => loadBrand('apple')['😀'])
  await fs.writeFile(path.join(root, 'pattern_02.png'), png('#0000ff'))
  await fs.writeFile(path.join(root, 'emoji', 'emoji-apple-image.json'), JSON.stringify({ '😀': png('#ffff00').toString('base64') }))
  assert.deepEqual(await render(root), before)
  assert.equal(withAssetRoot(root, () => loadBrand('apple')['😀']), emojiBefore)
  clearResources(root)
  assert.notDeepEqual(await render(root), before)
  assert.notEqual(withAssetRoot(root, () => loadBrand('apple')['😀']), emojiBefore)
})
