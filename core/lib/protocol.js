const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const z32 = require('z32')
const id = require('hypercore-id-encoding')

const MAX_MESSAGE = 2 * 1024 * 1024

const DOMAIN = b4a.from('pear-pen/activity/v1')
const DEVICE = b4a.from('pear-pen/device/v1')

function digest(event) {
  return crypto.hash([DOMAIN, b4a.from(JSON.stringify(event))])
}

function create(identity, pen, payload, clock) {
  const data = {
    version: 1,
    pen,
    author: identity.publicKey,
    deviceKey: identity.deviceKey,
    certificate: identity.certificate,
    clock,
    nonce: crypto.randomBytes(16).toString('hex'),
    at: Date.now(),
    ...payload
  }
  const hash = digest(data)
  const secret = z32.decode(identity.deviceSecret)
  try {
    return {
      id: hash.toString('hex'),
      data,
      signature: z32.encode(crypto.sign(hash, secret))
    }
  } finally {
    secret.fill(0)
  }
}

function verify(event, pen, signers) {
  try {
    const data = event.data
    if (
      data.version !== 1 ||
      data.pen !== pen ||
      !signers.includes(data.author)
    )
      return false
    if (
      !Number.isSafeInteger(data.clock) ||
      data.clock < 1 ||
      data.clock > 1e12 ||
      !Number.isSafeInteger(data.at) ||
      data.at < 0
    )
      return false
    if (!['request', 'response', 'review', 'commit'].includes(data.type))
      return false
    if (
      data.authorName !== undefined &&
      (typeof data.authorName !== 'string' || data.authorName.length > 120)
    )
      return false
    if (typeof data.nonce !== 'string' || !/^[a-f\d]{32}$/.test(data.nonce))
      return false
    const hash = digest(data)
    if (event.id !== hash.toString('hex')) return false
    const device = z32.decode(data.deviceKey)
    if (
      !crypto.verify(
        crypto.hash([DEVICE, device]),
        z32.decode(data.certificate),
        z32.decode(data.author)
      )
    )
      return false
    return crypto.verify(hash, z32.decode(event.signature), device)
  } catch {
    return false
  }
}

function compare(a, b) {
  return a.data.clock - b.data.clock || a.id.localeCompare(b.id)
}

function normalizeKey(value) {
  if (typeof value !== 'string') throw new Error('Enter a drive key')
  try {
    return id.normalize(
      value
        .trim()
        .replace(/^pear:\/\//, '')
        .replace(/\/$/, '')
    )
  } catch {
    throw new Error('Enter a valid Hypercore key or pear:// link')
  }
}

function parseSource(value) {
  if (typeof value !== 'string')
    throw new Error('Enter a source drive key or link')
  try {
    const input = value.trim()
    const linked = input.startsWith('pear://')
    const source = (linked ? input.slice(7) : input).replace(/\/$/, '')
    if (/[\/\\?#]/.test(source)) throw new Error()
    const parts = source.split('.')
    if (parts.length === 1) {
      const key = id.normalize(source)
      return { key, fork: null, length: null, link: key }
    }
    if (!linked || parts.length !== 3) throw new Error()
    const [forkValue, lengthValue, keyValue] = parts
    if (!/^\d+$/.test(forkValue) || !/^\d+$/.test(lengthValue))
      throw new Error()
    const fork = Number(forkValue)
    const length = Number(lengthValue)
    if (!Number.isSafeInteger(fork) || !Number.isSafeInteger(length))
      throw new Error()
    const key = id.normalize(keyValue)
    return { key, fork, length, link: `pear://${fork}.${length}.${key}` }
  } catch {
    throw new Error('Enter a valid source key or pear://fork.length.key link')
  }
}

function normalizeSource(value) {
  return parseSource(value).link
}

function cleanEncoded(value) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > MAX_MESSAGE / 2
  )
    throw new Error('Enter a valid signing request or response')
  return value.trim()
}

function requestHash(request) {
  return crypto.hash(z32.decode(request)).toString('hex')
}

module.exports = {
  create,
  verify,
  compare,
  MAX_MESSAGE,
  cleanEncoded,
  normalizeKey,
  parseSource,
  normalizeSource,
  requestHash
}
