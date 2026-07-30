// Mirror of the Hermes runtime loader's import scan.
//
// The loader finds a plugin's dependencies by running this regex over raw
// source. It has no comment or string awareness, so a quoted token anywhere in
// the file -- including inside a comment -- reads as a bare import and the
// plugin is rejected at load time. That failure only shows up when Hermes tries
// to load the plugin, so catch it here instead.
import { readFileSync } from 'node:fs'

const FILE = 'desktop-plugins/hermes-yt-plugin/plugin.js'
const ALLOWED = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
const LOADER_SCAN = /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g

const source = readFileSync(FILE, 'utf8')
const seen = new Set()

for (const match of source.matchAll(LOADER_SCAN)) {
  seen.add(match[3])
}

const offenders = [...seen].filter(specifier => !ALLOWED.has(specifier))

if (offenders.length > 0) {
  console.error(`${FILE}: specifiers outside the loader allowlist:\n`)
  for (const specifier of offenders) {
    console.error(`  ${specifier}`)
  }
  console.error(`\nAllowed: ${[...ALLOWED].join(', ')}`)
  console.error(
    '\nIf this is a false positive from prose, reword it. The loader cannot tell\n' +
      'a comment from an import, so the prose has to change, not the allowlist.'
  )
  process.exit(1)
}

console.log(`${FILE}: ${seen.size} specifiers, all allowed`)
