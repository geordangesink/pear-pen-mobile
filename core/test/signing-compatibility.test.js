const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const test = require('node:test')
const c = require('compact-encoding')
const Hyperdrive = require('hyperdrive')
const Multisig = require('hyper-multisig')
const { EncryptedKey } = require('hypercore-sign-v4/lib/encoding')
const SignV4 = require('hypercore-sign-v4')
// hypercore-sign v3 compatibility: independently verify the legacy envelope.
const LegacySign = require('hypercore-sign')
const {
  generateKeys: generateLegacyKeys
} = require('hypercore-sign/lib/secure')
const SigningRequest = require('hypercore-signing-request')
const sodium = require('sodium-native')
const z32 = require('z32')
const PearPen = require('..')
const keys = require('../lib/keys')

const password = 'temporary test password'

function securePassword() {
  const value = sodium.sodium_malloc(Buffer.byteLength(password))
  value.write(password)
  return value
}

// hypercore-sign v3 compatibility: use the CLI's real generator and its original KDF settings.
function legacyIdentity() {
  const pair = generateLegacyKeys(securePassword())
  return {
    publicKey: z32.encode(pair.publicKey),
    secretKey: z32.encode(pair.secretKey)
  }
}

function versionedBackup(identity) {
  const { ops, mem, payload, salt } = c.decode(
    keys.encryptedKey,
    z32.decode(identity.secretKey)
  )
  return c.encode(EncryptedKey, {
    params: { ops, mem },
    payload,
    salt,
    version: 1,
    publicKey: z32.decode(identity.publicKey)
  })
}

test('encrypted key imports reject trailing data and mismatched embedded public keys', () => {
  const identity = keys.importIdentity({ password })
  const backup = versionedBackup(identity)
  for (const encrypted of [backup, z32.decode(identity.secretKey)]) {
    const padded = z32.encode(Buffer.concat([encrypted, Buffer.alloc(1)]))
    assert.throws(() => keys.unlock(padded, password))
  }
  const corrupt = Buffer.from(backup)
  corrupt[corrupt.length - 1] ^= 1
  assert.throws(
    () => keys.unlock(z32.encode(corrupt), password),
    /do not match/
  )
})

for (const legacy of [true, false]) {
  const version = legacy ? 2 : 3
  test(`hyper-multisig wire v${version} interoperates through signing, verification and commit`, async (t) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pear-pen-interop-'))
    const engine = new PearPen({ dir, network: false })
    t.after(async () => {
      await engine.close()
      rmSync(dir, { recursive: true, force: true })
    })
    // hypercore-sign v3 compatibility: sign a current request with an original CLI backup.
    const alice = legacy ? keys.importIdentity({ password }) : legacyIdentity()
    const bob = keys.importIdentity({ password })
    const publicKeys = [alice.publicKey, bob.publicKey]
    const namespace = 'test/hyper-multisig'
    await engine.command('profile.import', {
      secretKey: legacy ? z32.encode(versionedBackup(alice)) : alice.secretKey,
      password
    })
    assert.equal(engine.snapshot().profile.publicKey, alice.publicKey)
    const upstream = new Multisig(engine.store, { join() {} })
    const writer = new Hyperdrive(engine.store.namespace('source'))
    await writer.ready()
    await writer.put('/release.txt', Buffer.from('verified content'))
    const srcKey = z32.encode(writer.key)
    await writer.close()
    const source = await engine._source(srcKey)
    const penId = z32.encode(Multisig.getCoreKey(publicKeys, namespace))
    await engine.command('pen.add', { multisigKey: penId })
    const { request: encoded } = await upstream
      .requestDrive(publicKeys, namespace, source, source.core.length, {
        force: true,
        legacy
      })
      .done()
    const request = z32.encode(encoded)
    const before = engine.snapshot()
    await assert.rejects(
      engine.command('manual.response', { penId, request, password: 'wrong' }),
      /Incorrect private key password/
    )
    assert.deepEqual(engine.snapshot(), before)
    const { output: first } = await engine.command('manual.response', {
      penId,
      request,
      password
    })
    assert.equal(
      SigningRequest.decodeResponse(z32.decode(first)).version,
      version
    )
    SignV4.verify(z32.decode(first), encoded, z32.decode(alice.publicKey))
    if (legacy) await LegacySign.verify(first, request, alice.publicKey)
    const second = z32.encode(
      SignV4.sign(encoded, versionedBackup(bob), securePassword())
    )
    const verify = {
      penId,
      request,
      response: second,
      publicKey: bob.publicKey
    }
    assert.equal((await engine.command('manual.verify', verify)).verified, true)
    await assert.rejects(
      engine.command('manual.verify', {
        ...verify,
        publicKey: alice.publicKey
      }),
      /Public key does not match/
    )
    const { request: other } = await upstream
      .requestDrive(publicKeys, namespace, source, source.core.length, {
        force: true,
        legacy: !legacy
      })
      .done()
    await assert.rejects(
      engine.command('manual.verify', {
        ...verify,
        request: z32.encode(other)
      }),
      /not made over this request/
    )
    const options = { penId, srcKey, request, responses: [second, first] }
    const review = await engine.command('manual.review', options)
    assert.equal(review.quorum, 2)
    assert.deepEqual(
      review.files.map((f) => f.path),
      ['/release.txt']
    )
    const proof = await upstream
      .verifyDrive(publicKeys, namespace, source, request, options.responses, {
        force: true
      })
      .done()
    assert.equal(proof.quorum, 2)
    assert.ok(proof.result.db.batch.signature)
    assert.ok(proof.result.blobs.batch.signature)
    const committed = await engine.command('manual.commit', {
      ...options,
      confirmation: 'COMMIT'
    })
    assert.equal(committed.committed, true)
    assert.equal(
      (await engine.rooms.get(penId).target.get('/release.txt')).toString(),
      'verified content'
    )
  })
}
