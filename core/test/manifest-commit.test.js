const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const test = require('node:test')
const Hypercore = require('hypercore')
const crypto = require('hypercore-crypto')
const SigningRequest = require('hypercore-signing-request')
const Hyperdrive = require('hyperdrive')
const z32 = require('z32')
const PearPen = require('..')

test('a link-only pen commits a cold historical snapshot with distinct signer namespaces', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pear-pen-manifest-commit-'))
  const publisher = new PearPen({
    dir: path.join(dir, 'publisher'),
    network: false
  })
  const reviewer = new PearPen({
    dir: path.join(dir, 'reviewer'),
    network: false
  })
  const pairs = [crypto.keyPair(), crypto.keyPair()]
  const manifest = Hypercore.parseManifest({
    version: 1,
    quorum: 2,
    signers: pairs.map(({ publicKey }) => ({
      publicKey,
      namespace: crypto.randomBytes(32)
    }))
  })
  const penId = z32.encode(Hypercore.key(manifest))
  t.after(async () => {
    await Promise.all([publisher.close(), reviewer.close()])
    rmSync(dir, { recursive: true, force: true })
  })
  for (const [index, engine] of [publisher, reviewer].entries()) {
    await engine.command('profile.import', {
      secretKey: z32.encode(pairs[index].secretKey)
    })
    await engine.command('pen.add', { multisigKey: penId })
  }
  const source = new Hyperdrive(publisher.store.namespace('source'))
  await source.ready()
  await source.put('/release.txt', Buffer.from('signed release'))
  const request = z32.encode(
    await SigningRequest.generateDrive(source, { manifest })
  )
  const metadataLength = source.core.length
  const contentLength = source.blobs.core.length
  const srcKey = `pear://${source.core.fork}.${metadataLength}.${source.id}`
  await source.put('/release.txt', Buffer.from('unreleased edit'))
  await source.put('/later.txt', Buffer.from('later'))

  const responses = await Promise.all(
    [publisher, reviewer].map(async (engine) => {
      const { output } = await engine.command('manual.response', {
        penId,
        request
      })
      return output
    })
  )
  const send = publisher.store.replicate(true)
  const receive = reviewer.store.replicate(false)
  send.pipe(receive).pipe(send)
  try {
    const result = await reviewer.command('manual.commit', {
      penId,
      srcKey,
      request,
      responses,
      confirmation: 'COMMIT'
    })
    assert.equal(result.committed, true)
  } finally {
    send.destroy()
    receive.destroy()
    await source.close()
  }
  const { target, contentCore } = reviewer.rooms.get(penId)
  assert.equal(target.core.length, metadataLength)
  assert.equal(contentCore.length, contentLength)
  assert.deepEqual(
    await target.get('/release.txt', { wait: false }),
    Buffer.from('signed release')
  )
  assert.equal(await target.entry('/later.txt', { wait: false }), null)
})
