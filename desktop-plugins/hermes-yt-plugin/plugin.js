/**
 * hermes-yt-plugin — floating YouTube player for the Hermes Desktop client
 *
 * A floating YouTube player for background listening. Type to search, pick a
 * result from the dropdown, star what you like. The player keeps playing while
 * you search.
 *
 * Playback runs YouTube's own player in a <webview> — a small browser — so the
 * normal player (and its ads/analytics) is what plays. This deliberately does
 * not touch media streams.
 *
 * Two shell behaviours worth knowing, neither fixable from a plugin:
 *  - The floating pane's collapse chevron unmounts the pane body, and closing
 *    unregisters it. Either stops playback.
 *  - Floating geometry is stored per pane id and stored beats authored, so a
 *    changed spawn size only applies under a new pane id.
 *
 * NB: never write the word "from" followed by a quoted token anywhere in this
 * file, even inside a comment. The runtime loader scans raw source with
 * /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g and has no comment
 * awareness, so it reads that as a bare import and refuses to load the plugin.
 */

import {
  Codicon,
  PALETTE_AREA,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Switch,
  Tip,
  atom,
  haptic,
  host,
  useValue,
} from '@hermes/plugin-sdk'
import { useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'hermes-yt-plugin'
/**
 * Own persistent cookie jar, isolated from other Hermes webviews.
 *
 * NB: this does NOT mean the player is signed in. There is no sign-in flow —
 * WATCH_CSS hides the masthead (and its sign-in button), the player webview is
 * built without `allowpopups`, and accounts.google.com rejects Electron's user
 * agent as an insecure embedded browser anyway. The partition would hold a
 * session; nothing can currently establish one.
 */
const PARTITION = 'persist:hermes-yt-plugin'
const OPEN_KEY = 'floatingOpen'
const SRC_KEY = 'lastSrc'
const FAVOURITES_KEY = 'favourites'
const HISTORY_KEY = 'history'
const SHOW_RECENTS_KEY = 'showRecents'
const FLOATING_SIZE_KEY = 'floatingSize'
const HISTORY_CAP = 12
const RESULT_CAP = 8
const SEARCH_DEBOUNCE_MS = 350
const FLOATING_VIEWPORT_TOP = 34
const FLOATING_MARGIN = 12
const FLOATING_MIN_WIDTH = 280
const FLOATING_MAX_WIDTH = 1280
const FLOATING_HORIZONTAL_INSET = 16
const FLOATING_CHROME_HEIGHT = 84
const PLAYER_VIEW_WIDTH = 800
const PLAYER_VIEW_HEIGHT = 450
const PANEL_RESIZE_MS = 220
const PANEL_FADE_MS = 160
const FLOATING_RESIZE_END_EVENT = 'hermes-yt-plugin:resize-end'

/** Shared open-state for the floating card (chip ↔ close button). */
const $floatingOpen = atom(true)
/** The URL the webview should load. Only changes on an explicit play. */
const $src = atom(null)
/** What the webview is actually showing — it navigates on its own. */
const $current = atom({ url: null, title: null })
const $favourites = atom([])
const $history = atom([])
const $libraryOpen = atom(false)
const $showRecents = atom(true)

const VIDEO_ID = /^[\w-]{11}$/

// ── URLs ─────────────────────────────────────────────────────────────────────

/** "1h2m30s" / "90s" / "90" → seconds. */
function parseStart(raw) {
  if (!raw) return 0
  const text = String(raw).trim()
  if (/^\d+$/.test(text)) return parseInt(text, 10)
  const match = text.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/i)
  if (!match || (!match[1] && !match[2] && !match[3])) return 0
  return (
    parseInt(match[1] || '0', 10) * 3600 +
    parseInt(match[2] || '0', 10) * 60 +
    parseInt(match[3] || '0', 10)
  )
}

/**
 * Accepts what a person actually pastes: a watch URL, youtu.be short link,
 * playlist, shorts, live, an existing embed URL, or a bare 11-character id.
 * Returns null for anything else — including plain words, which the caller then
 * treats as a search.
 */
function parseTarget(raw) {
  const text = String(raw || '').trim()
  if (!text) return null
  if (VIDEO_ID.test(text)) return { videoId: text, listId: null, start: 0 }
  // Only try URL parsing when it actually looks like one, so "dark ambient mix"
  // isn't mangled into a hostname.
  if (!/^https?:\/\//i.test(text) && !/^(?:www\.|m\.)?youtu/i.test(text)) return null

  let url
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return null
  }

  const hostname = url.hostname.replace(/^www\./, '')
  const segments = url.pathname.split('/').filter(Boolean)
  const listId = url.searchParams.get('list')
  const start = parseStart(url.searchParams.get('t') || url.searchParams.get('start'))

  let videoId = null
  if (hostname === 'youtu.be') {
    videoId = segments[0] || null
  } else if (hostname === 'youtube.com' || hostname === 'youtube-nocookie.com' || hostname === 'm.youtube.com') {
    if (segments[0] === 'embed' || segments[0] === 'shorts' || segments[0] === 'live' || segments[0] === 'v') {
      videoId = segments[1] || null
    } else {
      videoId = url.searchParams.get('v')
    }
  } else {
    return null
  }

  if (videoId && !VIDEO_ID.test(videoId)) videoId = null
  if (!videoId && !listId) return null
  return { videoId, listId, start }
}

/**
 * Build a normal watch URL — not an `/embed/` one.
 *
 * The embed player enforces restrictions unrelated to whether YouTube will play
 * something in a browser: owners can disable embedding, and auto-generated
 * radio/mix playlists (`list=RD…`, as produced by the start-radio button) are
 * never embeddable. Both surface as an opaque "Error 153". Loading the page a
 * browser would load avoids the entire category.
 */
function buildPlayUrl(target) {
  if (!target.videoId && target.listId) {
    const url = new URL('https://www.youtube.com/playlist')
    url.searchParams.set('list', target.listId)
    return url.toString()
  }
  const url = new URL('https://www.youtube.com/watch')
  url.searchParams.set('v', target.videoId)
  if (target.listId) url.searchParams.set('list', target.listId)
  if (target.start > 0) url.searchParams.set('t', `${target.start}s`)
  return url.toString()
}

function watchUrlFor(videoId) {
  return `https://www.youtube.com/watch?v=${videoId}`
}

