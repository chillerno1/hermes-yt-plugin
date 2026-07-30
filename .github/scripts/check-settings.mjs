import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const FILE = 'desktop-plugins/hermes-yt-plugin/plugin.js'
const source = readFileSync(FILE, 'utf8')

function numberConstant(name) {
  const match = source.match(new RegExp(`const ${name} = ([\\d_]+)`))
  assert.ok(match, `${name} is missing`)
  return Number(match[1].replaceAll('_', ''))
}

const helperStart = source.indexOf('function normalizePaneMode')
const helperEnd = source.indexOf('function parseSemanticVersion')
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'settings normalizers are missing')

const normalize = new Function(
  'DEFAULT_LIST_LIMIT',
  'MIN_LIST_LIMIT',
  'MAX_LIST_LIMIT',
  `${source.slice(helperStart, helperEnd)}
return { normalizeListLimit, normalizePaneMode }`
)(
  numberConstant('DEFAULT_LIST_LIMIT'),
  numberConstant('MIN_LIST_LIMIT'),
  numberConstant('MAX_LIST_LIMIT')
)

assert.equal(normalize.normalizePaneMode('docked'), 'docked')
assert.equal(normalize.normalizePaneMode('floating'), 'floating')
assert.equal(normalize.normalizePaneMode('unknown'), 'floating')

assert.equal(normalize.normalizeListLimit('20'), 20)
assert.equal(normalize.normalizeListLimit('2.6'), 3)
assert.equal(normalize.normalizeListLimit('-1'), 1)
assert.equal(normalize.normalizeListLimit('500'), 50)
assert.equal(normalize.normalizeListLimit('invalid'), 12)

assert.match(source, /id: docked \? 'screen-docked' : 'screen'/)
assert.match(source, /placement: 'right'/)
assert.match(source, /dock: \{ pane: 'workspace', pos: 'right' \}/)
assert.match(source, /minHeight: `var\(\$\{DOCKED_MIN_HEIGHT_VAR\}/)
assert.match(source, /function useAutoSizeDockedPane/)
assert.match(source, /function openLayoutEditor/)
assert.match(source, /children: jsx\(Codicon, \{ name: 'move'/)
assert.match(source, /const visibleFavourites = favourites\.slice\(0, listLimit\)/)
assert.match(source, /const visibleHistory = history\.slice\(0, listLimit\)/)
assert.match(source, /const HISTORY_RETENTION_CAP = MAX_LIST_LIMIT/)

console.log(`${FILE}: settings contract passed`)
