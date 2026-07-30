import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const FILE = 'desktop-plugins/hermes-yt-plugin/plugin.js'
const source = readFileSync(FILE, 'utf8')

function stringConstant(name) {
  const match = source.match(new RegExp(`const ${name} = '([^']+)'`))
  assert.ok(match, `${name} is missing`)
  return match[1]
}

function numberConstant(name) {
  const match = source.match(new RegExp(`const ${name} = ([\\d_]+)`))
  assert.ok(match, `${name} is missing`)
  return Number(match[1].replaceAll('_', ''))
}

const helperStart = source.indexOf('function parseSemanticVersion')
const helperEnd = source.indexOf('// ── URLs')
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'update helpers are missing')

const helperSource = source.slice(helperStart, helperEnd)
const constants = {
  ID: stringConstant('ID'),
  RELEASE_API_URL: stringConstant('RELEASE_API_URL'),
  RELEASES_URL: stringConstant('RELEASES_URL'),
  RELEASE_PLUGIN_PATH: stringConstant('RELEASE_PLUGIN_PATH'),
  UPDATE_PENDING_KEY: stringConstant('UPDATE_PENDING_KEY'),
  UPDATE_SOURCE_MAX_BYTES: numberConstant('UPDATE_SOURCE_MAX_BYTES'),
}

function loadHelpers(fetchImpl, desktop, host = { status: async () => ({}) }) {
  const factory = new Function(
    'ID',
    'RELEASE_API_URL',
    'RELEASES_URL',
    'RELEASE_PLUGIN_PATH',
    'UPDATE_PENDING_KEY',
    'UPDATE_SOURCE_MAX_BYTES',
    'fetch',
    'window',
    'TextEncoder',
    'host',
    `${helperSource}
return {
  compareSemanticVersions,
  downloadReleaseSource,
  fetchLatestRelease,
  installRelease,
  installedPluginPath,
}`
  )

  return factory(
    constants.ID,
    constants.RELEASE_API_URL,
    constants.RELEASES_URL,
    constants.RELEASE_PLUGIN_PATH,
    constants.UPDATE_PENDING_KEY,
    constants.UPDATE_SOURCE_MAX_BYTES,
    fetchImpl,
    { hermesDesktop: desktop },
    TextEncoder,
    host
  )
}

function response({ json, text = '', status = 200, contentLength = 0 }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => json,
    text: async () => text,
    headers: { get: name => (name === 'content-length' ? String(contentLength) : null) },
  }
}

const taggedSource = `
const ID = 'hermes-yt-plugin'
const VERSION = '0.4.0'
export default { id: ID, register() {} }
`

{
  const helpers = loadHelpers(async () => response({}), {})
  assert.equal(helpers.compareSemanticVersions('0.4.0', '0.3.9'), 1)
  assert.equal(helpers.compareSemanticVersions('v0.3.0', '0.3.0'), 0)
  assert.equal(helpers.compareSemanticVersions('0.2.9', '0.3.0'), -1)
  assert.equal(
    helpers.installedPluginPath('/home/me/.hermes/desktop-plugins'),
    '/home/me/.hermes/desktop-plugins/hermes-yt-plugin/plugin.js'
  )
  assert.equal(
    helpers.installedPluginPath('C:\\Users\\me\\.hermes\\desktop-plugins'),
    'C:\\Users\\me\\.hermes\\desktop-plugins\\hermes-yt-plugin\\plugin.js'
  )
}

{
  const writes = []
  const desktop = {
    writeTextFile: async (path, text) => writes.push({ path, text }),
  }
  const helpers = loadHelpers(
    async () => response({ text: taggedSource }),
    desktop,
    { status: async () => ({ hermes_home: '/home/me/.hermes' }) }
  )
  const storage = { set() {}, remove() {} }

  assert.equal(
    await helpers.installRelease(
      {
        tag: 'v0.4.0',
        version: '0.4.0',
        url: 'https://github.com/chillerno1/hermes-yt-plugin/releases/tag/v0.4.0',
      },
      storage
    ),
    true
  )
  assert.equal(writes[0].path, '/home/me/.hermes/desktop-plugins/hermes-yt-plugin/plugin.js')
}

{
  const calls = []
  const helpers = loadHelpers(async (url, options) => {
    calls.push({ url, options })
    return response({
      json: { tag_name: 'v0.4.0' },
    })
  }, {})
  const release = await helpers.fetchLatestRelease()
  assert.deepEqual(release, {
    tag: 'v0.4.0',
    version: '0.4.0',
    url: 'https://github.com/chillerno1/hermes-yt-plugin/releases/tag/v0.4.0',
  })
  assert.equal(calls[0].url, constants.RELEASE_API_URL)
  assert.equal(calls[0].options.cache, 'no-store')
}

{
  const writes = []
  const storageCalls = []
  const desktop = {
    desktopPluginsRoot: async () => '/home/me/.hermes/desktop-plugins',
    writeTextFile: async (path, text) => writes.push({ path, text }),
  }
  const helpers = loadHelpers(async () => response({ text: taggedSource }), desktop)
  const storage = {
    set: (...args) => storageCalls.push(['set', ...args]),
    remove: (...args) => storageCalls.push(['remove', ...args]),
  }

  assert.equal(
    await helpers.installRelease(
      {
        tag: 'v0.4.0',
        version: '0.4.0',
        url: 'https://github.com/chillerno1/hermes-yt-plugin/releases/tag/v0.4.0',
      },
      storage
    ),
    true
  )
  assert.deepEqual(writes, [
    {
      path: '/home/me/.hermes/desktop-plugins/hermes-yt-plugin/plugin.js',
      text: taggedSource,
    },
  ])
  assert.deepEqual(storageCalls, [['set', 'updatePendingVersion', '0.4.0']])
}

{
  const opened = []
  const helpers = loadHelpers(async () => response({ status: 500 }), {
    openExternal: async url => opened.push(url),
  })
  const release = {
    tag: 'v0.4.0',
    version: '0.4.0',
    url: 'https://github.com/chillerno1/hermes-yt-plugin/releases/tag/v0.4.0',
  }

  assert.equal(await helpers.installRelease(release, {}), false)
  assert.deepEqual(opened, [release.url])
}

{
  const storageCalls = []
  const helpers = loadHelpers(async () => response({ text: taggedSource }), {
    desktopPluginsRoot: async () => '/home/me/.hermes/desktop-plugins',
    writeTextFile: async () => {
      throw new Error('write denied')
    },
  })
  const storage = {
    set: (...args) => storageCalls.push(['set', ...args]),
    remove: (...args) => storageCalls.push(['remove', ...args]),
  }
  const release = {
    tag: 'v0.4.0',
    version: '0.4.0',
    url: 'https://github.com/chillerno1/hermes-yt-plugin/releases/tag/v0.4.0',
  }

  await assert.rejects(helpers.installRelease(release, storage), /write denied/)
  assert.deepEqual(storageCalls, [
    ['set', 'updatePendingVersion', '0.4.0'],
    ['remove', 'updatePendingVersion'],
  ])
}

{
  const helpers = loadHelpers(async () => response({ text: taggedSource.replace('0.4.0', '9.9.9') }), {})
  await assert.rejects(
    helpers.downloadReleaseSource({ tag: 'v0.4.0', version: '0.4.0' }),
    /does not match the release/
  )
}

console.log(`${FILE}: updater contract passed`)