function isWatchUrl(url) {
  return typeof url === 'string' && /^https:\/\/(?:www\.)?youtube\.com\/watch\b/.test(url)
}

/** Dedupe key: the video id when there is one, else the URL itself. */
function entryKey(url) {
  try {
    const parsed = new URL(url)
    return parsed.searchParams.get('v') || parsed.searchParams.get('list') || url
  } catch {
    return url
  }
}

function prefersReducedMotion() {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches
  } catch {
    return false
  }
}

function cleanTitle(raw) {
  return String(raw || '')
    .replace(/\s*-\s*YouTube\s*$/i, '')
    .trim()
}

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Search runs INSIDE a hidden <webview> parked on youtube.com.
 *
 * The renderer itself can't fetch youtube.com — no CORS headers, so the request
 * is blocked. A webview sitting on a youtube.com document can fetch the results
 * page same-origin, which is why the worker exists. It's parked on robots.txt
 * rather than the homepage: same origin, a few hundred bytes, no page to render.
 *
 * The results list comes out of `ytInitialData`, walked for `videoRenderer`
 * anywhere in the tree rather than down a hard-coded path, so YouTube reshuffling
 * its section wrappers doesn't break it. Any failure returns an empty list and
 * the UI says it found nothing — nothing here is load-bearing for playback.
 */
const SEARCH_PARK_URL = 'https://www.youtube.com/robots.txt'

function searchScript(query) {
  return `
(async () => {
  try {
    const res = await fetch('/results?search_query=' + encodeURIComponent(${JSON.stringify(query)}), { credentials: 'omit' })
    const html = await res.text()
    const at = html.indexOf('ytInitialData')
    if (at < 0) return '[]'
    const open = html.indexOf('{', at)
    if (open < 0) return '[]'
    let depth = 0, inStr = false, quote = '', esc = false, end = -1
    for (let i = open; i < html.length; i++) {
      const c = html[i]
      if (inStr) {
        if (esc) esc = false
        else if (c === '\\\\') esc = true
        else if (c === quote) inStr = false
        continue
      }
      if (c === '"' || c === "'") { inStr = true; quote = c; continue }
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) { end = i + 1; break } }
    }
    if (end < 0) return '[]'
    let data
    try { data = JSON.parse(html.slice(open, end)) } catch (e) { return '[]' }
    const out = []
    const seen = new Set()
    const text = (n) => !n ? '' : (typeof n.simpleText === 'string' ? n.simpleText
      : (Array.isArray(n.runs) ? n.runs.map(r => r && r.text ? r.text : '').join('') : ''))
    const visit = (n) => {
      if (!n || typeof n !== 'object' || out.length >= ${RESULT_CAP}) return
      if (Array.isArray(n)) { for (const v of n) visit(v); return }
      const vr = n.videoRenderer
      if (vr && typeof vr.videoId === 'string' && !seen.has(vr.videoId)) {
        seen.add(vr.videoId)
        out.push({
          id: vr.videoId,
          title: text(vr.title),
          channel: text(vr.ownerText) || text(vr.longBylineText),
          length: text(vr.lengthText)
        })
        if (out.length >= ${RESULT_CAP}) return
      }
      for (const k of Object.keys(n)) visit(n[k])
    }
    visit(data)
    return JSON.stringify(out)
  } catch (e) { return '[]' }
})()
`
}

