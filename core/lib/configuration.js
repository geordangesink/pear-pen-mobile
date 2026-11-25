const b4a = require('b4a')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const id = require('hypercore-id-encoding')

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function key(value, label) {
  try {
    if (typeof value !== 'string') throw new Error()
    const decoded = id.decode(value.trim())
    if (decoded.length !== 32) throw new Error()
    return decoded
  } catch {
    throw new Error(`The configuration contains an invalid ${label}`)
  }
}

function quorum(value, signers) {
  if (!Number.isSafeInteger(value) || value < 1 || value > signers.length)
    throw new Error(
      'Quorum must be a whole number from 1 to the number of signers'
    )
  return value
}

function fields(value, allowed, label) {
  for (const name of Object.keys(value)) {
    if (!allowed.includes(name))
      throw new Error(`Unsupported ${label} field: ${name}`)
  }
}

function recipeManifest(multisig) {
  if (
    !object(multisig) ||
    typeof multisig.namespace !== 'string' ||
    !multisig.namespace.trim() ||
    !Array.isArray(multisig.publicKeys) ||
    multisig.publicKeys.length === 0
  )
    throw new Error(
      'The configuration needs a multisig namespace, publicKeys and a valid quorum'
    )
  const namespace = crypto.hash(b4a.from(multisig.namespace))
  const signers = multisig.publicKeys.map((publicKey) => ({
    signature: 'ed25519',
    publicKey: key(publicKey, 'public key'),
    namespace
  }))
  return {
    version: 1,
    hash: 'blake2b',
    quorum: quorum(multisig.quorum, signers),
    signers
  }
}

function rawManifest(value) {
  if (!object(value)) throw new Error('The manifest must be a JSON object')
  fields(
    value,
    [
      'version',
      'hash',
      'allowPatch',
      'quorum',
      'signers',
      'prologue',
      'linked',
      'userData'
    ],
    'manifest'
  )
  if (value.version !== undefined && value.version !== 1)
    throw new Error('Only version 1 multisig manifests are supported')
  if (value.hash !== undefined && value.hash !== 'blake2b')
    throw new Error('Only blake2b manifest hashes are supported')
  if (value.allowPatch !== undefined && typeof value.allowPatch !== 'boolean')
    throw new Error('Manifest allowPatch must be true or false')
  if (!Array.isArray(value.signers) || value.signers.length === 0)
    throw new Error('The manifest needs at least one signer')
  const signers = value.signers.map((signer) => {
    if (!object(signer))
      throw new Error('Each manifest signer must be an object')
    fields(signer, ['signature', 'namespace', 'publicKey'], 'signer')
    if (signer.signature !== undefined && signer.signature !== 'ed25519')
      throw new Error('Only ed25519 signer signatures are supported')
    return {
      signature: 'ed25519',
      publicKey: key(signer.publicKey, 'public key'),
      ...(signer.namespace !== undefined && {
        namespace: key(signer.namespace, 'signer namespace')
      })
    }
  })
  const manifest = {
    version: 1,
    hash: 'blake2b',
    allowPatch: value.allowPatch ?? false,
    quorum: quorum(value.quorum, signers),
    signers
  }
  if (value.prologue !== undefined && value.prologue !== null) {
    if (!object(value.prologue))
      throw new Error('Manifest prologue must be an object or null')
    fields(value.prologue, ['hash', 'length'], 'prologue')
    if (
      !Number.isSafeInteger(value.prologue.length) ||
      value.prologue.length < 0
    )
      throw new Error('Prologue length must be a nonnegative whole number')
    manifest.prologue = {
      hash: key(value.prologue.hash, 'prologue hash'),
      length: value.prologue.length
    }
  }
  if (value.linked !== undefined && value.linked !== null) {
    if (!Array.isArray(value.linked) || value.linked.length)
      throw new Error(
        'Linked cores require a version 2 manifest, which is unsupported'
      )
  }
  if (value.userData !== undefined && value.userData !== null)
    throw new Error(
      'Manifest userData requires version 2, which is unsupported'
    )
  return manifest
}

function parseConfiguration(value) {
  if (typeof value !== 'string' || b4a.byteLength(value) > 64 * 1024)
    throw new Error('Choose a pear.json file no larger than 64 KB')
  let parsed
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new Error('Choose a valid pear.json configuration file')
  }
  if (!object(parsed))
    throw new Error('The configuration must be a JSON object')
  if (parsed.multisig !== undefined && parsed.manifest !== undefined)
    throw new Error('Use either multisig or manifest, not both')
  const manifest = Hypercore.parseManifest(
    parsed.manifest !== undefined
      ? rawManifest(parsed.manifest)
      : recipeManifest(parsed.multisig)
  )
  if (
    new Set(manifest.signers.map((signer) => signer.publicKey.toString('hex')))
      .size !== manifest.signers.length
  )
    throw new Error('The configuration must use distinct public keys')
  return {
    config: value.trim(),
    manifest,
    multisigKey: id.normalize(Hypercore.key(manifest))
  }
}

function serializeManifest(manifest) {
  return {
    ...manifest,
    signers: manifest.signers.map((signer) => ({
      ...signer,
      namespace: id.normalize(signer.namespace),
      publicKey: id.normalize(signer.publicKey)
    })),
    prologue: manifest.prologue && {
      ...manifest.prologue,
      hash: id.normalize(manifest.prologue.hash)
    },
    linked: manifest.linked?.map((linked) => id.normalize(linked)) ?? null,
    userData: manifest.userData ? b4a.toString(manifest.userData, 'hex') : null
  }
}

function emptyConfiguration() {
  return JSON.stringify(
    { multisig: { namespace: '', publicKeys: [], quorum: 1 } },
    null,
    2
  )
}

function configurationMismatch(expectedKey, derivedKey) {
  const error = new Error(
    `This configuration does not match the multisig key. Expected pear://${expectedKey}; derived pear://${derivedKey}. The pen link cannot be changed.`
  )
  error.code = 'CONFIGURATION_KEY_MISMATCH'
  error.expectedKey = expectedKey
  error.derivedKey = derivedKey
  return error
}

module.exports = {
  parseConfiguration,
  serializeManifest,
  emptyConfiguration,
  configurationMismatch
}
