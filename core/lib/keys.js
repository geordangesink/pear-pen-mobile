const b4a = require('b4a')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const { EncryptedKey } = require('hypercore-sign-v4/lib/encoding')
const sodium = require('sodium-native')
const z32 = require('z32')

// hypercore-sign v3 compatibility: new encrypted backups use the unversioned key envelope.
const encryptedKey = {
  preencode(state, key) {
    c.uint64.preencode(state, key.ops)
    c.uint64.preencode(state, key.mem)
    c.fixed32.preencode(state, key.salt)
    c.buffer.preencode(state, key.payload)
  },
  encode(state, key) {
    c.uint64.encode(state, key.ops)
    c.uint64.encode(state, key.mem)
    c.fixed32.encode(state, key.salt)
    c.buffer.encode(state, key.payload)
  },
  decode(state) {
    return {
      ops: c.uint64.decode(state),
      mem: c.uint64.decode(state),
      salt: c.fixed32.decode(state),
      payload: c.buffer.decode(state)
    }
  }
}

function decode(value) {
  if (typeof value !== 'string' || value.length > 4096)
    throw new Error('Invalid key')
  const text = value.trim()
  if (/^[a-f\d]+$/i.test(text) && text.length % 2 === 0)
    return b4a.from(text, 'hex')
  try {
    return z32.decode(text)
  } catch {
    throw new Error('Use a hexadecimal or z-base-32 key')
  }
}

function validateSecret(secret) {
  const pair = crypto.keyPair(secret.subarray(0, 32))
  try {
    if (!b4a.equals(pair.secretKey, secret))
      throw new Error('Invalid Ed25519 private key')
  } finally {
    pair.secretKey.fill(0)
  }
}

function unlock(value, password) {
  const data = decode(value)
  if (data.length === 32) {
    const pair = crypto.keyPair(data)
    data.fill(0)
    return pair.secretKey
  }
  if (data.length === 64) {
    try {
      validateSecret(data)
    } catch (error) {
      data.fill(0)
      throw error
    }
    return data
  }
  if (typeof password !== 'string' || !password.length) {
    const error = new Error(
      'Enter the password for your hypercore-sign private key'
    )
    error.code = 'PASSWORD_REQUIRED'
    throw error
  }
  // hypercore-sign v3 compatibility: 153-byte backups omit the version and public key.
  const legacy = data.length === 153
  if (!legacy && data.length !== 186)
    throw new Error('Invalid hypercore-sign private key')
  let key
  try {
    key = c.decode(legacy ? encryptedKey : EncryptedKey, data)
  } catch {
    throw new Error('Invalid hypercore-sign private key')
  }
  if (!legacy && key.version !== 1)
    throw new Error('Unsupported private key version')
  const { ops, mem } = key.params || key
  if (
    key.payload.length !== 104 ||
    !Number.isSafeInteger(ops) ||
    !Number.isSafeInteger(mem) ||
    ops < 32768 ||
    ops > 2147483648 ||
    mem < 16777216 ||
    mem > 1073741824
  )
    throw new Error('Unsupported private key encryption parameters')
  const out = b4a.alloc(104)
  const pwd = b4a.from(password)
  try {
    sodium.crypto_pwhash_scryptsalsa208sha256(out, pwd, key.salt, ops, mem)
    for (let i = 0; i < out.length; i++) out[i] ^= key.payload[i]
    if (!b4a.equals(crypto.hash(out.subarray(0, 72)), out.subarray(72)))
      throw new Error('Incorrect private key password')
    const secret = out.subarray(8, 72)
    validateSecret(secret)
    if (key.publicKey && !b4a.equals(key.publicKey, secret.subarray(32)))
      throw new Error('The public and private keys do not match')
    return b4a.from(secret)
  } finally {
    out.fill(0)
    pwd.fill(0)
    data.fill(0)
  }
}

function importIdentity({ publicKey, secretKey, password } = {}) {
  const publicText = optionalKey(publicKey)
  let secretText = optionalKey(secretKey)
  if (publicText && !secretText)
    throw new Error('Import the private key that belongs to this public key')
  let pub = publicText ? decode(publicText) : null
  if (pub && pub.length !== 32)
    throw new Error('Public key must contain 32 bytes')
  const secret = secretText
    ? unlock(secretText, password)
    : crypto.keyPair().secretKey
  try {
    if (!secretText) secretText = encrypt(secret, password)
    if (!pub) pub = b4a.from(secret.subarray(32))
    if (
      !crypto.verify(
        b4a.from('pear-pen/import/v1'),
        crypto.sign(b4a.from('pear-pen/import/v1'), secret),
        pub
      )
    )
      throw new Error('The public and private keys do not match')
    const device = crypto.keyPair()
    const certificate = z32.encode(
      crypto.sign(
        crypto.hash([b4a.from('pear-pen/device/v1'), device.publicKey]),
        secret
      )
    )
    const encoded = decode(secretText)
    try {
      return {
        publicKey: z32.encode(pub),
        secretKey: secretText,
        encrypted: encoded.length > 64,
        deviceKey: z32.encode(device.publicKey),
        deviceSecret: z32.encode(device.secretKey),
        certificate
      }
    } finally {
      encoded.fill(0)
      device.secretKey.fill(0)
    }
  } finally {
    secret.fill(0)
  }
}

function optionalKey(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > 4096)
    throw new Error('Invalid key')
  return value.trim()
}

function encrypt(secret, password) {
  if (typeof password !== 'string' || b4a.byteLength(password) < 8)
    throw new Error('Use a password of at least 8 bytes')
  const payload = b4a.alloc(104)
  const mask = b4a.alloc(104)
  const pwd = b4a.from(password)
  const salt = crypto.randomBytes(32)
  const ops = sodium.crypto_pwhash_scryptsalsa208sha256_OPSLIMIT_INTERACTIVE
  const mem = sodium.crypto_pwhash_scryptsalsa208sha256_MEMLIMIT_INTERACTIVE
  try {
    crypto.randomBytes(8).copy(payload)
    secret.copy(payload, 8)
    crypto.hash(payload.subarray(0, 72)).copy(payload, 72)
    sodium.crypto_pwhash_scryptsalsa208sha256(mask, pwd, salt, ops, mem)
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i]
    // hypercore-sign v3 compatibility: retain the legacy backup for newly encrypted identities.
    return z32.encode(c.encode(encryptedKey, { ops, mem, salt, payload }))
  } finally {
    payload.fill(0)
    mask.fill(0)
    pwd.fill(0)
  }
}

function exportIdentity(identity, { kind, password }) {
  if (kind === 'public')
    return { name: 'default.public', key: identity.publicKey, encrypted: false }
  if (kind !== 'private')
    throw new Error('Choose a public or private key export')
  if (password === undefined || identity.encrypted)
    return {
      name: 'default',
      key: identity.secretKey,
      encrypted: identity.encrypted
    }
  const secret = unlock(identity.secretKey)
  try {
    return { name: 'default', key: encrypt(secret, password), encrypted: true }
  } finally {
    secret.fill(0)
  }
}

module.exports = {
  decode,
  unlock,
  importIdentity,
  exportIdentity,
  encryptedKey
}
