const path = require('path')
const fs = require('fs')
const emojiDb = require('./emoji-db')
const {AsyncLocalStorage}=require('node:async_hooks')
const roots=new AsyncLocalStorage()


const emojiJsonByBrand = {
  apple: 'emoji-apple-image.json',
  google: 'emoji-google-image.json',
  twitter: 'emoji-twitter-image.json',
  joypixels: 'emoji-joypixels-image.json',
  blob: 'emoji-blob-image.json'
}

// Emoji resources are loaded lazily for the active plugin data root.
const emojiImageByBrand = new Map()
const MAX_CACHED_BRANDS = 20

function loadBrand (brand) {
  const jsonFile = emojiJsonByBrand[brand]
  if (!jsonFile) return {}

  const root=roots.getStore()
  const cacheKey=`${root||''}:${brand}`
  if (emojiImageByBrand.has(cacheKey)) return emojiImageByBrand.get(cacheKey)
  const filePath = root ? path.join(root,'emoji',jsonFile) : path.resolve(__dirname,'../assets/emoji/',jsonFile)

  try {
    if (fs.existsSync(filePath)) {
      emojiImageByBrand.set(cacheKey, JSON.parse(fs.readFileSync(filePath, 'utf8')))
    } else {
      emojiImageByBrand.set(cacheKey, {})
    }
  } catch (error) {
    console.error('Failed to load emoji brand', brand, error.message)
    emojiImageByBrand.set(cacheKey, {})
  }

  while (emojiImageByBrand.size > MAX_CACHED_BRANDS) {
    emojiImageByBrand.delete(emojiImageByBrand.keys().next().value)
  }
  return emojiImageByBrand.get(cacheKey)
}

function clearAssetRoot (root) {
  const prefix = `${root || ''}:`
  for (const key of emojiImageByBrand.keys()) {
    if (key.startsWith(prefix)) emojiImageByBrand.delete(key)
  }
}

module.exports = {
  loadBrand,
  brands: emojiJsonByBrand,
  currentAssetRoot () { return roots.getStore() },
  clearAssetRoot,
  withAssetRoot (root, operation) { return roots.run(root, operation) }
}
