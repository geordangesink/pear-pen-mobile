const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const c = require('compact-encoding')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const Hyperdrive = require('hyperdrive')
const id = require('hypercore-id-encoding')
const z32 = require('z32')
// hypercore-sign v3 compatibility: check legacy requests and responses with the original verifier.
const CoreSign = require('hypercore-sign')
const PearPen = require('..')

async function fixture(t) {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pear-pen-metadata-review-')
  )
  const engine = new PearPen({ dir, network: false, timeout: 100 })
  t.after(async () => {
    await engine.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await engine.command('profile.import', {
    secretKey: z32.encode(crypto.keyPair().secretKey)
  })
  const publicKey = engine.snapshot().profile.publicKey
  const namespace = 'test/metadata-only-review'
  const manifest = {
    version: 1,
    hash: 'blake2b',
    quorum: 1,
    signers: [
      {
        signature: 'ed25519',
        publicKey: id.decode(publicKey),
        namespace: crypto.hash(Buffer.from(namespace))
      }
    ]
  }
  const penId = z32.encode(Hypercore.key(manifest))
  await engine.command('pen.add', { multisigKey: penId })
  await engine.command('pen.configure', {
    penId,
    config: JSON.stringify({
      multisig: { namespace, publicKeys: [publicKey], quorum: 1 }
    })
  })
  const writer = new Hyperdrive(engine.store.namespace('review-source'))
  await writer.ready()
  await writer.put('/payload.bin', Buffer.alloc(128 * 1024 + 17, 65))
  await writer.put('/notes.txt', Buffer.from('metadata only'))
  const srcKey = z32.encode(writer.key)
  await writer.close()
  await engine.command('request.create', { penId, srcKey })
  const record = engine.snapshot().pens[0].request
  const room = engine.rooms.get(penId)
  const source = engine.drives.get(srcKey)
  await source.getBlobs()
  return { engine, penId, publicKey, srcKey, room, source, record }
}

async function clearPayload(source) {
  const core = source.blobs.core
  assert.ok(core.length > 1)
  await core.clear(0, core.length)
  assert.equal(await core.has(0), false)
}

function alterRoot(request, content) {
  const buffer = Buffer.from(z32.decode(request))
  const state = { buffer, start: 0, end: buffer.length }
  for (let i = 0; i < 3; i++) c.uint.decode(state)
  buffer[content ? buffer.length - 1 : state.start] ^= 1
  return z32.encode(buffer)
}

for (const method of ['request.sign', 'manual.response']) {
  test(`${method} signs the encoded request without opening the source`, async (t) => {
    const { engine, penId, publicKey, source, record } = await fixture(t)
    await clearPayload(source)
    engine._source = async () => {
      throw new Error('Signing must not open a source drive')
    }
    const result = await engine.command(method, {
      penId,
      requestId: record.id,
      request: record.request
    })
    await CoreSign.verify(result.output, record.request, publicKey)
    assert.equal(engine.snapshot().pens[0].request.signatures.length, 1)
  })
}

test('review proves both signed roots and lists files without downloading payload blocks', async (t) => {
  const { engine, room, source, srcKey, record } = await fixture(t)
  await clearPayload(source)
  source.blobs.core.download = () => {
    throw new Error('Review must not download source payload')
  }
  source.blobs.core.get = async () => {
    throw new Error('Cached review must not read source payload blocks')
  }
  const result = await engine._review(
    room,
    { request: record.request, srcKey },
    [],
    false
  )
  assert.deepEqual(result.files.map((file) => file.path).sort(), [
    '/notes.txt',
    '/payload.bin'
  ])
  assert.equal(
    result.files.find((file) => file.path === '/payload.bin').size,
    128 * 1024 + 17
  )
  assert.equal(result.committed, false)
  assert.equal(await source.blobs.core.has(0), false)
  assert.equal(room.target.core.length, 0)
  assert.equal(room.contentCore.length, 0)
})

for (const content of [false, true]) {
  test(`review rejects an altered ${content ? 'content' : 'metadata'} root with sparse payload storage`, async (t) => {
    const { engine, room, source, srcKey, record } = await fixture(t)
    await clearPayload(source)
    source.blobs.core.download = () => {
      throw new Error('Review must not download source payload')
    }
    await assert.rejects(
      engine._review(
        room,
        {
          request: alterRoot(record.request, content),
          srcKey
        },
        [],
        false
      ),
      /match|root|checksum/i
    )
    assert.equal(room.target.core.length, 0)
    assert.equal(room.contentCore.length, 0)
  })
}

test('commit requires the missing file payload and cannot advance either destination feed', async (t) => {
  const { engine, penId, room, source, srcKey, record } = await fixture(t)
  const { output: response } = await engine.command('manual.response', {
    penId,
    request: record.request
  })
  await clearPayload(source)
  let downloads = 0
  const download = source.blobs.core.download.bind(source.blobs.core)
  source.blobs.core.download = (range) => {
    downloads++
    return download(range)
  }
  await assert.rejects(
    engine._review(
      room,
      {
        request: record.request,
        srcKey
      },
      [response],
      true
    ),
    /unavailable|timeout|missing|stall/i
  )
  assert.ok(downloads > 0)
  assert.equal(room.target.core.length, 0)
  assert.equal(room.contentCore.length, 0)
})
