// Shared drawing kit: colours, text helpers and the animated SVG primitives
// (SMIL animations, so they move inside the pane's script-less frame).
'use strict'

const C = {
  bg: '#1c1b19', card: '#2a2926', line: '#45433e', tx: '#ece9df', mu: '#a29f95', dim: '#6f6c64',
  or: '#d97757', orl: '#f2a283', orb: '#3a2820', rd: '#e5634f', rdl: '#f3b1a6', rdb: '#3d211d',
  gr: '#8bbf6e', grl: '#c5e3b2', grb: '#22301d', am: '#e3ab4f',
}
const FONT = 'system-ui,Segoe UI,sans-serif'
const NEW_MS = 120000

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
function short(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? s.slice(0, n - 1) + '…' : s
}

function kit(out) {
  const T = (x, yy, s, o = {}) => out.push(`<text x="${x}" y="${yy}" fill="${o.fill || C.tx}" font-size="${o.size || 12}" font-weight="${o.w || 400}" text-anchor="${o.anchor || 'start'}" font-family="${FONT}"${o.ls ? ` letter-spacing="${o.ls}"` : ''}>${esc(s)}</text>`)
  const R = (x, yy, w, h, o = {}) => out.push(`<rect x="${x}" y="${yy}" width="${w}" height="${h}" rx="${o.rx ?? 9}" fill="${o.fill || 'url(#gCard)'}" stroke="${o.stroke || C.line}" stroke-width="${o.sw || 1}"${o.dash ? ` stroke-dasharray="${o.dash}"` : ''}${o.filter ? ` filter="url(#${o.filter})"` : ''}>${o.title ? `<title>${esc(o.title)}</title>` : ''}${o.pulse ? `<animate attributeName="stroke-opacity" values="1;0.3;1" dur="${o.pulse === true ? '1.4s' : o.pulse}" repeatCount="indefinite"/>` : ''}${o.anim || ''}</rect>`)
  const flow = (d, color, dur) => out.push(`<path d="${d}" stroke="${color}" stroke-width="1.6" fill="none" stroke-dasharray="3 9" stroke-linecap="round"><animate attributeName="stroke-dashoffset" values="24;0" dur="${dur}" repeatCount="indefinite"/></path>`)
  const particle = (d, color, dur, begin, r) => out.push(`<circle r="${r}" fill="${color}" filter="url(#gOr)"><animateMotion dur="${dur}" begin="${begin}" repeatCount="indefinite" path="${d}"/><animate attributeName="opacity" values="0;1;1;0" dur="${dur}" begin="${begin}" repeatCount="indefinite"/></circle>`)
  const spinner = (cx, cy, color, r) => out.push(`<g transform="translate(${cx} ${cy})"><circle r="${r}" fill="none" stroke="${color}" stroke-opacity="0.25" stroke-width="2"/><circle r="${r}" fill="none" stroke="${color}" stroke-width="2" stroke-dasharray="${(r * 2.2).toFixed(1)} ${(r * 4.1).toFixed(1)}" stroke-linecap="round"><animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="0.9s" repeatCount="indefinite"/></circle></g>`)
  const dots = (x, yy, color) => [0, 1, 2].forEach(k => out.push(`<circle cx="${x + k * 7}" cy="${yy}" r="2" fill="${color}"><animate attributeName="opacity" values="0.2;1;0.2" dur="1.2s" begin="${k * 0.2}s" repeatCount="indefinite"/></circle>`))
  const ring = (cx, cy, r0, r1, color, dur) => out.push(`<circle cx="${cx}" cy="${cy}" r="${r0}" fill="none" stroke="${color}" stroke-width="1.5"><animate attributeName="r" values="${r0};${r1}" dur="${dur}" repeatCount="indefinite"/><animate attributeName="opacity" values="0.9;0" dur="${dur}" repeatCount="indefinite"/></circle>`)

  return { out, T, R, flow, particle, spinner, dots, ring }
}

// rx 0 for a tile that sits flush against others (the cards of a column)
function wrap(W, y, out, rx = 14) {
  const defs = '<defs>' +
    '<pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="1.5" cy="1.5" r="1" fill="#2c2b28"/></pattern>' +
    '<linearGradient id="gCard" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2f2e2b"/><stop offset="1" stop-color="#252422"/></linearGradient>' +
    '<linearGradient id="gMain" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4a2c21"/><stop offset="1" stop-color="#2f211b"/></linearGradient>' +
    '<linearGradient id="gFail" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#4d2520"/><stop offset="1" stop-color="#2f1a17"/></linearGradient>' +
    `<filter id="gOr" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="${C.or}" flood-opacity="0.55"/></filter>` +
    `<filter id="gRd" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="${C.rd}" flood-opacity="0.6"/></filter>` +
    `<filter id="gGr" x="-40%" y="-40%" width="180%" height="180%"><feDropShadow dx="0" dy="0" stdDeviation="4" flood-color="${C.gr}" flood-opacity="0.5"/></filter>` +
    '<marker id="a" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M2 1L8 5L2 9" fill="none" stroke="#77746c" stroke-width="1.6"/></marker>' +
    `<marker id="ao" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M2 1L8 5L2 9" fill="none" stroke="${C.or}" stroke-width="1.6"/></marker>` +
    '</defs>'

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${y}" width="${W}" height="${y}">${defs}<rect width="${W}" height="${y}" rx="${rx}" fill="${C.bg}"/><rect width="${W}" height="${y}" rx="${rx}" fill="url(#dots)"/>${out.join('')}</svg>`
}

module.exports = { C, FONT, esc, short, kit, wrap }