/** Hidden worker webview + a search() that runs in it. */
function useYouTubeSearch() {
  const mount = useRef(null)
  const view = useRef(null)

  useEffect(() => {
    const parent = mount.current
    if (!parent) return undefined

    const worker = document.createElement('webview')
    worker.setAttribute('partition', PARTITION)
    worker.setAttribute('src', SEARCH_PARK_URL)
    worker.setAttribute('webpreferences', 'contextIsolation=yes,nodeIntegration=no,sandbox=yes')
    // Kept live rather than display:none — a hidden-but-laid-out view keeps its
    // document around to run fetches in.
    worker.style.position = 'absolute'
    worker.style.left = '-9999px'
    worker.style.width = '1px'
    worker.style.height = '1px'
    worker.style.opacity = '0'
    worker.style.pointerEvents = 'none'
    parent.appendChild(worker)
    view.current = worker

    return () => {
      view.current = null
      worker.remove()
    }
  }, [])

  const search = async (query) => {
    const worker = view.current
    if (!worker || typeof worker.executeJavaScript !== 'function') return []
    try {
      const raw = await worker.executeJavaScript(searchScript(query))
      const parsed = JSON.parse(raw || '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  return { anchorRef: mount, search }
}

// ── Injected CSS ─────────────────────────────────────────────────────────────

/**
 * Strip the watch page down to its player.
 *
 * Purely cosmetic — if YouTube renames something the result is a cluttered page,
 * not a broken one. Page dialogs are left alone so a consent prompt can still be
 * dismissed.
 *
 * The <video> is pinned to fill the player and centred by `object-fit: contain`.
 * That has to be done as a pair: YouTube's player sizes and positions the video
 * with JS-computed left/top/width/height for the box size it *thinks* it has, and
 * it does not recompute when injected CSS changes the layout underneath it —
 * which left the picture at ~297×171 inside a ~440×253 player, top-aligned.
 * Setting left/top without also forcing width/height is the worst of both: it
 * defeats the centring and keeps the wrong size.
 */
const WATCH_CSS = `
  ytd-masthead, #masthead-container, tp-yt-app-header, tp-yt-app-drawer,
  ytd-mini-guide-renderer, #guide, #guide-content, #chips-wrapper,
  #secondary, #secondary-inner, #below, ytd-comments, #related,
  ytd-merch-shelf-renderer, .ytp-chrome-top-buttons {
    display: none !important;
  }
  html, body { overflow: hidden !important; background: #000 !important; }
  ytd-app, ytd-page-manager, ytd-watch-flexy { margin: 0 !important; padding: 0 !important; }
  #columns, #primary, #primary-inner, #content {
    max-width: 100vw !important; width: 100vw !important;
    margin: 0 !important; padding: 0 !important;
  }
  #player, #player-container-outer, #player-container-inner, #player-container,
  #full-bleed-container, #player-theater-container {
    max-width: 100vw !important; width: 100vw !important;
    max-height: 100vh !important; min-height: 0 !important;
    margin: 0 !important; padding: 0 !important;
  }
  #movie_player, .html5-video-player { width: 100vw !important; height: 100vh !important; }
  /* The container MUST be given a real box before the video can fill it. It is
     the video's containing block and YouTube leaves it auto-height, so a plain
     height of 100 percent on the video resolved to 100 percent of nothing —
     measured as video 402x0, an invisible video in an all-black player. Sizing
     both with position and inset takes the height out of the parent's content
     flow. (No backticks in here: this whole block is a template literal.) */
  #movie_player .html5-video-container {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
  }
  #movie_player video, video.html5-main-video {
    position: absolute !important;
    inset: 0 !important;
    width: 100% !important;
    height: 100% !important;
    object-fit: contain !important;
  }
`

// ── Player ───────────────────────────────────────────────────────────────────

/**
 * A <webview>, not an <iframe>.
 *
 * The packaged renderer loads over file://, which has no origin and sends no
 * referrer, so an embedded iframe player can't verify its embedding page and
 * refuses with "Error 153". No iframe parameter fixes that — the containing page
 * is the problem. A <webview> loads YouTube top-level instead, so there is
 * nothing to verify. `webviewTag: true` and
 * `autoplayPolicy: 'no-user-gesture-required'` both come out of
 * chatWindowWebPreferences.
 *
 * The player letterboxes whatever the pane's shape doesn't match. That's normal
 * video behaviour, not a bug — resizing the pane toward 16:9 removes it.
 */
function Player({ src, constrained, onNavigate, onTitle }) {
  const mount = useRef(null)

  // Held in a ref, and the effect depends on `src` ALONE.
  //
  // These callbacks are redefined on every Overlay render, so listing them as
  // dependencies tears down and rebuilds the webview whenever anything else in
  // the pane changes — every keystroke in the search box included. Playback then
  // never survives long enough to start.
  const handlers = useRef({ onNavigate, onTitle })
  handlers.current = { onNavigate, onTitle }

  useEffect(() => {
    const parent = mount.current
    if (!parent || !src) return undefined

    // Built imperatively, mirroring the host's preview-pane: <webview> is a
    // custom element and replacing it wholesale is the reliable way to navigate.
    // No `allowpopups` — clicks must not spawn windows.
    const view = document.createElement('webview')
    view.setAttribute('partition', PARTITION)
    view.setAttribute('src', src)
    view.setAttribute(
      'webpreferences',
      'contextIsolation=yes,nodeIntegration=no,sandbox=yes,autoplayPolicy=no-user-gesture-required'
    )
    // Electron's webview tag uses display:flex internally so its shadow-DOM
    // iframe fills the host element. Overriding that with display:block leaves
    // the guest near the iframe's default 300x150 size, producing black space
    // on the right and below it.
    view.style.position = 'absolute'
    view.style.inset = '0 auto auto 0'
    view.style.display = 'flex'
    view.style.width = `${PLAYER_VIEW_WIDTH}px`
    view.style.height = `${PLAYER_VIEW_HEIGHT}px`
    view.style.transformOrigin = 'top left'
    view.style.background = '#000'

    // Re-applied per navigation: insertCSS is scoped to the current document, so
    // a full load drops it. YouTube's in-page hops keep the document, but
    // clicking through a queue can trigger real loads too.
    const applyCss = () => {
      try {
        const inserted = view.insertCSS(WATCH_CSS)
        if (inserted && typeof inserted.catch === 'function') inserted.catch(() => {})
      } catch {
        /* cosmetic only */
      }
      scheduleNudges()
    }
    // The player's own setSize() is the direct instruction; a synthetic resize
    // alone was measurably not enough to make it recompute the video box. Both
    // are sent, and neither is depended on — the CSS above stands on its own.
    // Repeated because the player initialises asynchronously.
    const nudges = []
    const nudgeResize = () => {
      try {
        const run = view.executeJavaScript(
          "(() => { const p = document.querySelector('#movie_player');" +
            " if (p && typeof p.setSize === 'function') { try { p.setSize(window.innerWidth, window.innerHeight) } catch (e) {} }" +
            " window.dispatchEvent(new Event('resize')); })()"
        )
        if (run && typeof run.catch === 'function') run.catch(() => {})
      } catch {
        /* view not ready, or already gone */
      }
    }
    const scheduleNudges = () => {
      nudgeResize()
      for (const delay of [400, 1500]) nudges.push(setTimeout(nudgeResize, delay))
    }

    // Electron stops reliably painting a large, live-resized guest surface.
    // Keep the guest at a known-working 16:9 viewport and scale that surface;
    // Chromium maps pointer coordinates through the transform as well.
    const fitView = () => {
      const width = parent.clientWidth
      const height = parent.clientHeight
      if (!width || !height) return
      view.style.transform = `scale(${width / PLAYER_VIEW_WIDTH}, ${height / PLAYER_VIEW_HEIGHT})`
    }
    const resizeObserver = new ResizeObserver(fitView)

    const report = () => {
      try {
        handlers.current.onNavigate(view.getURL())
      } catch {
        /* the view may already be gone */
      }
    }
    const onPageTitle = (event) => handlers.current.onTitle(cleanTitle(event.title))

    view.addEventListener('dom-ready', applyCss)
    view.addEventListener('did-navigate', applyCss)
    view.addEventListener('did-navigate-in-page', applyCss)
    view.addEventListener('did-navigate', report)
    view.addEventListener('did-navigate-in-page', report)
    view.addEventListener('page-title-updated', onPageTitle)
    parent.appendChild(view)
    fitView()
    resizeObserver.observe(parent)

    return () => {
      resizeObserver.disconnect()
      view.removeEventListener('dom-ready', applyCss)
      view.removeEventListener('did-navigate', applyCss)
      view.removeEventListener('did-navigate-in-page', applyCss)
      view.removeEventListener('did-navigate', report)
      view.removeEventListener('did-navigate-in-page', report)
      view.removeEventListener('page-title-updated', onPageTitle)
      for (const timer of nudges) clearTimeout(timer)
      view.remove()
    }
  }, [src])

  // Prefer 16:9. Once the user has manually sized the pane, allow this box to
  // shrink when necessary so the fixed controls never fall below the viewport.
  //
  // Stretching it to the pane makes the player box taller than the video, and
  // YouTube then pads the bottom with player background — the "black bar". The
  // giveaway is that opening the favourites list made it disappear: the list took
  // the spare height, so the box happened to match the video. Sizing to the ratio
  // gets that outcome at every pane size, and any leftover pane height now sits
  // below the controls as pane background rather than reading as a black hole.
  return jsx('div', {
    ref: mount,
    style: {
      width: '100%',
      aspectRatio: '16 / 9',
      maxHeight: 'calc(100vh - 96px)',
      flex: constrained ? '0 1 auto' : '0 0 auto',
      minHeight: constrained ? '100px' : undefined,
      position: 'relative',
      overflow: 'hidden',
      borderRadius: '4px',
      background: '#000',
    },
  })
}

// ── Controls ─────────────────────────────────────────────────────────────────

const iconButtonStyle = (active) => ({
  display: 'grid',
  placeItems: 'center',
  width: '24px',
  height: '24px',
  flexShrink: 0,
  borderRadius: '4px',
  color: active ? '#e0b341' : 'var(--ui-text-secondary)',
  background: 'color-mix(in srgb, var(--ui-text-primary) 7%, transparent)',
})

// No maxHeight/overflow: the panel grows downward and the pane scrolls. An inner
// scroller here produced a second scrollbar inside an already-scrolling pane.
const panelStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1px',
  paddingRight: '2px',
}

const rowButtonStyle = {
  minWidth: 0,
  flex: 1,
  padding: '3px 4px',
  textAlign: 'left',
  fontSize: '0.6875rem',
  color: 'var(--ui-text-secondary)',
  borderRadius: '3px',
  overflow: 'hidden',
}

const metaStyle = {
  fontSize: '0.5625rem',
  color: 'var(--ui-text-quaternary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

function heading(text) {
  return jsx('div', {
    style: {
      fontSize: '0.5625rem',
      fontWeight: 600,
      textTransform: 'uppercase',
      letterSpacing: '0.14em',
      color: 'var(--ui-text-quaternary)',
      paddingTop: '2px',
    },
    children: text,
  })
}

/** Search results, dropped below the input rather than shown in the player. */
function Results({ results, searching, query, onPlay }) {
  if (searching && !results.length) {
    return jsx('div', {
      style: { padding: '6px 2px', fontSize: '0.6875rem', color: 'var(--ui-text-quaternary)' },
      children: 'Searching…',
    })
  }
  if (!results.length) {
    return jsx('div', {
      style: { padding: '6px 2px', fontSize: '0.6875rem', color: 'var(--ui-text-quaternary)' },
      children: `Nothing found for “${query}”`,
    })
  }

  return jsx('div', {
    style: panelStyle,
    children: results.map((item) =>
      jsxs('button', {
        type: 'button',
        'data-floating-no-drag': '',
        title: item.title,
        onClick: () => {
          haptic('tap')
          onPlay(watchUrlFor(item.id))
        },
        style: { ...rowButtonStyle, display: 'block' },
        children: [
          jsx('div', {
            style: {
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              color: 'var(--ui-text-primary)',
            },
            children: item.title,
          }),
          jsx('div', {
            style: metaStyle,
            children: [item.channel, item.length].filter(Boolean).join(' · '),
          }),
        ],
      }, item.id)
    ),
  })
}

function LibraryRow({ entry, onPlay, onRemove, removeLabel }) {
  return jsxs('div', {
    style: { display: 'flex', alignItems: 'center', gap: '4px' },
    children: [
      jsx('button', {
        type: 'button',
        'data-floating-no-drag': '',
        onClick: () => {
          haptic('tap')
          onPlay(entry.url)
        },
        title: entry.title || entry.url,
        style: { ...rowButtonStyle, textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
        children: entry.title || entry.url,
      }),
      jsx('button', {
        type: 'button',
        'aria-label': removeLabel,
        'data-floating-no-drag': '',
        onClick: () => {
          haptic('tap')
          onRemove(entry.url)
        },
        style: {
          display: 'grid',
          placeItems: 'center',
          width: '18px',
          height: '18px',
          flexShrink: 0,
          borderRadius: '3px',
          color: 'var(--ui-text-quaternary)',
        },
        children: jsx(Codicon, { name: 'close', size: '0.625rem' }),
      }),
    ],
  })
}

/**
 * Favourites + recent, also below the input. Overlaying a <webview> is
 * unreliable, and replacing the player would unmount it and stop the audio —
 * which is the whole point of the overlay.
 */
function Library({ favourites, history, showRecents, onPlay, onRemoveFavourite, onRemoveHistory }) {
  return jsxs('div', {
    style: panelStyle,
    children: [
      favourites.length ? heading('Favourites') : null,
      ...favourites.map((entry) =>
        jsx(LibraryRow, {
          entry,
          onPlay,
          onRemove: onRemoveFavourite,
          removeLabel: 'Remove from favourites',
        }, `fav:${entryKey(entry.url)}`)
      ),
      showRecents && history.length ? heading('Recent') : null,
      ...(showRecents
        ? history.map((entry) =>
            jsx(LibraryRow, {
              entry,
              onPlay,
              onRemove: onRemoveHistory,
              removeLabel: 'Remove from recent',
            }, `hist:${entryKey(entry.url)}`)
          )
        : []),
      !favourites.length && (!showRecents || !history.length)
        ? jsx('div', {
            style: { padding: '6px 2px', fontSize: '0.6875rem', color: 'var(--ui-text-quaternary)' },
            children: 'Nothing saved yet. Play something, then star it.',
          })
        : null,
    ],
  })
}

/** Add a persisted resize grip when the Hermes shell does not provide one. */
function useFallbackFloatingResize(rootRef, storage) {
  const resizingRef = useRef(false)
  const manualHeightRef = useRef(null)
  const [manuallySized, setManuallySized] = useState(false)

  useEffect(() => {
    const root = rootRef.current
    const pane = root && root.closest('[data-floating-pane]')
    if (!root || !pane || pane.querySelector('[data-floating-resize]')) return undefined
    setManuallySized(true)

    const fitSize = (requestedWidth) => {
      const rect = pane.getBoundingClientRect()
      const availableWidth = window.innerWidth - rect.left - FLOATING_MARGIN
      const availableHeight = window.innerHeight - rect.top - FLOATING_MARGIN
      const widthForAvailableHeight =
        ((availableHeight - FLOATING_CHROME_HEIGHT) * 16) / 9 + FLOATING_HORIZONTAL_INSET
      const maxWidth = Math.max(
        FLOATING_MIN_WIDTH,
        Math.min(FLOATING_MAX_WIDTH, availableWidth, widthForAvailableHeight)
      )
      const width = Math.min(Math.max(requestedWidth, FLOATING_MIN_WIDTH), maxWidth)
      const playerWidth = Math.max(0, width - FLOATING_HORIZONTAL_INSET)

      return {
        width,
        height: (playerWidth * 9) / 16 + FLOATING_CHROME_HEIGHT,
      }
    }

    const stored = storage.get(FLOATING_SIZE_KEY, null)
    if (
      stored &&
      Number.isFinite(stored.width) &&
      Number.isFinite(stored.height) &&
      stored.width > 0 &&
      stored.height > 0
    ) {
      const size = fitSize(stored.width)
      pane.style.width = `${Math.round(size.width)}px`
      pane.style.height = `${Math.round(size.height)}px`
      manualHeightRef.current = size.height
    }

    const handle = document.createElement('div')
    handle.setAttribute('aria-label', 'Resize YouTube pane')
    handle.setAttribute('data-floating-no-drag', '')
    handle.setAttribute('data-hermes-yt-plugin-resize', 'se')
    handle.setAttribute('role', 'separator')
    handle.setAttribute('title', 'Drag to resize')
    Object.assign(handle.style, {
      position: 'absolute',
      right: '0',
      bottom: '0',
      zIndex: '20',
      width: '16px',
      height: '16px',
      cursor: 'nwse-resize',
      touchAction: 'none',
      opacity: '0.65',
      background:
        'linear-gradient(135deg, transparent 58%, color-mix(in srgb, var(--ui-text-quaternary) 75%, transparent) 58%, color-mix(in srgb, var(--ui-text-quaternary) 75%, transparent) 66%, transparent 66%, transparent 74%, color-mix(in srgb, var(--ui-text-quaternary) 75%, transparent) 74%, color-mix(in srgb, var(--ui-text-quaternary) 75%, transparent) 82%, transparent 82%)',
    })
    pane.appendChild(handle)

    let drag = null

    const onPointerDown = (event) => {
      const rect = pane.getBoundingClientRect()
      const compactSize = fitSize(rect.width)
      drag = {
        x: event.clientX,
        y: event.clientY,
        width: rect.width,
        compactHeight: compactSize.height,
        startCompactHeight: compactSize.height,
        extraHeight: Math.max(0, rect.height - compactSize.height),
        transition: pane.style.transition,
      }
      resizingRef.current = true
      pane.style.transition = 'none'
      handle.setPointerCapture(event.pointerId)
      event.preventDefault()
      event.stopPropagation()
    }

    const onPointerMove = (event) => {
      if (!drag) return
      const deltaX = event.clientX - drag.x
      const deltaY = event.clientY - drag.y
      const widthFromHeight =
        ((drag.startCompactHeight + deltaY - FLOATING_CHROME_HEIGHT) * 16) / 9 +
        FLOATING_HORIZONTAL_INSET
      const requestedWidth =
        Math.abs(deltaX) >= Math.abs(deltaY) ? drag.width + deltaX : widthFromHeight
      const size = fitSize(requestedWidth)
      const rect = pane.getBoundingClientRect()
      const maxHeight = window.innerHeight - rect.top - FLOATING_MARGIN
      drag.compactHeight = size.height
      pane.style.width = `${Math.round(size.width)}px`
      pane.style.height = `${Math.round(Math.min(size.height + drag.extraHeight, maxHeight))}px`
    }

    const finishResize = (event) => {
      if (!drag) return
      const rect = pane.getBoundingClientRect()
      const transition = drag.transition
      const compactHeight = drag.compactHeight
      drag = null
      resizingRef.current = false
      manualHeightRef.current = compactHeight
      pane.style.transition = transition
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
      storage.set(FLOATING_SIZE_KEY, {
        width: Math.round(rect.width),
        height: Math.round(compactHeight),
      })
      root.dispatchEvent(new Event(FLOATING_RESIZE_END_EVENT))
    }

    handle.addEventListener('pointerdown', onPointerDown)
    handle.addEventListener('pointermove', onPointerMove)
    handle.addEventListener('pointerup', finishResize)
    handle.addEventListener('pointercancel', finishResize)

    return () => {
      resizingRef.current = false
      handle.removeEventListener('pointerdown', onPointerDown)
      handle.removeEventListener('pointermove', onPointerMove)
      handle.removeEventListener('pointerup', finishResize)
      handle.removeEventListener('pointercancel', finishResize)
      handle.remove()
    }
  }, [rootRef, storage])

  return { manualHeightRef, manuallySized, resizingRef }
}

/** Fit the closed card to its controls and grow it around an open list. */
function useAutoSizeFloatingPane(rootRef, expanded, manualHeightRef, resizingRef) {
  const hasClosedFit = useRef(false)

  useEffect(() => {
    const root = rootRef.current
    const pane = root && root.closest('[data-floating-pane]')
    if (!root || !pane) return undefined

    const initialHeight = pane.getBoundingClientRect().height
    const initialStyle = {
      height: pane.style.height,
      transition: pane.style.transition,
    }
    const transitionToken = expanded ? `${Date.now()}:${Math.random()}` : null
    if (transitionToken) {
      pane.dataset.hermesYtPluginTransition = transitionToken
      if (!prefersReducedMotion()) {
        pane.style.transition = `height ${PANEL_RESIZE_MS}ms cubic-bezier(0.2, 0, 0.2, 1)`
      }
    }

    const header = pane.querySelector(':scope > header')
    let frame = null
    let settleTimer = null

    const apply = () => {
      frame = null
      if (!pane.isConnected || resizingRef.current) return

      const headerHeight = header ? header.getBoundingClientRect().height : 0
      const naturalHeight = Math.ceil(root.scrollHeight + headerHeight)
      const maxHeight = Math.max(
        120,
        window.innerHeight - FLOATING_VIEWPORT_TOP - FLOATING_MARGIN * 2
      )
      const manualHeight = manualHeightRef.current
      const contentHeight =
        manualHeight === null
          ? expanded
            ? Math.max(initialHeight, naturalHeight)
            : naturalHeight
          : expanded
            ? Math.max(manualHeight, naturalHeight)
            : manualHeight
      const height = Math.min(contentHeight, maxHeight)
      const heightCss = `${Math.round(height)}px`

      if (pane.style.height !== heightCss) pane.style.height = heightCss
      if (!expanded) hasClosedFit.current = true
    }

    const schedule = () => {
      if (frame === null) frame = requestAnimationFrame(apply)
    }
    const scheduleSettled = () => {
      // On close, the expanded effect already restores the known closed height.
      // Measuring before the inner grid finishes collapsing would write an
      // intermediate height and then visibly correct it after the transition.
      if (expanded || !hasClosedFit.current) schedule()
      clearTimeout(settleTimer)
      // The panel itself animates open; measure again once its grid track has
      // reached the full content height.
      settleTimer = setTimeout(schedule, PANEL_RESIZE_MS + 20)
    }

    const contentObserver = new MutationObserver(scheduleSettled)
    contentObserver.observe(root, {
      attributes: true,
      childList: true,
      characterData: true,
      subtree: true,
    })

    // A window resize makes FloatingPane write its React-owned rectangle back
    // to the style attribute. Reapply the content size on the next frame.
    const paneObserver = new MutationObserver(scheduleSettled)
    paneObserver.observe(pane, { attributes: true, attributeFilter: ['style'] })
    window.addEventListener('resize', scheduleSettled)
    root.addEventListener(FLOATING_RESIZE_END_EVENT, scheduleSettled)
    scheduleSettled()

    return () => {
      contentObserver.disconnect()
      paneObserver.disconnect()
      window.removeEventListener('resize', scheduleSettled)
      root.removeEventListener(FLOATING_RESIZE_END_EVENT, scheduleSettled)
      if (frame !== null) cancelAnimationFrame(frame)
      clearTimeout(settleTimer)
      if (!transitionToken) return

      // Hermes unmounts the plugin body when its header chevron collapses the
      // floating pane. At that point the shell has already removed its height;
      // writing the pre-expansion height back would leave a tall empty card.
      if (!root.isConnected) {
        pane.style.transition = initialStyle.transition
        delete pane.dataset.hermesYtPluginTransition
        return
      }

      pane.dataset.hermesYtPluginTransition = transitionToken
      const manualHeight = manualHeightRef.current
      pane.style.height = manualHeight === null ? initialStyle.height : `${Math.round(manualHeight)}px`
      if (prefersReducedMotion()) {
        pane.style.transition = initialStyle.transition
        delete pane.dataset.hermesYtPluginTransition
      } else {
        setTimeout(() => {
          if (pane.dataset.hermesYtPluginTransition !== transitionToken) return
          pane.style.transition = initialStyle.transition
          delete pane.dataset.hermesYtPluginTransition
        }, PANEL_RESIZE_MS)
      }
    }
  }, [expanded, manualHeightRef, resizingRef, rootRef])
}

/** Stage content visibility around the pane's height animation. */
function usePanelTransition(open) {
  const [expanded, setExpanded] = useState(open)
  const [contentVisible, setContentVisible] = useState(false)

  useEffect(() => {
    if (prefersReducedMotion()) {
      setExpanded(open)
      setContentVisible(open)
      return undefined
    }

    let timer
    if (open) {
      setExpanded(true)
      setContentVisible(false)
      timer = setTimeout(() => setContentVisible(true), PANEL_RESIZE_MS)
    } else {
      setContentVisible(false)
      timer = setTimeout(() => setExpanded(false), PANEL_FADE_MS)
    }

    return () => clearTimeout(timer)
  }, [open])

  return { contentVisible, expanded }
}

/** Keep the shell's overflow fallback, but do not show its scrollbar track. */
function useHiddenFloatingScrollbar(rootRef) {
  useEffect(() => {
    const body = rootRef.current && rootRef.current.parentElement
    if (!body) return undefined

    const marker = 'data-hermes-yt-plugin-scroll'
    const hadMarker = body.hasAttribute(marker)
    const previousWidth = body.style.scrollbarWidth
    const style = document.createElement('style')
    style.textContent = `[${marker}]::-webkit-scrollbar { display: none; width: 0; height: 0; }`
    document.head.appendChild(style)
    body.setAttribute(marker, '')
    body.style.scrollbarWidth = 'none'

    return () => {
      style.remove()
      body.style.scrollbarWidth = previousWidth
      if (!hadMarker) body.removeAttribute(marker)
    }
  }, [rootRef])
}

function Overlay({ storage }) {
  const rootRef = useRef(null)
  const src = useValue($src)
  const current = useValue($current)
  const favourites = useValue($favourites)
  const history = useValue($history)
  const libraryOpen = useValue($libraryOpen)
  const showRecents = useValue($showRecents)

  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [searching, setSearching] = useState(false)
  const { anchorRef, search } = useYouTubeSearch()

  const trimmed = query.trim()
  const asLink = parseTarget(trimmed)
  const wantsSearch = trimmed.length >= 2 && !asLink

  // Debounced so a fetch doesn't fire on every keystroke.
  useEffect(() => {
    if (!wantsSearch) {
      setResults([])
      setSearching(false)
      return undefined
    }
    setSearching(true)
    let cancelled = false
    const timer = setTimeout(async () => {
      const found = await search(trimmed)
      if (cancelled) return
      setResults(found)
      setSearching(false)
    }, SEARCH_DEBOUNCE_MS)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // `search` is stable for the life of the worker.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, wantsSearch])

  const play = (url) => {
    $src.set(url)
    $current.set({ url, title: null })
    storage.set(SRC_KEY, url)
    $libraryOpen.set(false)
    setQuery('')
    setResults([])
  }

  // The webview navigates itself (queue advances, clicks inside the player), so
  // the thing worth starring is whatever it is showing — not what was typed.
  const onNavigate = (url) => {
    if (!url) return
    const previous = $current.get()
    $current.set({ url, title: previous.url === url ? previous.title : null })
  }

  const onTitle = (title) => {
    const url = $current.get().url
    $current.set({ url, title })
    if (!isWatchUrl(url) || !title) return
    const key = entryKey(url)
    const next = [{ url, title }, ...$history.get().filter((e) => entryKey(e.url) !== key)].slice(
      0,
      HISTORY_CAP
    )
    $history.set(next)
    storage.set(HISTORY_KEY, next)
  }

  const submit = () => {
    if (asLink) {
      play(buildPlayUrl(asLink))
      return
    }
    // Enter takes the top result — the dropdown is the search UI, so there's no
    // reason to send a results page to the player.
    if (results.length) play(watchUrlFor(results[0].id))
  }

  const panelOpen = wantsSearch || libraryOpen
  const panelTransition = usePanelTransition(panelOpen)
  const canStar = isWatchUrl(current.url)
  const starred =
    canStar && favourites.some((entry) => entryKey(entry.url) === entryKey(current.url))

  const toggleStar = () => {
    if (!canStar) return
    const key = entryKey(current.url)
    const next = starred
      ? favourites.filter((entry) => entryKey(entry.url) !== key)
      : [...favourites, { url: current.url, title: current.title || current.url }]
    $favourites.set(next)
    storage.set(FAVOURITES_KEY, next)
  }

  const removeFavourite = (url) => {
    const next = favourites.filter((entry) => entryKey(entry.url) !== entryKey(url))
    $favourites.set(next)
    storage.set(FAVOURITES_KEY, next)
  }

  const removeHistory = (url) => {
    const next = history.filter((entry) => entryKey(entry.url) !== entryKey(url))
    $history.set(next)
    storage.set(HISTORY_KEY, next)
  }

  const resizeState = useFallbackFloatingResize(rootRef, storage)
  useAutoSizeFloatingPane(
    rootRef,
    panelTransition.expanded,
    resizeState.manualHeightRef,
    resizeState.resizingRef
  )
  useHiddenFloatingScrollbar(rootRef)

  return jsxs('div', {
    ref: rootRef,
    style: {
      position: 'relative',
      display: 'flex',
      flexDirection: 'column',
      gap: '6px',
      padding: '4px 8px 6px',
      boxSizing: 'border-box',
      height: resizeState.manuallySized ? '100%' : undefined,
      // Content height drives the closed pane fit. The shell's scroll area is
      // still available when an expanded list reaches the viewport limit.
      minHeight: 0,
    },
    children: [
      // Anchor for the hidden search worker.
      jsx('div', { ref: anchorRef, style: { position: 'absolute', width: 0, height: 0 } }),

      src
        ? jsx(Player, {
            src,
            constrained: resizeState.manuallySized && !panelOpen,
            onNavigate,
            onTitle,
          })
        : jsx('div', {
            style: {
              display: 'grid',
              placeItems: 'center',
              width: '100%',
              aspectRatio: '16 / 9',
              maxHeight: 'calc(100vh - 96px)',
              flex: resizeState.manuallySized && !panelOpen ? '0 1 auto' : '0 0 auto',
              minHeight: resizeState.manuallySized && !panelOpen ? '100px' : undefined,
              borderRadius: '4px',
              fontSize: '0.6875rem',
              textAlign: 'center',
              color: 'var(--ui-text-quaternary)',
              background: 'color-mix(in srgb, var(--ui-text-primary) 5%, transparent)',
            },
            children: 'Search for something, or paste a YouTube link',
          }),

      jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          flex: '0 0 auto',
          gap: '4px',
          marginTop: '4px',
        },
        children: [
          jsx('input', {
            value: query,
            placeholder: 'Search YouTube, or paste a link',
            'aria-label': 'Search YouTube, or paste a link',
            spellCheck: false,
            'data-floating-no-drag': '',
            style: {
              minWidth: 0,
              flex: 1,
              height: '24px',
              padding: '0 6px',
              fontSize: '0.6875rem',
              color: 'var(--ui-text-primary)',
              background: 'color-mix(in srgb, var(--ui-text-primary) 7%, transparent)',
              border: '1px solid color-mix(in srgb, var(--ui-text-primary) 14%, transparent)',
              borderRadius: '4px',
              outline: 'none',
            },
            onChange: (event) => setQuery(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') submit()
              if (event.key === 'Escape') {
                setQuery('')
                setResults([])
              }
            },
          }),
          jsx(Tip, {
            label: asLink ? 'Play this link' : 'Play the top result',
            children: jsx('button', {
              type: 'button',
              'aria-label': 'Play',
              'data-floating-no-drag': '',
              onClick: submit,
              style: iconButtonStyle(false),
              children: jsx(Codicon, { name: 'play', size: '0.75rem' }),
            }),
          }),
          jsx(Tip, {
            label: canStar
              ? starred
                ? 'Remove from favourites'
                : 'Add to favourites'
              : 'Play something to favourite it',
            children: jsx('button', {
              type: 'button',
              'aria-label': starred ? 'Remove from favourites' : 'Add to favourites',
              'aria-pressed': starred,
              disabled: !canStar,
              'data-floating-no-drag': '',
              onClick: () => {
                haptic('tap')
                toggleStar()
              },
              style: { ...iconButtonStyle(starred), opacity: canStar ? 1 : 0.4 },
              children: jsx(Codicon, {
                name: starred ? 'star-full' : 'star-empty',
                size: '0.75rem',
              }),
            }),
          }),
          jsx(Tip, {
            label: libraryOpen ? 'Hide favourites and recent' : 'Favourites and recent',
            children: jsx('button', {
              type: 'button',
              'aria-label': 'Favourites and recent',
              'aria-expanded': libraryOpen,
              'data-floating-no-drag': '',
              onClick: () => {
                haptic('tap')
                $libraryOpen.set(!libraryOpen)
              },
              style: iconButtonStyle(libraryOpen),
              children: jsx(Codicon, {
                name: libraryOpen ? 'chevron-up' : 'list-unordered',
                size: '0.75rem',
              }),
            }),
          }),
          jsx(SettingsMenu, { storage }),
        ],
      }),

      // The flexible child: everything under the controls absorbs the leftover
      // height and scrolls when there isn't enough, so the video box never gets
      // squeezed. Typing beats the library — the dropdown is what was asked for.
      // Animated grow/shrink. `height: auto` isn't transitionable, so this uses
      // the grid-rows technique: 0fr → 1fr interpolates, and the inner wrapper's
      // `min-height: 0` lets it actually collapse. The content stays mounted so
      // BOTH directions animate — unmounting it would make the shrink instant.
      //
      // useAutoSizeFloatingPane grows the shell card with this content when
      // possible. The shell's scroll area remains the fallback when the list is
      // taller than the available viewport.
      jsx('div', {
        style: {
          flex: '0 0 auto',
          display: 'grid',
          gridTemplateRows: panelTransition.expanded ? '1fr' : '0fr',
          opacity: panelTransition.contentVisible ? 1 : 0,
          pointerEvents: panelTransition.contentVisible ? 'auto' : 'none',
          transition: prefersReducedMotion()
            ? 'none'
            : `grid-template-rows ${PANEL_RESIZE_MS}ms cubic-bezier(0.2, 0, 0.2, 1), opacity ${PANEL_FADE_MS}ms ease`,
        },
        children: jsx('div', {
          style: { minHeight: 0, overflow: 'hidden' },
          children: wantsSearch
            ? jsx(Results, { results, searching, query: trimmed, onPlay: play })
            : jsx(Library, {
                favourites,
                history,
                showRecents,
                onPlay: play,
                onRemoveFavourite: removeFavourite,
                onRemoveHistory: removeHistory,
              }),
        }),
      }),
    ],
  })
}

function SettingsMenu({ storage }) {
  const showRecents = useValue($showRecents)

  return jsxs(Popover, {
    children: [
      jsx(Tip, {
        label: 'hermes-yt-plugin settings',
        children: jsx(PopoverTrigger, {
          asChild: true,
          children: jsx('button', {
            type: 'button',
            'aria-label': 'hermes-yt-plugin settings',
            'data-floating-no-drag': '',
            style: iconButtonStyle(false),
            children: jsx(Codicon, { name: 'settings-gear', size: '0.75rem' }),
          }),
        }),
      }),
      jsx(PopoverContent, {
        align: 'end',
        side: 'bottom',
        style: { width: '176px', padding: '8px' },
        children: jsxs('div', {
          style: {
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
            fontSize: '0.6875rem',
            color: 'var(--ui-text-secondary)',
          },
          children: [
            jsx('label', { htmlFor: 'hermes-yt-plugin-show-recents', children: 'Show recents' }),
            jsx(Switch, {
              id: 'hermes-yt-plugin-show-recents',
              size: 'xs',
              checked: showRecents,
              onCheckedChange: (next) => {
                haptic('tap')
                $showRecents.set(next)
                storage.set(SHOW_RECENTS_KEY, next)
              },
            }),
          ],
        }),
      }),
    ],
  })
}

function StatusChip({ onToggle }) {
  const open = useValue($floatingOpen)
  const src = useValue($src)

  return jsx(Tip, {
    label: open ? 'Hide hermes-yt-plugin' : 'Show hermes-yt-plugin',
    children: jsx('button', {
      type: 'button',
      style: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '4px',
        height: '100%',
        padding: '0 6px',
        fontSize: '0.6875rem',
        color: 'var(--ui-text-tertiary)',
        opacity: open ? 1 : 0.8,
      },
      onClick: () => {
        haptic('tap')
        onToggle()
      },
      children: [jsx(Codicon, { name: src ? 'play' : 'device-camera-video', size: '0.75rem' })],
    }),
  })
}

export default {
  id: ID,
  name: 'hermes-yt-plugin',
  register(ctx) {
    $floatingOpen.set(ctx.storage.get(OPEN_KEY, true) !== false)
    const storedSrc = ctx.storage.get(SRC_KEY, null) || null
    $src.set(storedSrc)
    $current.set({ url: storedSrc, title: null })
    $favourites.set(ctx.storage.get(FAVOURITES_KEY, []) || [])
    $history.set(ctx.storage.get(HISTORY_KEY, []) || [])
    $showRecents.set(ctx.storage.get(SHOW_RECENTS_KEY, true) !== false)

    /** @type {null | (() => void)} */
    let disposePane = null

    const setOpen = (next) => {
      $floatingOpen.set(next)
      ctx.storage.set(OPEN_KEY, next)
      // Registry `when` is not reactive — re-register to show/hide.
      if (next) {
        if (!disposePane) {
          disposePane = ctx.register({
            id: 'screen',
            area: 'panes',
            title: 'YouTube',
            data: {
              placement: 'floating',
              anchor: 'bottom-right',
              // Close to 16:9 for the player area, so letterboxing is minimal at
              // the default size. Resizing toward 16:9 removes it entirely.
              width: '420px',
              height: '312px',
            },
            render: () => jsx(Overlay, { storage: ctx.storage }),
          })
        }
      } else if (disposePane) {
        disposePane()
        disposePane = null
      }
    }

    if ($floatingOpen.get()) setOpen(true)

    ctx.register({
      id: 'chip',
      area: 'statusBar.right',
      order: 130,
      render: () => jsx(StatusChip, { onToggle: () => setOpen(!$floatingOpen.get()) }),
    })

    ctx.registerMany([
      {
        id: 'show',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-yt-plugin.show',
          label: 'Show hermes-yt-plugin',
          keywords: ['media', 'youtube', 'music', 'player', 'overlay'],
          run: () => setOpen(true),
        },
      },
      {
        id: 'hide',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-yt-plugin.hide',
          label: 'Hide hermes-yt-plugin',
          keywords: ['media', 'youtube', 'music', 'stop', 'hide'],
          run: () => setOpen(false),
        },
      },
      {
        id: 'favourites',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-yt-plugin.favourites',
          label: 'Open hermes-yt-plugin library',
          keywords: ['media', 'youtube', 'favourites', 'favorites', 'recent'],
          run: () => {
            setOpen(true)
            $libraryOpen.set(true)
          },
        },
      },
      {
        id: 'clear',
        area: PALETTE_AREA,
        data: {
          id: 'hermes-yt-plugin.clear',
          label: 'Clear hermes-yt-plugin',
          keywords: ['media', 'youtube', 'clear', 'stop'],
          run: () => {
            $src.set(null)
            $current.set({ url: null, title: null })
            ctx.storage.set(SRC_KEY, null)
            host.notify({ kind: 'info', message: 'hermes-yt-plugin cleared' })
          },
        },
      },
    ])
  },
}
