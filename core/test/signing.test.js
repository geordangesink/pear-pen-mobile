const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const EventEmitter = require('node:events')
const crypto = require('hypercore-crypto')
const sodium = require('sodium-native')
const c = require('compact-encoding')
const z32 = require('z32')
const id = require('hypercore-id-encoding')
const Hyperdrive = require('hyperdrive')
const Hypercore = require('hypercore')
const { inflate } = require('hypercore/lib/multisig')
const { signCore } = require('hyper-multisig/lib/sign')
const SecretStream = require('@hyperswarm/secret-stream')
// hypercore-sign v3 compatibility: check legacy requests and responses with the original verifier.
const CoreSign = require('hypercore-sign')
const SigningRequest = require('hypercore-signing-request')
const PearPen = require('..')
const keys = require('../lib/keys')
const protocol = require('../lib/protocol')

function manifestFor(
  publicKeys,
  namespace,
  quorum = Math.floor(publicKeys.length / 2) + 1
) {
  return {
    version: 1,
    hash: 'blake2b',
    quorum,
    signers: publicKeys.map((publicKey) => ({
      signature: 'ed25519',
      publicKey: id.decode(publicKey),
      namespace: crypto.hash(Buffer.from(namespace))
    }))
  }
}

async function createDrive(store, publicKeys, namespace) {
  const manifest = manifestFor(publicKeys, namespace)
  const core = store.get({ manifest })
  await core.ready()
  const blobsCore = store.get({
    manifest: Hyperdrive.getContentManifest(manifest, core.key)
  })
  await blobsCore.ready()
  return { manifest, key: core.key, core, blobsCore }
}

function keyInput(pair, name = '') {
  return {
    name,
    publicKey: z32.encode(pair.publicKey),
    secretKey: z32.encode(pair.secretKey)
  }
}

async function fixture(t, count = 3, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-test-'))
  const engine = new PearPen({ dir, network: false, timeout: 1000, ...options })
  await engine.ready()
  const pairs = Array.from({ length: count }, () => crypto.keyPair())
  await engine.command('profile.import', keyInput(pairs[0], 'Alice'))
  const target = await createDrive(
    engine.store,
    pairs.map((pair) => z32.encode(pair.publicKey)),
    'test/pear-pen'
  )
  const source = new Hyperdrive(engine.store.namespace('source'))
  await source.ready()
  await source.put('/app.js', Buffer.from('hello'))
  const srcKey = z32.encode(source.key)
  await source.close()
  const penId = z32.encode(target.key)
  await engine.command('pen.add', { multisigKey: penId, name: 'App' })
  t.after(async () => {
    await target.core.close()
    await target.blobsCore.close()
    await engine.close()
    fs.rmSync(dir, { force: true, recursive: true })
  })
  return { engine, pairs, target, srcKey, penId, dir }
}

// hypercore-sign v3 compatibility: build independent legacy CLI responses for the workflow tests.
function sign(request, pair) {
  const req = SigningRequest.decode(z32.decode(request))
  return z32.encode(
    c.encode(CoreSign.messages.Response, {
      version: req.version,
      requestHash: crypto.hash(z32.decode(request)),
      publicKey: pair.publicKey,
      signatures: SigningRequest.signable(pair.publicKey, req).map((item) =>
        crypto.sign(item.signable, pair.secretKey)
      )
    })
  )
}

test('pen quorum accepts positive safe integers and blank auto-detection only', async (t) => {
  const { engine } = await fixture(t)
  const key = z32.encode(crypto.randomBytes(32))
  const state = fs.readFileSync(path.join(engine.dir, 'state.json'), 'utf8')
  for (const quorum of [
    0,
    -1,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    true,
    {},
    [],
    '2',
    '2abc'
  ]) {
    await assert.rejects(
      engine.command('pen.add', { multisigKey: key, quorum }),
      /positive whole number/
    )
    assert.equal(engine.rooms.has(key), false)
    assert.equal(engine.drives.has(key), false)
  }
  assert.equal(
    fs.readFileSync(path.join(engine.dir, 'state.json'), 'utf8'),
    state
  )
  for (const quorum of [undefined, null, '', '   ']) {
    const multisigKey = z32.encode(crypto.randomBytes(32))
    await engine.command('pen.add', { multisigKey, quorum })
    const pen = engine.snapshot().pens.find((item) => item.id === multisigKey)
    assert.equal(pen.quorum, 0)
    assert.equal(pen.configuredQuorum, null)
    assert.equal(pen.quorumMismatch, false)
  }
  await engine.command('pen.add', { multisigKey: key, quorum: 3 })
  const offline = engine.snapshot().pens.find((item) => item.id === key)
  assert.equal(offline.quorum, 3)
  assert.equal(offline.configuredQuorum, 3)
  assert.equal(offline.quorumMismatch, false)
})

test('a known quorum mismatch leaves no pen, discovery or listeners and permits a corrected retry', async (t) => {
  class TrackingSwarm extends EventEmitter {
    constructor() {
      super()
      this.connections = new Set()
      this.topics = new Set()
      this.sessions = new Map()
    }
    join(topic) {
      const key = topic.toString('hex')
      this.topics.add(key)
      if (!this.sessions.has(key)) this.sessions.set(key, new Set())
      const session = {
        destroyed: false,
        flushed: async () => true,
        destroy: async () => {
          session.destroyed = true
          this.sessions.get(key)?.delete(session)
          if (!this.sessions.get(key)?.size) this.topics.delete(key)
        }
      }
      this.sessions.get(key).add(session)
      return session
    }
    async leave(topic) {
      for (const session of this.sessions.get(topic.toString('hex')) || [])
        await session.destroy()
    }
  }
  const swarm = new TrackingSwarm()
  const { engine, pairs } = await fixture(t, 3, { swarm })
  const target = await createDrive(
    engine.store,
    pairs.map((pair) => z32.encode(pair.publicKey)),
    'test/quorum-retry'
  )
  const key = z32.encode(target.key)
  const updater = swarm.join(target.core.discoveryKey)
  const state = fs.readFileSync(path.join(engine.dir, 'state.json'), 'utf8')
  const topics = [...swarm.topics].sort()
  const rooms = engine.rooms.size
  let candidate
  const manifest = engine._manifest.bind(engine)
  engine._manifest = async (room, required) => {
    if (room.pen.id === key) candidate = room
    return manifest(room, required)
  }
  await assert.rejects(
    engine.command('pen.add', { multisigKey: key, quorum: 1 }),
    /requires 2 signatures; you entered 1.*leave quorum blank/
  )
  assert.equal(engine.rooms.size, rooms)
  assert.equal(engine.rooms.has(key), false)
  assert.equal(engine.drives.has(key), false)
  assert.equal(engine.driveDiscoveries.has(key), false)
  assert.equal(updater.destroyed, false)
  assert.equal(
    swarm.sessions.get(target.core.discoveryKey.toString('hex')).size,
    1
  )
  assert.equal(engine.channels.size, 0)
  assert.equal(candidate.channels.size, 0)
  assert.equal(candidate.refresh, undefined)
  assert.equal(candidate.target.closed, true)
  assert.equal(candidate.contentCore.closed, true)
  assert.deepEqual([...swarm.topics].sort(), topics)
  assert.equal(
    fs.readFileSync(path.join(engine.dir, 'state.json'), 'utf8'),
    state
  )
  engine._manifest = manifest
  const cached = await engine._drive(key)
  const discovery = engine.driveDiscoveries.get(key)
  await assert.rejects(
    engine.command('pen.add', { multisigKey: key, quorum: 1 }),
    /requires 2 signatures/
  )
  assert.equal(engine.drives.get(key), cached)
  assert.equal(cached.closed, false)
  assert.equal(discovery.destroyed, false)
  assert.equal(updater.destroyed, false)
  await engine.command('pen.add', { multisigKey: key, quorum: 2 })
  const added = engine.snapshot().pens.find((pen) => pen.id === key)
  assert.equal(added.quorum, 2)
  assert.equal(added.configuredQuorum, 2)
  assert.equal(added.quorumMismatch, false)
  assert.equal(updater.destroyed, false)
  assert.equal(
    swarm.sessions.get(target.core.discoveryKey.toString('hex')).size,
    2
  )
  await updater.destroy()
  await target.core.close()
  await target.blobsCore.close()
})

test('manual requests produce interoperable signatures and commit real drive data', async (t) => {
  const { engine, pairs, penId, srcKey, target } = await fixture(t)
  const { output: request } = await engine.command('manual.request', {
    penId,
    srcKey
  })
  const { output: response } = await engine.command('manual.response', {
    penId,
    request
  })
  await CoreSign.verify(response, request, z32.encode(pairs[0].publicKey))
  const responses = [response, sign(request, pairs[1])]
  await assert.rejects(
    engine.command('manual.commit', {
      penId,
      request,
      responses: [response, response],
      confirmation: 'COMMIT'
    }),
    /Insufficient quorum/
  )
  const review = await engine.command('manual.review', {
    penId,
    request,
    responses
  })
  assert.equal(review.committed, false)
  assert.equal(target.core.length, 0)
  assert.deepEqual(review.files, [{ path: '/app.js', action: 'put', size: 5 }])
  await assert.rejects(
    engine.command('manual.commit', {
      penId,
      request,
      responses,
      confirmation: 'commit'
    }),
    /COMMIT/
  )
  const result = await engine.command('manual.commit', {
    penId,
    request,
    responses,
    confirmation: 'COMMIT'
  })
  assert.equal(result.committed, true)
  assert.equal(target.core.length, 2)
  const committed = engine.rooms.get(penId).target
  await committed.getBlobs()
  assert.equal((await committed.get('/app.js')).toString(), 'hello')
  assert.deepEqual(
    await engine.command('manual.response', { penId, request }),
    { output: response }
  )
})

test('manual verification checks both signatures offline on a non-signer device without changing the pen', async (t) => {
  const { engine, pairs, penId, srcKey } = await fixture(t)
  const { output: request } = await engine.command('manual.request', {
    penId,
    srcKey
  })
  const response = sign(request, pairs[1])
  const publicKey = z32.encode(pairs[1].publicKey)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-verifier-'))
  const observer = new PearPen({ dir, network: false })
  t.after(async () => {
    await observer.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await observer.command('profile.import', { password: 'observer password' })
  const otherPen = z32.encode(crypto.randomBytes(32))
  for (const multisigKey of [penId, otherPen])
    await observer.command('pen.add', { multisigKey })
  const before = observer.snapshot()
  const state = fs.readFileSync(path.join(dir, 'state.json'))
  observer._source = observer._update = () =>
    assert.fail('Unexpected drive access')
  const verify = (changes) =>
    observer.command('manual.verify', {
      penId,
      request,
      response,
      publicKey,
      ...changes
    })

  const req = SigningRequest.decode(z32.decode(request))
  const result = await verify({ publicKey: pairs[1].publicKey.toString('hex') })
  assert.equal(result.verified, true)
  assert.equal(result.signer, publicKey)
  assert.ok(typeof result.output === 'string' && result.output.trim())
  assert.deepEqual(result.details, {
    key: penId,
    fork: req.fork,
    length: req.length,
    treeHash: req.treeHash.toString('hex'),
    content: {
      length: req.content.length,
      treeHash: req.content.treeHash.toString('hex')
    }
  })
  for (const changes of [
    { penId: otherPen },
    { publicKey: z32.encode(pairs[0].publicKey) },
    { publicKey: '' },
    { publicKey: 'invalid' },
    { request: '!' },
    { response: z32.encode(z32.decode(response).subarray(0, 64)) }
  ]) {
    await assert.rejects(verify(changes))
  }
  for (const index of [0, 1]) {
    const decoded = c.decode(CoreSign.messages.Response, z32.decode(response))
    decoded.signatures[index][0] ^= 1
    const forged = z32.encode(c.encode(CoreSign.messages.Response, decoded))
    await assert.rejects(verify({ response: forged }))
  }
  assert.deepEqual(observer.snapshot(), before)
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state.json')), state)
  assert.equal(observer.rooms.get(penId).target.core.manifest, null)
  assert.equal(observer.drives.has(srcKey), false)
})

test('CLI manual workflow signs, accepts an external response, reviews and confirms a pinned drive', async (t) => {
  const { engine, pairs, penId, srcKey, target } = await fixture(t)
  const source = await engine._source(srcKey)
  const length = source.core.length
  await source.put('/later.txt', Buffer.from('later'))
  const destination = { penId, multisigKey: `pear://${penId}` }
  const { output: request, details } = await engine.command('manual.request', {
    ...destination,
    srcKey,
    length
  })
  const req = SigningRequest.decode(z32.decode(request))
  assert.equal(req.id, penId)
  assert.equal(req.length, length)
  assert.deepEqual(details, {
    key: penId,
    fork: req.fork,
    length,
    treeHash: z32.encode(req.treeHash),
    content: {
      length: req.content.length,
      treeHash: z32.encode(req.content.treeHash)
    }
  })
  const current = engine.snapshot().pens[0].request
  assert.equal(current.srcKey, `pear://${req.fork}.${length}.${srcKey}`)
  const selection = { ...destination, requestId: current.id }
  const preview = await engine.command('manual.inspect', { penId, request })
  assert.deepEqual(preview, {
    key: penId,
    fork: req.fork,
    length,
    treeHash: req.treeHash.toString('hex'),
    content: {
      length: req.content.length,
      treeHash: req.content.treeHash.toString('hex')
    },
    signer: z32.encode(pairs[0].publicKey)
  })
  const unsigned = await engine.command('manual.review', selection)
  assert.equal(unsigned.quorum, 0)
  assert.equal(unsigned.committed, false)
  assert.equal(target.core.length, 0)
  for (const [batch, from, to, signed] of [
    [unsigned.db, source.core, target.core, req],
    [unsigned.blobs, source.blobs.core, target.blobsCore, req.content]
  ]) {
    assert.deepEqual(batch.srcCore, {
      key: from.id,
      length: from.length,
      treeHash: z32.encode(await from.treeHash())
    })
    assert.deepEqual(batch.destCore, {
      key: to.id,
      length: to.length,
      treeHash: z32.encode(await to.treeHash())
    })
    assert.deepEqual(batch.batch, {
      key: to.id,
      length: signed.length,
      treeHash: z32.encode(signed.treeHash)
    })
  }
  const response = sign(request, pairs[1])
  for (let attempt = 0; attempt < 2; attempt++) {
    const submitted = await engine.command('manual.submitResponse', {
      penId,
      response
    })
    assert.equal(submitted.quorum, 1)
    assert.equal(submitted.required, 2)
    assert.deepEqual(
      submitted.signers,
      pairs.map((pair, index) => ({
        publicKey: z32.encode(pair.publicKey),
        signed: index === 1
      }))
    )
    assert.ok(submitted.output)
  }
  const shared = engine
    .snapshot()
    .pens[0].activity.filter((item) => item.response)
  assert.equal(shared.length, 1)
  assert.equal(shared[0].author, z32.encode(pairs[1].publicKey))
  assert.equal(shared[0].sharedBy, z32.encode(pairs[0].publicKey))
  assert.equal(shared[0].response, response)
  await assert.rejects(
    engine.command('manual.commit', { ...selection, confirmation: 'CONFIRM' }),
    /quorum/i
  )
  const signed = await engine.command('manual.response', { penId, request })
  await CoreSign.verify(signed.output, request, z32.encode(pairs[0].publicKey))
  const review = await engine.command('manual.review', selection)
  assert.equal(review.quorum, 2)
  assert.deepEqual(
    review.files.map((file) => file.path),
    ['/app.js']
  )
  const result = await engine.command('manual.commit', {
    ...selection,
    confirmation: 'CONFIRM'
  })
  assert.equal(result.committed, true)
  assert.deepEqual(result.db.destCore, unsigned.db.batch)
  assert.deepEqual(result.blobs.destCore, unsigned.blobs.batch)
  assert.equal(target.core.length, length)
  const committedState = engine.snapshot()
  assert.equal(committedState.pens[0].request, null)
  const verified = await engine.command('manual.verify', {
    penId,
    publicKey: shared[0].author,
    response: shared[0].response,
    request: shared[0].request
  })
  assert.equal(verified.signer, shared[0].author)
  assert.deepEqual(engine.snapshot(), committedState)
  const committed = engine.rooms.get(penId).target
  assert.equal((await committed.get('/app.js')).toString(), 'hello')
  assert.equal(await committed.entry('/later.txt'), null)
  await assert.rejects(
    engine.command('manual.submitResponse', { penId, response })
  )
})

test('CLI manual input rejects a mismatched destination, length, response or confirmation without changing the drive', async (t) => {
  const { engine, pairs, penId, srcKey, target } = await fixture(t)
  const source = await engine._source(srcKey)
  const length = source.core.length
  const destination = { penId, multisigKey: penId }
  const command = { ...destination, srcKey, length }
  const link = `pear://${source.core.fork}.${length}.${srcKey}`
  for (const invalid of [
    { multisigKey: srcKey },
    { length: '' },
    { length: 0 },
    { length: -1 },
    { length: 2.5 },
    { length: '2abc' },
    { length: Number.MAX_SAFE_INTEGER + 1 },
    { srcKey: link, length: length + 1 }
  ]) {
    await assert.rejects(
      engine.command('manual.request', { ...command, ...invalid })
    )
  }
  assert.equal(engine.snapshot().pens[0].request, null)
  const first = await engine.command('manual.request', {
    ...command,
    srcKey: link
  })
  const firstId = engine.snapshot().pens[0].request.id
  await source.put('/next.txt', Buffer.from('second'))
  const second = await engine.command('manual.request', {
    ...command,
    length: source.core.length
  })
  const requestId = engine.snapshot().pens[0].request.id
  assert.notEqual(firstId, requestId)
  for (const response of ['invalid', sign(first.output, pairs[1])]) {
    await assert.rejects(
      engine.command('manual.submitResponse', { penId, response })
    )
  }
  assert.deepEqual(engine.snapshot().pens[0].request.signatures, [])
  for (const pair of pairs.slice(0, 2)) {
    await engine.command('manual.submitResponse', {
      penId,
      response: sign(second.output, pair)
    })
  }
  for (const method of ['manual.review', 'manual.commit']) {
    for (const invalid of [{ multisigKey: srcKey }, { requestId: firstId }]) {
      await assert.rejects(
        engine.command(method, {
          ...destination,
          requestId,
          confirmation: 'CONFIRM',
          ...invalid
        })
      )
    }
  }
  for (const confirmation of ['', 'confirm', 'COMMIT']) {
    await assert.rejects(
      engine.command('manual.commit', {
        ...destination,
        requestId,
        confirmation
      })
    )
  }
  assert.equal(target.core.length, 0)
  assert.equal(engine.snapshot().pens[0].request.id, requestId)
})

test('a manually submitted CLI response syncs to an automatic peer and survives reopening', async (t) => {
  const { engine, pairs, penId, srcKey } = await fixture(t, 3, {
    swarm: new LocalSwarm()
  })
  await engine.command('settings.update', { mode: 'manual' })
  const source = await engine._source(srcKey)
  const { output: request } = await engine.command('manual.request', {
    penId,
    multisigKey: penId,
    srcKey,
    length: source.core.length
  })
  const response = sign(request, pairs[1])
  await engine.command('manual.submitResponse', { penId, response })

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-cli-response-'))
  let peer = new PearPen({ dir, network: false, swarm: new LocalSwarm() })
  t.after(async () => {
    await peer.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await peer.command('profile.import', keyInput(pairs[2]))
  await peer.command('pen.add', { multisigKey: penId })
  const disconnect = await connectLocal(t, engine, peer)
  await until(() => peer.snapshot().pens[0].request?.signatures.length === 1)
  disconnect()
  await peer.close()
  peer = new PearPen({ dir, network: false })
  await peer.ready()
  const pen = peer.snapshot().pens[0]
  assert.deepEqual(pen.request.signatures, [z32.encode(pairs[1].publicKey)])
  const shared = pen.activity.filter((event) => event.response === response)
  assert.equal(shared.length, 1)
  assert.equal(shared[0].author, z32.encode(pairs[1].publicKey))
  assert.equal(shared[0].sharedBy, z32.encode(pairs[0].publicKey))
})

test('successive commits preserve skipped signer indices in metadata and content', async (t) => {
  const { engine, pairs, penId, srcKey, target } = await fixture(t)
  const source = await engine._source(srcKey)
  for (const value of ['first update', 'second update']) {
    const previousLength = target.core.length
    await source.put('/app.js', Buffer.from(value))
    const { output: request } = await engine.command('manual.request', {
      penId,
      srcKey
    })
    const req = SigningRequest.decode(z32.decode(request))
    const result = await engine.command('manual.commit', {
      penId,
      request,
      responses: [sign(request, pairs[0]), sign(request, pairs[2])],
      confirmation: 'COMMIT'
    })
    assert.equal(result.committed, true)
    assert.ok(target.core.length > previousLength)
    assert.equal(target.core.length, req.length)
    assert.equal(target.blobsCore.length, req.content.length)
    for (const core of [target.core, target.blobsCore]) {
      assert.deepEqual(
        inflate(core.state.signature).proofs.map((proof) => proof.signer),
        [0, 2]
      )
    }
    const committed = engine.rooms.get(penId).target
    assert.equal((await committed.get('/app.js')).toString(), value)
  }
})

test('a different source cannot replace data covered by a signing request', async (t) => {
  const { engine, pairs, penId, srcKey, target } = await fixture(t)
  const { output: request } = await engine.command('manual.request', {
    penId,
    srcKey
  })
  const other = new Hyperdrive(engine.store.namespace('other-source'))
  await other.ready()
  await other.put('/app.js', Buffer.from('tampered'))
  const otherKey = z32.encode(other.key)
  await other.close()
  const room = engine.rooms.get(penId)
  await engine._publish(room, { type: 'request', srcKey: otherKey, request })
  const signed = await engine.command('request.sign', {
    penId,
    requestId: room.current.id
  })
  await CoreSign.verify(signed.output, request, z32.encode(pairs[0].publicKey))
  await assert.rejects(
    engine.command('manual.review', { penId, request, srcKey: otherKey }),
    /does not match/
  )
  await assert.rejects(
    engine.command('manual.commit', {
      penId,
      request,
      srcKey: otherKey,
      responses: pairs.slice(0, 2).map((pair) => sign(request, pair)),
      confirmation: 'COMMIT'
    }),
    /does not match/
  )
  assert.equal(target.core.length, 0)
})

for (const corrupt of [false, true]) {
  test(`a ${corrupt ? 'corrupt' : 'failed'} metadata append closes both staging sessions without publishing content`, async (t) => {
    const { engine, pairs, penId, srcKey, target } = await fixture(t)
    const { output: request } = await engine.command('manual.request', {
      penId,
      srcKey
    })
    const options = {
      penId,
      request,
      responses: pairs.slice(0, 2).map((pair) => sign(request, pair)),
      confirmation: 'COMMIT'
    }
    const batches = new Set()
    const failure = new Error('Append failed')
    const append = Hypercore.prototype.append
    const fault = t.mock.method(
      Hypercore.prototype,
      'append',
      function (block) {
        batches.add(this)
        if (this.key.equals(target.core.key)) {
          if (!corrupt) throw failure
          block = Buffer.from('different metadata')
        }
        return append.call(this, block)
      }
    )
    await assert.rejects(
      engine.command('manual.commit', options),
      corrupt
        ? /does not match the signed request/
        : (error) => error === failure
    )
    assert.equal(batches.size, 2)
    assert.ok([...batches].every((batch) => batch.closed))
    assert.equal(target.blobsCore.length, 0)
    assert.equal(target.core.length, 0)
    fault.mock.restore()
    assert.equal(
      (await engine.command('manual.commit', options)).committed,
      true
    )
  })
}

test('metadata commit failure can retry using already committed content', async (t) => {
  const { engine, pairs, penId, srcKey } = await fixture(t)
  const { output: request } = await engine.command('manual.request', {
    penId,
    srcKey
  })
  const options = {
    penId,
    request,
    responses: pairs.slice(0, 2).map((pair) => sign(request, pair)),
    confirmation: 'COMMIT'
  }
  const room = engine.rooms.get(penId)
  const fault = t.mock.method(room.target.core, 'commit', async () => null)
  await assert.rejects(
    engine.command('manual.commit', options),
    /changed while committing/
  )
  assert.equal(room.target.core.length, 0)
  assert.ok(room.contentCore.length > 0)
  fault.mock.restore()
  const contentCommit = t.mock.method(room.contentCore, 'commit')
  assert.equal((await engine.command('manual.commit', options)).committed, true)
  assert.equal(contentCommit.mock.callCount(), 0)
  assert.equal((await room.target.get('/app.js')).toString(), 'hello')
})

test('a historical metadata-only commit excludes later source content', async (t) => {
  const { engine, pairs, penId } = await fixture(t)
  const writer = new Hyperdrive(engine.store.namespace('metadata-first'))
  await writer.ready()
  await writer.symlink('/latest', '/release.txt')
  const srcKey = `pear://${writer.core.fork}.${writer.core.length}.${z32.encode(writer.key)}`
  await writer.put('/release.txt', Buffer.from('later release'))
  await writer.close()
  const { output: request } = await engine.command('manual.request', {
    penId,
    srcKey
  })
  const result = await engine.command('manual.commit', {
    penId,
    srcKey,
    request,
    responses: pairs.slice(0, 2).map((pair) => sign(request, pair)),
    confirmation: 'COMMIT'
  })
  assert.equal(result.content.length, 0)
  const room = engine.rooms.get(penId)
  assert.equal(room.contentCore.length, 0)
  assert.equal(
    (await room.target.entry('/latest')).value.linkname,
    '/release.txt'
  )
  assert.equal(await room.target.entry('/release.txt'), null)
})

test('responses and request IDs cannot be replayed across requests or pens', async (t) => {
  const { engine, pairs, penId, srcKey } = await fixture(t)
  await engine.command('request.create', { penId, srcKey })
  const previous = engine.rooms.get(penId).current
  await engine.command('request.create', { penId, srcKey })
  assert.notEqual(engine.snapshot().pens[0].request.id, previous.id)
  assert.ok(
    engine
      .snapshot()
      .pens[0].activity.some((item) => item.type === 'unanswered')
  )
  await assert.rejects(
    engine.command('request.sign', { penId, requestId: previous.id }),
    /request changed/
  )
  const room = engine.rooms.get(penId)
  const forged = protocol.create(
    engine.identity,
    penId,
    {
      type: 'response',
      requestId: room.current.id,
      response: sign(previous.request, pairs[1])
    },
    room.clock + 1
  )
  await engine._receive(room, forged)
  assert.deepEqual(engine.snapshot().pens[0].request.signatures, [])
  const different = await createDrive(
    engine.store,
    pairs.map((pair) => z32.encode(pair.publicKey)),
    'test/different'
  )
  const otherId = z32.encode(different.key)
  await engine.command('pen.add', { multisigKey: otherId, name: 'Different' })
  await assert.rejects(
    engine.command('manual.response', {
      penId: otherId,
      request: previous.request
    }),
    /different multisig/
  )
  await different.core.close()
  await different.blobsCore.close()
})

test('automatic activity rejects forged authors, outsider keys and premature commits', async (t) => {
  const { engine, pairs, penId, srcKey } = await fixture(t)
  await engine.command('request.create', { penId, srcKey })
  const room = engine.rooms.get(penId)
  const fake = protocol.create(
    engine.identity,
    penId,
    { type: 'review', requestId: room.current.id },
    room.clock + 1
  )
  fake.data.author = z32.encode(pairs[1].publicKey)
  await assert.rejects(
    engine._receive(room, fake),
    /Invalid activity signature/
  )
  const outsider = keys.importIdentity(keyInput(crypto.keyPair()))
  await assert.rejects(
    engine._receive(
      room,
      protocol.create(
        outsider,
        penId,
        { type: 'review', requestId: room.current.id },
        room.clock + 1
      )
    ),
    /Invalid activity signature/
  )
  const highClock = protocol.create(
    engine.identity,
    penId,
    { type: 'review', requestId: room.current.id },
    1e12
  )
  await engine._receive(room, highClock)
  assert.equal(room.clock, 1)
  await engine.command('request.sign', { penId, requestId: room.current.id })
  assert.equal(room.clock, 2)
  await engine._publish(room, { type: 'commit', requestId: room.current.id })
  assert.equal(engine.snapshot().pens[0].request.status, 'open')
  await assert.rejects(
    engine.command('request.commit', {
      penId,
      requestId: room.current.id,
      confirmation: 'COMMIT'
    }),
    /quorum/
  )
})

// hypercore-sign v3 compatibility: exercise the unversioned encrypted key layout.
test('encrypted hypercore-sign imports verify the password and never expose credentials', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-key-test-'))
  const engine = new PearPen({ dir, network: false })
  t.after(async () => {
    await engine.close()
    fs.rmSync(dir, { force: true, recursive: true })
  })
  const pair = crypto.keyPair()
  const password = 'correct horse battery staple'
  const payload = Buffer.concat([
    crypto.randomBytes(8),
    pair.secretKey,
    Buffer.alloc(32)
  ])
  crypto.hash(payload.subarray(0, 72)).copy(payload, 72)
  const salt = crypto.randomBytes(32)
  const ops = sodium.crypto_pwhash_scryptsalsa208sha256_OPSLIMIT_INTERACTIVE
  const mem = sodium.crypto_pwhash_scryptsalsa208sha256_MEMLIMIT_INTERACTIVE
  const output = Buffer.alloc(104)
  sodium.crypto_pwhash_scryptsalsa208sha256(
    output,
    Buffer.from(password),
    salt,
    ops,
    mem
  )
  for (let i = 0; i < payload.length; i++) payload[i] ^= output[i]
  const secretKey = z32.encode(
    c.encode(keys.encryptedKey, { ops, mem, salt, payload })
  )
  await assert.rejects(
    engine.command('profile.import', {
      publicKey: z32.encode(pair.publicKey),
      secretKey,
      password: 'wrong'
    }),
    /Incorrect private key password/
  )
  await engine.command('profile.import', {
    publicKey: z32.encode(pair.publicKey),
    secretKey,
    password
  })
  assert.equal(engine.snapshot().profile.encrypted, true)
  assert.ok(!JSON.stringify(engine.snapshot()).includes(secretKey))
  assert.ok(
    !fs.readFileSync(path.join(dir, 'identity.json'), 'utf8').includes(password)
  )
  assert.equal(fs.statSync(path.join(dir, 'identity.json')).mode & 0o777, 0o600)
  assert.deepEqual(keys.unlock(secretKey, password), pair.secretKey)
})

test('generated keys sign real requests and export backups accepted by hypercore-sign', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-generated-test-'))
  const original = { dir: path.join(dir, 'original'), network: false }
  let engine = new PearPen(original)
  const restored = new PearPen({
    dir: path.join(dir, 'restored'),
    network: false
  })
  let reimported = new PearPen({
    dir: path.join(dir, 'reimported'),
    network: false
  })
  let target
  t.after(async () => {
    await target?.core.close()
    await target?.blobsCore.close()
    await engine.close()
    await restored.close()
    await reimported.close()
    fs.rmSync(dir, { force: true, recursive: true })
  })
  const { suggestedName } = await engine.command('state.get')
  assert.match(suggestedName, /^[a-z]+-[a-z]+-\d+-\d+$/)
  for (const password of [undefined, '', '1234567']) {
    await assert.rejects(
      engine.command('profile.import', { password }),
      /at least 8 bytes/
    )
    assert.equal(engine.snapshot().suggestedName, suggestedName)
    assert.equal(fs.existsSync(path.join(original.dir, 'identity.json')), false)
  }
  const password = 'éééé'
  const state = await engine.command('profile.import', { name: '  ', password })
  assert.equal(state.profile.username, suggestedName)
  assert.equal(state.profile.name, suggestedName)
  assert.equal(state.suggestedName, null)
  assert.equal(state.profile.encrypted, true)
  await engine.command('settings.update', { name: 'Alice' })
  await engine.close()
  engine = new PearPen(original)
  await engine.ready()
  assert.equal(engine.snapshot().profile.name, 'Alice')
  assert.equal(engine.snapshot().profile.username, suggestedName)
  const publicExport = await engine.command('profile.export', {
    kind: 'public'
  })
  const encryptedExport = await engine.command('profile.export', {
    kind: 'private'
  })
  assert.equal(publicExport.name, 'default.public')
  assert.equal(publicExport.key, state.profile.publicKey)
  assert.equal(encryptedExport.name, 'default')
  assert.equal(encryptedExport.encrypted, true)
  const packed = c.decode(keys.encryptedKey, z32.decode(encryptedExport.key))
  assert.equal(packed.mem, 16 * 1024 * 1024)
  target = await createDrive(engine.store, [publicExport.key], 'test/generated')
  const source = new Hyperdrive(engine.store.namespace('generated-source'))
  await source.ready()
  await source.put('/app.js', Buffer.from('generated identity'))
  const srcKey = z32.encode(source.key)
  await source.close()
  const penId = z32.encode(target.key)
  await engine.command('pen.add', { multisigKey: penId })
  const { output: request } = await engine.command('manual.request', {
    penId,
    srcKey
  })
  for (const [input, error] of [
    [undefined, /Enter the password/],
    ['wrong', /Incorrect private key password/]
  ]) {
    await assert.rejects(
      engine.command('manual.response', { penId, request, password: input }),
      error
    )
    assert.equal(engine.snapshot().pens[0].request.signatures.length, 0)
  }
  const { output: response } = await engine.command('manual.response', {
    penId,
    request,
    password
  })
  await CoreSign.verify(response, request, publicExport.key)
  const req = SigningRequest.decode(z32.decode(request))
  const securePassword = sodium.sodium_malloc(Buffer.byteLength(password))
  securePassword.write(password)
  // hypercore-sign v3 compatibility: sign a new backup using the legacy CLI implementation.
  const { sign: cliSign } = require('hypercore-sign/lib/secure')
  const signatures = cliSign(
    SigningRequest.signable(z32.decode(publicExport.key), req),
    z32.decode(encryptedExport.key),
    securePassword
  )
  const cliResponse = z32.encode(
    c.encode(CoreSign.messages.Response, {
      version: req.version,
      requestHash: crypto.hash(z32.decode(request)),
      publicKey: z32.decode(publicExport.key),
      signatures
    })
  )
  await CoreSign.verify(cliResponse, request, publicExport.key)
  await restored.command('profile.import', {
    secretKey: encryptedExport.key,
    password
  })
  assert.equal(restored.snapshot().profile.publicKey, publicExport.key)
  assert.equal(restored.snapshot().profile.encrypted, true)
  assert.deepEqual(
    await restored.command('profile.export', { kind: 'private' }),
    encryptedExport
  )
  const rawSecret = keys.unlock(encryptedExport.key, password)
  const rawKey = z32.encode(rawSecret)
  rawSecret.fill(0)
  await reimported.command('profile.import', { secretKey: rawKey })
  await reimported.close()
  reimported = new PearPen({
    dir: path.join(dir, 'reimported'),
    network: false
  })
  await reimported.ready()
  assert.equal(reimported.snapshot().profile.publicKey, publicExport.key)
  assert.deepEqual(
    await reimported.command('profile.export', { kind: 'private' }),
    {
      name: 'default',
      encrypted: false,
      key: rawKey
    }
  )
  await assert.rejects(
    reimported.command('profile.export', {
      kind: 'private',
      password: '1234567'
    }),
    /at least 8 bytes/
  )
  assert.equal(
    (await reimported.command('profile.export', { kind: 'private', password }))
      .encrypted,
    true
  )
  await assert.rejects(
    engine.command('dialog.save', { dialog: { output: encryptedExport.key } }),
    /Private keys cannot be saved/
  )
  assert.ok(!JSON.stringify(engine.snapshot()).includes(encryptedExport.key))
  assert.equal(engine.snapshot().dialog, null)
  for (const file of ['state.json', 'identity.json']) {
    const stored = fs.readFileSync(path.join(original.dir, file), 'utf8')
    assert.ok(!stored.includes(password))
    assert.ok(!stored.includes(rawKey))
    if (file === 'state.json') assert.ok(!stored.includes(encryptedExport.key))
  }
})

test('partial or invalid onboarding cannot replace keys or leave a half-imported identity', async (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pear-pen-validation-test-')
  )
  const engine = new PearPen({ dir, network: false })
  t.after(async () => {
    await engine.close()
    fs.rmSync(dir, { force: true, recursive: true })
  })
  const pair = crypto.keyPair()
  const input = keyInput(pair)
  await assert.rejects(
    engine.command('profile.export', { kind: 'private' }),
    /Import your signing keys first/
  )
  await assert.rejects(
    engine.command('profile.import', { publicKey: input.publicKey }),
    /private key that belongs/
  )
  await assert.rejects(
    engine.command('profile.import', { ...input, name: 'x'.repeat(121) }),
    /120 characters/
  )
  await assert.rejects(
    engine.command('profile.import', {
      ...input,
      publicKey: z32.encode(crypto.keyPair().publicKey)
    }),
    /do not match/
  )
  await assert.rejects(
    engine.command('profile.import', { secretKey: 42 }),
    /Invalid key/
  )
  assert.equal(engine.identity, null)
  assert.equal(engine.snapshot().profile, null)
  assert.equal(fs.existsSync(path.join(dir, 'identity.json')), false)
  await engine.command('profile.import', {
    publicKey: '  ',
    secretKey: input.secretKey
  })
  assert.equal(engine.snapshot().profile.publicKey, input.publicKey)
  await assert.rejects(
    engine.command('profile.export', { kind: 'invalid' }),
    /Choose a public or private key export/
  )
})

test('restart repairs an interrupted onboarding profile without replacing its generated identity', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-recovery-test-'))
  let engine = new PearPen({ dir, network: false })
  t.after(async () => {
    await engine.close()
    fs.rmSync(dir, { force: true, recursive: true })
  })
  await engine.command('profile.import', {
    name: ' Alice ',
    password: 'test password'
  })
  const publicExport = await engine.command('profile.export', {
    kind: 'public'
  })
  const privateExport = await engine.command('profile.export', {
    kind: 'private'
  })
  await engine.close()
  const identity = fs.readFileSync(path.join(dir, 'identity.json'), 'utf8')
  for (const profile of [null, { name: 'Alice', publicKey: 'stale' }]) {
    const state = JSON.parse(
      fs.readFileSync(path.join(dir, 'state.json'), 'utf8')
    )
    state.profile = profile
    fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state))
    engine = new PearPen({ dir, network: false })
    await engine.ready()
    assert.equal(engine.snapshot().profile.publicKey, publicExport.key)
    assert.equal(engine.snapshot().profile.name, 'Alice')
    assert.equal(engine.snapshot().profile.username, 'Alice')
    assert.deepEqual(
      await engine.command('profile.export', { kind: 'private' }),
      privateExport
    )
    await assert.rejects(
      engine.command('profile.import'),
      /already been imported/
    )
    assert.equal(
      fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'),
      identity
    )
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).profile
        .publicKey,
      publicExport.key
    )
    await engine.close()
  }
})

test('an existing identity without a credential username keeps its keys and display name', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-legacy-'))
  const engine = new PearPen({ dir, network: false })
  t.after(async () => {
    await engine.close()
    fs.rmSync(dir, { force: true, recursive: true })
  })
  const identity = keys.importIdentity(keyInput(crypto.keyPair()))
  const stored = JSON.stringify(identity)
  fs.writeFileSync(path.join(dir, 'identity.json'), stored, { mode: 0o600 })
  fs.writeFileSync(
    path.join(dir, 'state.json'),
    JSON.stringify({
      ...engine.data,
      profile: { name: 'Alice', publicKey: identity.publicKey }
    })
  )
  const { profile } = await engine.command('state.get')
  assert.equal(profile.username, identity.publicKey)
  assert.equal(profile.name, 'Alice')
  assert.equal(profile.encrypted, false)
  assert.equal(
    (await engine.command('profile.export', { kind: 'private' })).key,
    identity.secretKey
  )
  assert.equal(fs.readFileSync(path.join(dir, 'identity.json'), 'utf8'), stored)
})

test('a missing saved identity produces a recovery error instead of generating replacement keys', async (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pear-pen-missing-identity-test-')
  )
  let engine = new PearPen({ dir, network: false })
  t.after(async () => {
    await engine.close()
    fs.rmSync(dir, { force: true, recursive: true })
  })
  await engine.command('profile.import', { password: 'test password' })
  await engine.close()
  fs.unlinkSync(path.join(dir, 'identity.json'))
  const state = fs.readFileSync(path.join(dir, 'state.json'), 'utf8')
  engine = new PearPen({ dir, network: false })
  await assert.rejects(engine.ready(), /signing identity is missing.*Restore/)
  await assert.rejects(
    engine.command('profile.import'),
    /signing identity is missing.*Restore/
  )
  assert.equal(fs.existsSync(path.join(dir, 'identity.json')), false)
  assert.equal(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'), state)
})

test('output dialogs survive restarting the app until explicitly closed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-dialog-test-'))
  let engine = new PearPen({ dir, network: false })
  t.after(async () => {
    await engine.close()
    fs.rmSync(dir, { force: true, recursive: true })
  })
  const dialog = { title: 'Response', output: 'copy-again-after-returning' }
  await engine.command('dialog.save', { dialog })
  await engine.close()
  engine = new PearPen({ dir, network: false })
  await engine.ready()
  assert.deepEqual(engine.snapshot().dialog, dialog)
  await engine.command('dialog.save', { dialog: null })
  assert.equal(engine.snapshot().dialog, null)
})

class LocalSwarm extends EventEmitter {
  constructor() {
    super()
    this.connections = new Set()
  }
  join() {
    return { flushed: async () => true, destroy: async () => {} }
  }
}

class DiscoveringSwarm extends LocalSwarm {
  constructor() {
    super()
    this.discovery = new Promise((resolve, reject) => {
      this.finishDiscovery = resolve
      this.failDiscovery = reject
    })
  }
  flush() {
    return this.discovery
  }
}

async function until(condition) {
  const end = Date.now() + 5000
  while (!condition()) {
    if (Date.now() > end) throw new Error('Timed out waiting for local peers')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function connectLocal(t, leftEngine, rightEngine) {
  const left = new SecretStream(true)
  const right = new SecretStream(false)
  left.on('error', () => {})
  right.on('error', () => {})
  left.rawStream.pipe(right.rawStream).pipe(left.rawStream)
  await Promise.all([left.opened, right.opened])
  leftEngine._connection(left)
  rightEngine._connection(right)
  const disconnect = () => {
    left.destroy()
    right.destroy()
  }
  t.after(disconnect)
  return disconnect
}

test('a first signing command waits for discovery and a late metadata peer', async (t) => {
  const {
    engine: alice,
    pairs,
    penId,
    srcKey
  } = await fixture(t, 2, {
    swarm: new LocalSwarm()
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-discovery-'))
  const swarm = new DiscoveringSwarm()
  const bob = new PearPen({ dir, network: false, swarm, timeout: 3000 })
  t.after(async () => {
    swarm.finishDiscovery()
    await bob.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await bob.command('profile.import', keyInput(pairs[1]))
  await bob.command('pen.add', { multisigKey: penId })
  const room = bob.rooms.get(penId)
  assert.equal(room.target.core.manifest, null)
  let settled = false
  const request = bob.command('manual.request', { penId, srcKey })
  request.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    settled,
    false,
    'the command must not fail before discovery finishes'
  )
  await connectLocal(t, alice, bob)
  swarm.finishDiscovery()
  const result = await request
  assert.ok(result.output)
  assert.equal(bob.snapshot().pens[0].quorum, 2)
  assert.equal(room.target.core._findingPeers, 0)
})

test('unversioned requests wait for discovery before pinning a cached older source head', async (t) => {
  const {
    engine: alice,
    pairs,
    penId,
    srcKey
  } = await fixture(t, 2, { swarm: new LocalSwarm() })
  const source = await alice._source(srcKey)
  const oldLength = source.core.length
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pear-pen-latest-discovery-')
  )
  const swarm = new DiscoveringSwarm()
  const bob = new PearPen({ dir, network: false, swarm, timeout: 3000 })
  t.after(async () => {
    swarm.finishDiscovery()
    await bob.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await bob.command('profile.import', keyInput(pairs[1]))
  await bob.command('pen.add', { multisigKey: penId })
  const disconnect = await connectLocal(t, alice, bob)
  await until(() => bob.rooms.get(penId).manifest)
  const remote = await bob._source(`pear://0.${oldLength}.${srcKey}`)
  disconnect()
  await until(() => remote.core.peers.length === 0)
  await source.put('/app.js', Buffer.from('latest after initial cached head'))
  const latest = source.core.length
  let settled = false
  const request = bob.command('request.create', { penId, srcKey })
  request.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  await connectLocal(t, alice, bob)
  swarm.finishDiscovery()
  await request
  assert.equal(
    bob.snapshot().pens[0].request.srcKey,
    `pear://0.${latest}.${srcKey}`
  )
  assert.equal(bob.snapshot().pens[0].request.length, latest)
})

test('a cached unversioned source refreshes completed discovery before selecting its head', async (t) => {
  class RefreshingSwarm extends LocalSwarm {
    constructor() {
      super()
      this.refreshes = 0
      this.lookup = new Promise((resolve) => {
        this.finishRefresh = resolve
      })
    }
    join() {
      return {
        flushed: async () => true,
        destroy: async () => {},
        refresh: async () => {
          this.refreshes++
          await this.lookup
        }
      }
    }
    async flush() {
      return true
    }
  }
  const {
    engine: alice,
    pairs,
    penId,
    srcKey
  } = await fixture(t, 2, { swarm: new LocalSwarm() })
  const source = await alice._source(srcKey)
  const oldLength = source.core.length
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-refresh-source-'))
  const swarm = new RefreshingSwarm()
  const bob = new PearPen({ dir, network: false, swarm, timeout: 3000 })
  t.after(async () => {
    swarm.finishRefresh()
    await bob.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await bob.command('profile.import', keyInput(pairs[1]))
  await bob.command('pen.add', { multisigKey: penId })
  const disconnect = await connectLocal(t, alice, bob)
  await until(() => bob.rooms.get(penId).manifest)
  const remote = await bob._source(`pear://0.${oldLength}.${srcKey}`)
  await until(() => !bob.driveReady.has(srcKey))
  disconnect()
  await until(() => remote.core.peers.length === 0)
  await source.put(
    '/app.js',
    Buffer.from('new writer head after previous lookup')
  )
  const latest = source.core.length
  let settled = false
  const request = bob.command('request.create', { penId, srcKey })
  request.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(swarm.refreshes, 1)
  assert.equal(settled, false)
  await connectLocal(t, alice, bob)
  swarm.finishRefresh()
  await request
  assert.equal(
    bob.snapshot().pens[0].request.srcKey,
    `pear://0.${latest}.${srcKey}`
  )
})

for (const failure of [
  'failed',
  'timed out',
  'refresh returned false',
  'discovery flush returned false',
  'swarm flush returned false'
]) {
  test(`latest-source discovery that ${failure} cannot reuse a cached head`, async (t) => {
    class FailingRefreshSwarm extends LocalSwarm {
      constructor() {
        super()
        this.failure = null
      }
      join() {
        return {
          flushed: async () =>
            this.failure !== 'discovery flush returned false',
          destroy: async () => {},
          refresh: async () => {
            if (this.failure === 'refresh returned false') return false
            if (this.failure === 'failed')
              throw new Error('Local test lookup failed')
            if (this.failure === 'timed out') await new Promise(() => {})
          }
        }
      }
      async flush() {
        return this.failure !== 'swarm flush returned false'
      }
    }
    const swarm = new FailingRefreshSwarm()
    const { engine, penId, srcKey } = await fixture(t, 1, { swarm })
    const source = await engine._source(srcKey)
    const link = `pear://${source.core.fork}.${source.core.length}.${srcKey}`
    const before = JSON.stringify(engine.snapshot())
    swarm.failure = failure
    engine.timeout = 80
    await assert.rejects(
      engine.command('request.create', { penId, srcKey }),
      /Could not discover the latest source version/
    )
    assert.equal(JSON.stringify(engine.snapshot()), before)
    assert.equal(engine.rooms.get(penId).events.length, 0)
    assert.equal(source.core._findingPeers, 0)
    const { output } = await engine.command('manual.request', {
      penId,
      srcKey: link
    })
    assert.ok(output)
    assert.equal(engine.snapshot().pens[0].request.srcKey, link)
    assert.deepEqual(engine.snapshot().pens[0].request.signatures, [])
  })
}

test('a cached exact source waits for a later peer to provide its newly requested version', async (t) => {
  const {
    engine: alice,
    pairs,
    penId,
    srcKey
  } = await fixture(t, 2, { swarm: new LocalSwarm() })
  const source = await alice._source(srcKey)
  const oldLength = source.core.length
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pear-pen-new-source-version-')
  )
  const bob = new PearPen({
    dir,
    network: false,
    swarm: new LocalSwarm(),
    timeout: 1000
  })
  t.after(async () => {
    await bob.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await bob.command('profile.import', keyInput(pairs[1]))
  await bob.command('pen.add', { multisigKey: penId })
  const disconnect = await connectLocal(t, alice, bob)
  await until(() => bob.rooms.get(penId).manifest)
  const remote = await bob._source(`pear://0.${oldLength}.${srcKey}`)
  disconnect()
  await until(() => remote.core.peers.length === 0)
  await source.put(
    '/app.js',
    Buffer.from('new version after the first reader disconnected')
  )
  const link = `pear://0.${source.core.length}.${srcKey}`
  let settled = false
  const request = bob.command('request.create', { penId, srcKey: link })
  request.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(
    settled,
    false,
    'a cached older head is not the requested version'
  )
  await connectLocal(t, alice, bob)
  await request
  assert.equal(bob.snapshot().pens[0].request.srcKey, link)
  assert.equal(bob.rooms.get(penId).target.core.length, 0)
})

test('a missing source configuration can be added and retried at a new version without restarting', async (t) => {
  const {
    engine: alice,
    pairs,
    srcKey
  } = await fixture(t, 2, { swarm: new LocalSwarm() })
  const publicKeys = pairs.map((pair) => z32.encode(pair.publicKey))
  const namespace = 'test/retry-after-missing-source-config'
  const penId = z32.encode(Hypercore.key(manifestFor(publicKeys, namespace, 2)))
  await alice.command('pen.add', { multisigKey: penId })
  const source = await alice._source(srcKey)
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pear-pen-retry-source-config-')
  )
  const bob = new PearPen({
    dir,
    network: false,
    swarm: new LocalSwarm(),
    timeout: 1000
  })
  t.after(async () => {
    await bob.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await bob.command('profile.import', keyInput(pairs[1]))
  await bob.command('pen.add', { multisigKey: penId })
  const disconnect = await connectLocal(t, alice, bob)
  const initial = `pear://0.${source.core.length}.${srcKey}`
  await assert.rejects(
    bob.command('manual.request', { penId, srcKey: initial }),
    /missing \/pear.json/
  )
  const cached = bob.drives.get(srcKey)
  assert.equal(cached.closed, false)
  disconnect()
  await until(() => cached.core.peers.length === 0)
  await source.put(
    '/pear.json',
    Buffer.from(
      JSON.stringify({ multisig: { namespace, publicKeys, quorum: 2 } })
    )
  )
  const link = `pear://0.${source.core.length}.${srcKey}`
  let settled = false
  const request = bob.command('manual.request', { penId, srcKey: link })
  request.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    }
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(settled, false)
  await connectLocal(t, alice, bob)
  const result = await request
  assert.ok(result.output)
  assert.equal(bob.drives.get(srcKey), cached)
  assert.equal(bob.snapshot().pens[0].request.srcKey, link)
  assert.equal(bob.snapshot().pens[0].quorum, 2)
  assert.deepEqual(bob.snapshot().pens[0].request.signatures, [])
})

for (const exact of [false, true]) {
  test(`a cold ${exact ? 'versioned' : 'latest'} source waits for a peer after an initial failed lookup`, async (t) => {
    class RetryableSwarm extends LocalSwarm {
      constructor() {
        super()
        this.lookups = 0
      }
      join() {
        return {
          destroy: async () => {},
          refresh: async () => this.connections.size > 0,
          flushed: async () => {
            this.lookups++
            return this.connections.size > 0
          }
        }
      }
      async flush() {
        return true
      }
    }
    const {
      engine: alice,
      pairs,
      penId,
      srcKey
    } = await fixture(t, 2, { swarm: new LocalSwarm() })
    const source = await alice._source(srcKey)
    const link = `pear://0.${source.core.length}.${srcKey}`
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-cold-retry-'))
    const swarm = new RetryableSwarm()
    const bob = new PearPen({ dir, network: false, swarm, timeout: 1000 })
    t.after(async () => {
      await bob.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })
    await bob.command('profile.import', keyInput(pairs[1]))
    await bob.command('pen.add', { multisigKey: penId })
    await bob.command('pen.configure', {
      penId,
      config: JSON.stringify({
        multisig: {
          namespace: 'test/pear-pen',
          publicKeys: pairs.map((pair) => z32.encode(pair.publicKey)),
          quorum: 2
        }
      })
    })
    let settled = false
    const request = bob.command('request.create', {
      penId,
      srcKey: exact ? link : srcKey
    })
    request.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      }
    )
    await until(() => bob.drives.has(srcKey) && swarm.lookups > 0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(bob.drives.get(srcKey).core.length, 0)
    assert.equal(settled, false)
    const left = new SecretStream(true),
      right = new SecretStream(false)
    left.on('error', () => {})
    right.on('error', () => {})
    left.rawStream.pipe(right.rawStream).pipe(left.rawStream)
    await Promise.all([left.opened, right.opened])
    t.after(() => {
      left.destroy()
      right.destroy()
    })
    alice.swarm.connections.add(left)
    bob.swarm.connections.add(right)
    alice.swarm.emit('connection', left)
    bob.swarm.emit('connection', right)
    await request
    assert.equal(bob.snapshot().pens[0].request.srcKey, link)
    assert.equal(bob.drives.get(srcKey).core.fork, 0)
  })
}

test('a source that timed out can connect and be retried using the same cached drive', async (t) => {
  const {
    engine: alice,
    pairs,
    penId,
    srcKey
  } = await fixture(t, 2, { swarm: new LocalSwarm() })
  const source = await alice._source(srcKey)
  const link = `pear://0.${source.core.length}.${srcKey}`
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pear-pen-offline-then-retry-')
  )
  const bob = new PearPen({
    dir,
    network: false,
    swarm: new LocalSwarm(),
    timeout: 60
  })
  t.after(async () => {
    await bob.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await bob.command('profile.import', keyInput(pairs[1]))
  await bob.command('pen.add', { multisigKey: penId })
  const start = Date.now()
  await assert.rejects(
    bob.command('request.create', { penId, srcKey: link }),
    /version is unavailable/
  )
  assert.ok(Date.now() - start >= 40)
  const cached = bob.drives.get(srcKey)
  assert.equal(cached.closed, false)
  bob.timeout = 1000
  await connectLocal(t, alice, bob)
  await bob.command('request.create', { penId, srcKey: link })
  assert.equal(bob.drives.get(srcKey), cached)
  assert.equal(bob.snapshot().pens[0].request.srcKey, link)
})

test('metadata discovery and update deadlines release requests without closing the drive', async (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pear-pen-offline-discovery-')
  )
  const swarm = new DiscoveringSwarm()
  const engine = new PearPen({ dir, network: false, swarm, timeout: 80 })
  t.after(async () => {
    swarm.finishDiscovery()
    await engine.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await engine.command('profile.import', keyInput(crypto.keyPair()))
  const penId = z32.encode(crypto.randomBytes(32))
  await engine.command('pen.add', { multisigKey: penId })
  const room = engine.rooms.get(penId)
  const core = room.target.core
  assert.ok(core._findingPeers > 0)
  const done = core.findingPeers()
  const sessions = []
  const session = core.session.bind(core)
  core.session = (...args) => {
    const child = session(...args)
    sessions.push(child)
    return child
  }
  const start = Date.now()
  await assert.rejects(
    engine._manifest(room, true),
    /multisig drive manifest is unavailable/
  )
  assert.ok(
    Date.now() - start < 1000,
    'an unresolved lookup must not hang a command'
  )
  assert.equal(core.closed, false)
  assert.ok(sessions.length > 0)
  assert.ok(
    sessions.every((child) => child.closed && child.activeRequests.length === 0)
  )
  assert.equal(
    core._findingPeers,
    1,
    'the engine discovery hold expires independently'
  )
  done()
  assert.equal(core._findingPeers, 0)
  await engine.command('pen.remove', { penId })
})

test('closing a drive releases its in-flight discovery before the swarm finishes', async (t) => {
  const swarm = new DiscoveringSwarm()
  const { engine, penId } = await fixture(t, 1, { swarm })
  const drive = engine.drives.get(penId)
  assert.ok(drive.core._findingPeers > 0)
  await engine.close()
  assert.equal(drive.core._findingPeers, 0)
  swarm.finishDiscovery()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(drive.core._findingPeers, 0)
})

test('a failed discovery releases its per-drive hold without an unhandled rejection', async (t) => {
  const swarm = new DiscoveringSwarm()
  const { engine, penId } = await fixture(t, 1, { swarm, timeout: 80 })
  const drive = engine.drives.get(penId)
  assert.ok(drive.core._findingPeers > 0)
  swarm.failDiscovery(new Error('Local test discovery failed'))
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(drive.core._findingPeers > 0)
  await until(() => drive.core._findingPeers === 0)
  assert.equal(drive.core._findingPeers, 0)
  assert.equal(drive.closed, false)
})

test('connected key-only peers do not count as an available drive manifest', async (t) => {
  const { engine: alice, pairs } = await fixture(t, 2, {
    swarm: new LocalSwarm()
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-key-only-peer-'))
  const bob = new PearPen({
    dir,
    network: false,
    swarm: new LocalSwarm(),
    timeout: 80
  })
  t.after(async () => {
    await bob.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await bob.command('profile.import', keyInput(pairs[1]))
  const penId = z32.encode(crypto.randomBytes(32))
  await alice.command('pen.add', { multisigKey: penId })
  await bob.command('pen.add', { multisigKey: penId })
  await connectLocal(t, alice, bob)
  const room = bob.rooms.get(penId)
  await until(
    () =>
      bob.snapshot().pens[0].peers === 1 && room.target.core.peers.length > 0
  )
  assert.equal(room.target.core.manifest, null)
  const start = Date.now()
  await assert.rejects(
    bob._manifest(room, true),
    /manifest is unavailable.*seeding the complete drive/
  )
  assert.ok(Date.now() - start < 1000)
  assert.equal(bob.snapshot().pens[0].quorum, 0)
  assert.deepEqual(bob.snapshot().pens[0].signers, [])
  assert.equal(room.events.length, 0)
})

for (const manual of [true, false]) {
  test(`${manual ? 'manual' : 'automatic'} signing learns an unknown pen's manifest from its authenticated request without source access`, async (t) => {
    const { engine: alice, pairs, penId, srcKey } = await fixture(t, 2)
    const { output: request } = await alice.command('manual.request', {
      penId,
      srcKey
    })
    const event = alice.rooms.get(penId).events[0]
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pear-pen-request-manifest-')
    )
    const bob = new PearPen({ dir, network: false, timeout: 100 })
    t.after(async () => {
      await bob.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })
    await bob.command('profile.import', keyInput(pairs[1]))
    await bob.command('pen.add', { multisigKey: penId })
    const room = bob.rooms.get(penId)
    assert.equal(room.target.core.manifest, null)
    bob._source =
      bob._bootstrapManifest =
      bob._update =
        async () => {
          throw new Error(
            'Signing must not fetch source files or target metadata'
          )
        }
    let result
    if (manual)
      result = await bob.command('manual.response', { penId, request })
    else {
      await bob._receive(room, event)
      assert.equal(room.current.id, event.id)
      result = await bob.command('request.sign', { penId, requestId: event.id })
    }
    await CoreSign.verify(
      result.output,
      request,
      z32.encode(pairs[1].publicKey)
    )
    assert.equal(room.manifest.quorum, 2)
    assert.equal(room.target.core.length, 0)
    assert.equal(room.contentCore.length, 0)
    assert.equal(bob.drives.has(srcKey), false)
    assert.equal(room.pen.config, undefined)
  })
}

test('manual review uses the pasted request for a link-only pen without source configuration', async (t) => {
  const { engine, pairs, srcKey } = await fixture(t, 2)
  const manifest = manifestFor(
    pairs.map((pair) => z32.encode(pair.publicKey)),
    'test/link-only-review'
  )
  const penId = z32.encode(Hypercore.key(manifest))
  const source = await engine._source(srcKey)
  const request = z32.encode(
    await SigningRequest.generateDrive(source, { manifest })
  )
  await engine.command('pen.add', { multisigKey: penId })
  const room = engine.rooms.get(penId)
  assert.equal(room.target.core.manifest, null)
  const review = await engine.command('manual.review', {
    penId,
    request,
    srcKey
  })
  assert.deepEqual(
    review.files.map((file) => file.path),
    ['/app.js']
  )
  assert.equal(review.committed, false)
  assert.equal(review.quorum, 0)
  assert.equal(room.pen.config, undefined)
  assert.equal(room.target.core.length, 0)
})

test('invalid self-describing requests cannot initialize an unknown pen', async (t) => {
  const { engine: alice, pairs, penId, srcKey } = await fixture(t, 2)
  const { output: request } = await alice.command('manual.request', {
    penId,
    srcKey
  })
  const source = await alice._source(srcKey)
  const wrong = manifestFor(
    pairs.map((pair) => z32.encode(pair.publicKey)),
    'wrong/request/manifest',
    2
  )
  const wrongRequest = z32.encode(
    await SigningRequest.generateDrive(source, { manifest: wrong })
  )
  const unsupported = { ...wrong, version: 0 }
  const unsupportedKey = z32.encode(Hypercore.key(unsupported))
  const unsupportedRequest = z32.encode(
    await SigningRequest.generateDrive(source, { manifest: unsupported })
  )
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pear-pen-invalid-request-manifest-')
  )
  const bob = new PearPen({ dir, network: false })
  t.after(async () => {
    await bob.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await bob.command('profile.import', keyInput(pairs[1]))
  await bob.command('pen.add', { multisigKey: penId })
  await bob.command('pen.add', { multisigKey: unsupportedKey })
  const room = bob.rooms.get(penId)
  const state = fs.readFileSync(path.join(dir, 'state.json'))
  const event = alice.rooms.get(penId).events[0]
  await assert.rejects(
    bob._receive(room, { ...event, signature: z32.encode(Buffer.alloc(64)) }),
    /Invalid activity signature/
  )
  const outsider = protocol.create(
    keys.importIdentity(keyInput(crypto.keyPair())),
    penId,
    { type: 'request', srcKey, request },
    1
  )
  await assert.rejects(
    bob._receive(room, outsider),
    /Invalid activity signature/
  )
  const mismatched = protocol.create(
    alice.identity,
    penId,
    { type: 'request', srcKey, request: wrongRequest },
    1
  )
  await assert.rejects(
    bob._receive(room, mismatched),
    /different multisig drive/
  )
  for (const method of ['manual.response', 'manual.review']) {
    await assert.rejects(
      bob.command(method, { penId, request: wrongRequest }),
      /different multisig drive/
    )
    await assert.rejects(
      bob.command(method, {
        penId: unsupportedKey,
        request: unsupportedRequest
      }),
      /supported multisig drive manifest/
    )
  }
  const unsupportedEvent = protocol.create(
    alice.identity,
    unsupportedKey,
    { type: 'request', srcKey, request: unsupportedRequest },
    1
  )
  await assert.rejects(
    bob._receive(bob.rooms.get(unsupportedKey), unsupportedEvent),
    /supported multisig drive manifest/
  )
  for (const candidate of bob.rooms.values()) {
    assert.equal(candidate.target.core.manifest, null)
    assert.equal(candidate.target.core.length, 0)
    assert.equal(candidate.contentCore, undefined)
    assert.equal(candidate.events.length, 0)
  }
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state.json')), state)
})

test('a verified public configuration bootstraps an empty first-release drive and its peers', async (t) => {
  const {
    engine: alice,
    pairs,
    srcKey
  } = await fixture(t, 2, {
    swarm: new LocalSwarm()
  })
  const publicKeys = pairs.map((pair) => z32.encode(pair.publicKey))
  const namespace = 'test/first-release'
  const manifest = manifestFor(publicKeys, namespace, 2)
  const penId = z32.encode(Hypercore.key(manifest))
  const config = JSON.stringify({
    multisig: { namespace, publicKeys, quorum: 2 }
  })
  await alice.command('pen.add', { multisigKey: penId, quorum: 2 })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-first-release-'))
  let bob = new PearPen({ dir, network: false, swarm: new LocalSwarm() })
  t.after(async () => {
    await bob.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await bob.command('profile.import', keyInput(pairs[1]))
  await bob.command('pen.add', { multisigKey: penId })
  const disconnect = await connectLocal(t, alice, bob)
  await until(() => bob.snapshot().pens[0].peers === 1)
  const room = alice.rooms.get(penId)
  assert.equal(room.target.core.manifest, null)
  assert.equal(bob.rooms.get(penId).target.core.manifest, null)
  const state = await alice.command('pen.configure', { penId, config })
  const pen = state.pens.find((item) => item.id === penId)
  assert.equal(pen.quorum, 2)
  assert.deepEqual(pen.signers, publicKeys)
  assert.equal(pen.request, null)
  assert.deepEqual(pen.activity, [])
  assert.equal(room.target.core.length, 0)
  assert.equal(room.contentCore.length, 0)
  assert.equal(room.events.length, 0)
  await until(() => bob.snapshot().pens[0].quorum === 2)
  assert.deepEqual(bob.snapshot().pens[0].signers, publicKeys)
  assert.equal(bob.rooms.get(penId).target.core.length, 0)
  disconnect()
  await bob.close()
  bob = new PearPen({ dir, network: false, swarm: new LocalSwarm() })
  await bob.ready()
  assert.equal(bob.snapshot().pens[0].quorum, 2)
  assert.deepEqual(bob.snapshot().pens[0].signers, publicKeys)
  await bob.command('pen.configure', { penId, config })
  assert.deepEqual(bob.snapshot().pens[0].activity, [])
  const { output: request } = await alice.command('manual.request', {
    penId,
    srcKey
  })
  const review = await alice.command('manual.review', {
    penId,
    request,
    srcKey,
    responses: pairs.map((pair) => sign(request, pair))
  })
  assert.equal(review.files[0].path, '/app.js')
  assert.equal(room.target.core.length, 0)
})

test('invalid or mismatched configurations cannot mutate unknown or known drive manifests', async (t) => {
  const { engine, pairs, penId } = await fixture(t)
  const publicKeys = pairs.map((pair) => z32.encode(pair.publicKey))
  const namespace = 'test/configuration-validation'
  const manifest = manifestFor(publicKeys, namespace, 2)
  const unknownKey = z32.encode(Hypercore.key(manifest))
  await engine.command('pen.add', { multisigKey: unknownKey })
  const room = engine.rooms.get(unknownKey)
  const state = fs.readFileSync(path.join(engine.dir, 'state.json'), 'utf8')
  const knownManifest = JSON.stringify(engine.rooms.get(penId).manifest)
  let initializations = 0
  const get = room.target.corestore.get.bind(room.target.corestore)
  room.target.corestore.get = (...args) => {
    initializations++
    return get(...args)
  }
  const bad = [
    null,
    {},
    '',
    '{',
    ' '.repeat(64 * 1024 + 1),
    JSON.stringify({ multisig: { namespace: '', publicKeys, quorum: 2 } }),
    JSON.stringify({ multisig: { namespace, publicKeys: [], quorum: 1 } }),
    JSON.stringify({
      multisig: {
        namespace,
        publicKeys: [publicKeys[0], publicKeys[0]],
        quorum: 2
      }
    }),
    JSON.stringify({
      multisig: { namespace, publicKeys: ['invalid-key'], quorum: 1 }
    }),
    ...[0, -1, 1.5, '2', publicKeys.length + 1].map((quorum) =>
      JSON.stringify({ multisig: { namespace, publicKeys, quorum } })
    ),
    JSON.stringify({
      multisig: { namespace: namespace + '/different', publicKeys, quorum: 2 }
    }),
    JSON.stringify({
      multisig: { namespace, publicKeys: [...publicKeys].reverse(), quorum: 2 }
    }),
    JSON.stringify({ multisig: { namespace, publicKeys, quorum: 1 } })
  ]
  await assert.rejects(
    engine.command('pen.configure', {
      penId: unknownKey,
      config: JSON.stringify({
        multisig: { namespace: 'é'.repeat(33000), publicKeys, quorum: 2 }
      })
    }),
    /64 KB/
  )
  for (const config of bad) {
    await assert.rejects(
      engine.command('pen.configure', { penId: unknownKey, config })
    )
    assert.equal(room.target.core.manifest, null)
    assert.equal(room.target.core.length, 0)
    assert.equal(room.events.length, 0)
  }
  assert.equal(initializations, 0)
  const wrongForKnown = JSON.stringify({
    multisig: { namespace, publicKeys, quorum: 2 }
  })
  await assert.rejects(
    engine.command('pen.configure', { penId, config: wrongForKnown }),
    /does not match/
  )
  assert.equal(JSON.stringify(engine.rooms.get(penId).manifest), knownManifest)
  assert.equal(
    fs.readFileSync(path.join(engine.dir, 'state.json'), 'utf8'),
    state
  )
})

for (const method of ['request.create', 'manual.request']) {
  test(`${method} automatically bootstraps from a remote source /pear.json`, async (t) => {
    const {
      engine: alice,
      pairs,
      srcKey
    } = await fixture(t, 2, {
      swarm: new LocalSwarm()
    })
    const publicKeys = pairs.map((pair) => z32.encode(pair.publicKey))
    const namespace = 'test/automatic-source-configuration'
    const manifest = manifestFor(publicKeys, namespace, 2)
    const penId = z32.encode(Hypercore.key(manifest))
    const config = JSON.stringify({
      multisig: { namespace, publicKeys, quorum: 2 }
    })
    const source = await alice._source(srcKey)
    if (method === 'manual.request') {
      const blob = await source.blobs.put(Buffer.from(config), {
        blockMap: true
      })
      await source.putEntry('/pear.json', { blob })
    } else {
      await source.put('/pear.json', Buffer.from(config))
    }
    await alice.command('pen.add', { multisigKey: penId })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-auto-config-'))
    const bob = new PearPen({ dir, network: false, swarm: new LocalSwarm() })
    t.after(async () => {
      await bob.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })
    await bob.command('profile.import', keyInput(pairs[1]))
    await bob.command('pen.add', { multisigKey: penId })
    await connectLocal(t, alice, bob)
    await until(() => bob.snapshot().pens[0].peers === 1)
    const room = bob.rooms.get(penId)
    assert.equal(room.target.core.manifest, null)
    assert.equal(bob.drives.has(srcKey), false)
    const result = await bob.command(method, { penId, srcKey })
    const pen = bob.snapshot().pens[0]
    assert.deepEqual(pen.signers, publicKeys)
    assert.equal(pen.quorum, 2)
    assert.ok(pen.request)
    assert.deepEqual(pen.request.signatures, [])
    if (method === 'manual.request')
      assert.equal(result.output, pen.request.request)
    assert.equal(room.target.core.length, 0)
    assert.equal(room.contentCore.length, 0)
    assert.equal(room.events.length, 1)
    await until(() => alice.rooms.get(penId).manifest?.quorum === 2)
    assert.equal(alice.rooms.get(penId).target.core.length, 0)
  })
}

test('automatic configuration rejects missing, oversized, malformed and wrong-key files before target mutation', async (t) => {
  const { engine, pairs, srcKey } = await fixture(t)
  const publicKeys = pairs.map((pair) => z32.encode(pair.publicKey))
  const namespace = 'test/invalid-source-configuration'
  const penId = z32.encode(Hypercore.key(manifestFor(publicKeys, namespace, 2)))
  await engine.command('pen.add', { multisigKey: penId })
  const room = engine.rooms.get(penId)
  const source = await engine._source(srcKey)
  const state = fs.readFileSync(path.join(engine.dir, 'state.json'), 'utf8')
  let initializations = 0
  const getCore = room.target.corestore.get.bind(room.target.corestore)
  room.target.corestore.get = (...args) => {
    initializations++
    return getCore(...args)
  }
  let reads = 0
  const checkout = source.checkout.bind(source)
  source.checkout = (...args) => {
    const view = checkout(...args)
    const get = view.get.bind(view)
    view.get = (entry, options) => {
      reads++
      assert.equal(typeof entry, 'object')
      assert.equal(options.prefetch, false)
      assert.ok(options.length <= 64 * 1024)
      assert.equal(options.timeout, engine.timeout)
      return get(entry, options)
    }
    return view
  }
  await assert.rejects(
    engine.command('request.create', { penId, srcKey }),
    /source drive is missing \/pear.json.*import it in Pen details/
  )
  assert.equal(reads, 0)
  await source.put('/pear.json', Buffer.alloc(64 * 1024 + 1))
  await assert.rejects(
    engine.command('request.create', { penId, srcKey }),
    /64 KB/
  )
  assert.equal(reads, 0, 'large plain blob is rejected before its data is read')
  const blob = await source.blobs.put(Buffer.alloc(64 * 1024 + 1), {
    blockMap: true
  })
  assert.ok(blob.byteLength < 64 * 1024)
  await source.putEntry('/pear.json', { blob })
  await assert.rejects(
    engine.command('request.create', { penId, srcKey }),
    /64 KB/
  )
  assert.equal(
    reads,
    0,
    'block-map logical size is checked before reading its file data'
  )
  for (const config of [
    '{',
    JSON.stringify({
      multisig: { namespace: namespace + '/wrong', publicKeys, quorum: 2 }
    })
  ]) {
    await source.put('/pear.json', Buffer.from(config))
    await assert.rejects(engine.command('request.create', { penId, srcKey }))
    assert.equal(room.target.core.manifest, null)
    assert.equal(room.target.core.length, 0)
    assert.equal(room.contentCore, undefined)
    assert.equal(room.events.length, 0)
  }
  assert.equal(reads, 2)
  assert.equal(initializations, 0)
  assert.equal(
    fs.readFileSync(path.join(engine.dir, 'state.json'), 'utf8'),
    state
  )
})

test('a verified imported manifest takes priority over absent or conflicting source configuration', async (t) => {
  const { engine, pairs, srcKey } = await fixture(t)
  const publicKeys = pairs.map((pair) => z32.encode(pair.publicKey))
  const namespace = 'test/imported-manifest-priority'
  const manifest = manifestFor(publicKeys, namespace, 2)
  const penId = z32.encode(Hypercore.key(manifest))
  await engine.command('pen.add', { multisigKey: penId })
  await engine.command('pen.configure', {
    penId,
    config: JSON.stringify({ multisig: { namespace, publicKeys, quorum: 2 } })
  })
  const room = engine.rooms.get(penId)
  const original = JSON.stringify(room.manifest)
  const source = await engine._source(srcKey)
  let configReads = 0
  const checkout = source.checkout.bind(source)
  source.checkout = (...args) => {
    const view = checkout(...args)
    const entry = view.entry.bind(view)
    view.entry = (name, options) => {
      if (name === '/pear.json') configReads++
      return entry(name, options)
    }
    return view
  }
  for (const config of [
    null,
    '{',
    JSON.stringify({
      multisig: { namespace: namespace + '/different', publicKeys, quorum: 1 }
    })
  ]) {
    if (config !== null) await source.put('/pear.json', Buffer.from(config))
    const { output } = await engine.command('manual.request', { penId, srcKey })
    const request = SigningRequest.decode(z32.decode(output))
    assert.equal(z32.encode(Hypercore.key(request.manifest)), penId)
    assert.equal(JSON.stringify(room.manifest), original)
    assert.equal(room.target.core.length, 0)
  }
  assert.equal(configReads, 0)
})

test('unavailable source configuration blocks time out without initializing the target', async (t) => {
  const { engine, pairs, srcKey } = await fixture(t)
  const publicKeys = pairs.map((pair) => z32.encode(pair.publicKey))
  const namespace = 'test/unavailable-config-blocks'
  const penId = z32.encode(Hypercore.key(manifestFor(publicKeys, namespace, 2)))
  await engine.command('pen.add', { multisigKey: penId })
  const source = await engine._source(srcKey)
  await source.put(
    '/pear.json',
    Buffer.from(
      JSON.stringify({ multisig: { namespace, publicKeys, quorum: 2 } })
    )
  )
  await source.clear('/pear.json')
  engine.timeout = 80
  const start = Date.now()
  await assert.rejects(engine.command('request.create', { penId, srcKey }))
  assert.ok(Date.now() - start < 1000)
  const room = engine.rooms.get(penId)
  assert.equal(room.target.core.manifest, null)
  assert.equal(room.target.core.length, 0)
  assert.equal(room.events.length, 0)
})

test('versioned requests use their exact source prefix and keep legacy peer event keys', async (t) => {
  const { engine, pairs, penId, srcKey } = await fixture(t)
  const source = await engine._source(srcKey)
  const length = source.core.length
  const fork = source.core.fork
  const link = `pear://${fork}.${length}.${srcKey}`
  await source.put(
    '/app.js',
    Buffer.from('changed after the requested version')
  )
  await source.put('/later.txt', Buffer.from('later'))
  const latest = source.core.length
  await engine.command('request.create', { penId, srcKey: link })
  const current = engine.snapshot().pens[0].request
  const request = SigningRequest.decode(z32.decode(current.request))
  assert.equal(request.length, length)
  assert.equal(request.fork, fork)
  assert.equal(current.srcKey, link)
  const event = engine.rooms
    .get(penId)
    .events.find((item) => item.id === current.id)
  assert.equal(event.data.srcKey, srcKey)
  assert.equal(event.data.authorName, 'Alice')
  const result = await engine.command('manual.commit', {
    penId,
    request: current.request,
    srcKey: link,
    responses: pairs.slice(0, 2).map((pair) => sign(current.request, pair)),
    confirmation: 'COMMIT'
  })
  assert.equal(result.length, length)
  assert.equal(result.srcKey, link)
  const target = engine.rooms.get(penId).target
  assert.equal((await target.get('/app.js')).toString(), 'hello')
  assert.equal(await target.entry('/later.txt'), null)
  await engine.command('request.create', { penId, srcKey })
  assert.equal(
    engine.snapshot().pens[0].request.srcKey,
    `pear://${fork}.${latest}.${srcKey}`
  )
  assert.equal(engine.snapshot().pens[0].request.length, latest)
})

test('unavailable source versions, mismatched review pins and target aliases never fall back to latest', async (t) => {
  const { engine, pairs, penId, srcKey } = await fixture(t)
  await engine.command('request.create', { penId, srcKey })
  const current = engine.snapshot().pens[0].request
  const req = SigningRequest.decode(z32.decode(current.request))
  const room = engine.rooms.get(penId)
  const count = room.events.length
  for (const link of [
    `pear://${req.fork + 1}.${req.length}.${srcKey}`,
    `pear://${req.fork}.${req.length + 100}.${srcKey}`,
    `pear://${req.fork}.0.${srcKey}`,
    `pear://${req.fork}.${req.length}.${penId}`
  ]) {
    await assert.rejects(
      engine.command('request.create', { penId, srcKey: link })
    )
  }
  for (const link of [
    `pear://${req.fork}.${req.length + 1}.${srcKey}`,
    `pear://${req.fork + 1}.${req.length}.${srcKey}`
  ]) {
    for (const method of ['manual.review', 'manual.commit']) {
      await assert.rejects(
        engine.command(method, {
          penId,
          request: current.request,
          srcKey: link,
          responses: pairs
            .slice(0, 2)
            .map((pair) => sign(current.request, pair)),
          confirmation: 'COMMIT'
        }),
        /Source version does not match/
      )
    }
  }
  assert.equal(room.events.length, count)
  assert.equal(room.target.core.length, 0)
  assert.equal(room.contentCore.length, 0)
})

test('automatic configuration comes from the selected source version, never a newer recipe', async (t) => {
  const { engine, pairs, srcKey } = await fixture(t)
  const publicKeys = pairs.map((pair) => z32.encode(pair.publicKey))
  const firstNamespace = 'test/versioned-first-configuration'
  const secondNamespace = 'test/versioned-second-configuration'
  const firstKey = z32.encode(
    Hypercore.key(manifestFor(publicKeys, firstNamespace, 2))
  )
  const secondKey = z32.encode(
    Hypercore.key(manifestFor(publicKeys, secondNamespace, 2))
  )
  const source = await engine._source(srcKey)
  await source.put(
    '/pear.json',
    Buffer.from(
      JSON.stringify({
        multisig: { namespace: firstNamespace, publicKeys, quorum: 2 }
      })
    )
  )
  const length = source.core.length
  const link = `pear://${source.core.fork}.${length}.${srcKey}`
  await source.put(
    '/pear.json',
    Buffer.from(
      JSON.stringify({
        multisig: { namespace: secondNamespace, publicKeys, quorum: 2 }
      })
    )
  )
  await engine.command('pen.add', { multisigKey: firstKey })
  await engine.command('pen.add', { multisigKey: secondKey })
  await assert.rejects(
    engine.command('request.create', { penId: secondKey, srcKey: link }),
    /does not match/
  )
  assert.equal(engine.rooms.get(secondKey).target.core.manifest, null)
  const manual = await engine.command('manual.request', {
    penId: firstKey,
    multisigKey: firstKey,
    srcKey,
    length
  })
  const pinned = await engine.command('manual.request', {
    penId: firstKey,
    srcKey: link
  })
  assert.equal(manual.output, pinned.output)
  const current = engine
    .snapshot()
    .pens.find((pen) => pen.id === firstKey).request
  assert.equal(current.srcKey, link)
  assert.equal(current.length, length)
  assert.equal(engine.rooms.get(firstKey).target.core.length, 0)
})

test('review of a cold historical prefix fetches only its necessary proof leaf', async (t) => {
  const {
    engine: alice,
    pairs,
    penId,
    srcKey
  } = await fixture(t, 1, { swarm: new LocalSwarm() })
  const source = await alice._source(srcKey)
  await source.put('/second.txt', Buffer.from('two'))
  await source.put('/third.txt', Buffer.from('three'))
  const { output: request } = await alice.command('manual.request', {
    penId,
    srcKey
  })
  const req = SigningRequest.decode(z32.decode(request))
  await source.put('/fourth.txt', Buffer.from('four'))
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pear-pen-historical-review-')
  )
  const bob = new PearPen({
    dir,
    network: false,
    swarm: new LocalSwarm(),
    timeout: 3000
  })
  t.after(async () => {
    await bob.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await bob.command('profile.import', keyInput(pairs[0]))
  await bob.command('pen.add', { multisigKey: penId })
  await bob.command('pen.configure', {
    penId,
    config: JSON.stringify({
      multisig: {
        namespace: 'test/pear-pen',
        publicKeys: [z32.encode(pairs[0].publicKey)],
        quorum: 1
      }
    })
  })
  await connectLocal(t, alice, bob)
  const remote = await bob._source(srcKey)
  await bob._update(remote.blobs.core)
  assert.equal(remote.blobs.core.length, 4)
  await assert.rejects(
    Hypercore.treeHashFromStorage(remote.blobs.core, req.content.length),
    { code: 'INVALID_OPERATION' }
  )
  const downloaded = []
  remote.blobs.core.on('download', (index) => downloaded.push(index))
  remote.blobs.core.download = () => {
    throw new Error('Historical review must not download a body range')
  }
  const result = await bob.command('manual.review', {
    penId,
    request,
    srcKey: `pear://${req.fork}.${req.length}.${srcKey}`
  })
  assert.equal(result.files.length, 3)
  assert.deepEqual(downloaded, [req.content.length - 1])
  assert.equal(await remote.blobs.core.has(0), false)
  assert.equal(bob.rooms.get(penId).target.core.length, 0)
})

test('removing and readding a pen closes unmatched channels on a live connection', async (t) => {
  const {
    engine: alice,
    pairs,
    penId
  } = await fixture(t, 2, {
    swarm: new LocalSwarm()
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-channel-readd-'))
  const bob = new PearPen({ dir, network: false, swarm: new LocalSwarm() })
  await bob.command('profile.import', keyInput(pairs[1]))
  const left = new SecretStream(true)
  const right = new SecretStream(false)
  left.on('error', () => {})
  right.on('error', () => {})
  left.rawStream.pipe(right.rawStream).pipe(left.rawStream)
  await Promise.all([left.opened, right.opened])
  alice.swarm.connections.add(left)
  bob.swarm.connections.add(right)
  alice._connection(left)
  bob._connection(right)
  t.after(async () => {
    left.destroy()
    right.destroy()
    await bob.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const oldRoom = alice.rooms.get(penId)
  const oldChannel = [...alice.channels.values()][0]
  assert.equal(oldRoom.channels.size, 0)
  assert.equal(alice.channels.size, 1)
  await alice.command('pen.remove', { penId })
  assert.equal(oldChannel.closed, true)
  assert.equal(alice.channels.size, 0)
  await alice.command('pen.add', { multisigKey: penId })
  const newChannel = [...alice.channels.values()][0]
  assert.notEqual(newChannel, oldChannel)
  oldChannel.onclose()
  assert.equal([...alice.channels.values()][0], newChannel)
  await bob.command('pen.add', { multisigKey: penId })
  await until(
    () =>
      alice.snapshot().pens[0].peers === 1 && bob.snapshot().pens[0].peers === 1
  )
  assert.equal(oldRoom.channels.size, 0)
})

test(
  'offline quorum survives restart and later mismatch never lowers the actual signing quorum',
  { timeout: 15000 },
  async (t) => {
    const {
      engine: alice,
      pairs,
      penId,
      srcKey
    } = await fixture(t, 3, { swarm: new LocalSwarm() })
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pear-pen-offline-quorum-')
    )
    let bob = new PearPen({
      dir,
      network: false,
      swarm: new LocalSwarm(),
      timeout: 3000
    })
    t.after(async () => {
      await bob.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })
    await bob.command('profile.import', keyInput(pairs[1]))
    await bob.command('pen.add', { multisigKey: penId, quorum: 1 })
    assert.equal(bob.snapshot().pens[0].quorum, 1)
    assert.equal(bob.snapshot().pens[0].quorumMismatch, false)
    await bob.close()
    bob = new PearPen({
      dir,
      network: false,
      swarm: new LocalSwarm(),
      timeout: 3000
    })
    await bob.ready()
    assert.equal(bob.snapshot().pens[0].configuredQuorum, 1)
    assert.equal(bob.snapshot().pens[0].quorum, 1)
    const disconnect = await connectLocal(t, alice, bob)
    await until(() => bob.snapshot().pens[0].quorumMismatch)
    assert.equal(bob.snapshot().pens[0].quorum, 2)
    assert.equal(bob.snapshot().pens[0].configuredQuorum, 1)
    await alice.command('request.create', { penId, srcKey })
    await until(() => bob.snapshot().pens[0].request)
    const request = bob.snapshot().pens[0].request
    await bob.command('request.sign', { penId, requestId: request.id })
    assert.equal(bob.snapshot().pens[0].request.quorum, 2)
    await assert.rejects(
      bob.command('manual.commit', {
        penId,
        request: request.request,
        responses: [],
        confirmation: 'COMMIT'
      }),
      /Insufficient quorum: 1 \/ 2/
    )
    const other = await createDrive(
      bob.store,
      [z32.encode(pairs[1].publicKey)],
      'test/other-quorum'
    )
    const otherKey = z32.encode(other.key)
    await bob.command('pen.add', { multisigKey: otherKey, quorum: 1 })
    assert.equal(
      bob.snapshot().pens.find((pen) => pen.id === otherKey).quorumMismatch,
      false
    )
    const otherSource = new Hyperdrive(
      bob.store.namespace('other-quorum-source')
    )
    await otherSource.ready()
    await otherSource.put('/app.js', Buffer.from('independent pen'))
    const otherSrcKey = z32.encode(otherSource.key)
    await otherSource.close()
    const otherRequest = await bob.command('manual.request', {
      penId: otherKey,
      srcKey: otherSrcKey
    })
    const otherResponse = await bob.command('manual.response', {
      penId: otherKey,
      request: otherRequest.output
    })
    await CoreSign.verify(
      otherResponse.output,
      otherRequest.output,
      z32.encode(pairs[1].publicKey)
    )
    await other.core.close()
    await other.blobsCore.close()
    disconnect()
    await bob.close()
    bob = new PearPen({ dir, network: false })
    await bob.ready()
    assert.equal(bob.snapshot().pens[0].quorum, 2)
    assert.equal(bob.snapshot().pens[0].quorumMismatch, true)
    assert.equal(bob.snapshot().pens.length, 2)
    const copied = await bob.command('request.response', {
      penId,
      requestId: request.id
    })
    await CoreSign.verify(
      copied.output,
      request.request,
      z32.encode(pairs[1].publicKey)
    )
    await bob.command('pen.remove', { penId })
    assert.equal(bob.snapshot().pens.length, 1)
  }
)

test(
  'manual and automatic peers share requests, responses, reviews and valid commits',
  { timeout: 15000 },
  async (t) => {
    const {
      engine: alice,
      pairs,
      penId,
      srcKey
    } = await fixture(t, 2, { swarm: new LocalSwarm() })
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-mixed-test-'))
    const bob = new PearPen({
      dir,
      network: false,
      swarm: new LocalSwarm(),
      timeout: 3000
    })
    t.after(async () => {
      await bob.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })
    await bob.command('profile.import', keyInput(pairs[1], 'Bob'))
    await bob.command('settings.update', { mode: 'manual' })
    await bob.command('pen.add', { multisigKey: penId })
    const disconnect = await connectLocal(t, alice, bob)
    await alice.command('request.create', { penId, srcKey })
    await until(() => bob.snapshot().pens[0].request)
    const current = alice.snapshot().pens[0].request
    const requestId = current.id
    const request = current.request
    const manual = await bob.command('manual.request', { penId, srcKey })
    assert.equal(manual.output, request)
    assert.equal(bob.snapshot().pens[0].request.id, requestId)
    const { output: response } = await bob.command('manual.response', {
      penId,
      request
    })
    await CoreSign.verify(response, request, z32.encode(pairs[1].publicKey))
    await until(() => alice.snapshot().pens[0].request.signatures.length === 1)
    const signed = await alice.command('request.sign', { penId, requestId })
    await CoreSign.verify(
      signed.output,
      request,
      z32.encode(pairs[0].publicKey)
    )
    await until(() => bob.snapshot().pens[0].request.signatures.length === 2)
    const review = await bob.command('manual.review', {
      penId,
      request,
      responses: []
    })
    assert.equal(review.quorum, 2)
    await until(() =>
      alice.snapshot().pens[0].activity.some((item) => item.type === 'review')
    )
    await assert.rejects(
      bob.command('request.commit', {
        penId,
        requestId,
        confirmation: 'COMMIT'
      }),
      /Only the request creator/
    )
    await bob.command('manual.commit', {
      penId,
      request,
      responses: [],
      confirmation: 'COMMIT'
    })
    await until(
      () =>
        alice.snapshot().pens[0].request === null &&
        alice.snapshot().pens[0].activity.some((item) => item.type === 'commit')
    )
    assert.ok(
      alice.snapshot().pens[0].activity.some((item) => item.type === 'commit')
    )
    disconnect()
    assert.deepEqual(
      await bob.command('request.response', { penId, requestId }),
      { output: response }
    )
    assert.deepEqual(
      await alice.command('request.response', { penId, requestId }),
      { output: signed.output }
    )
    assert.ok(
      alice
        .snapshot()
        .pens[0].activity.some((item) => item.response === response)
    )
  }
)

test(
  'an orphan manual response survives restart and binds once without inventing a requester',
  { timeout: 15000 },
  async (t) => {
    const {
      engine: alice,
      pairs,
      penId,
      srcKey
    } = await fixture(t, 2, { swarm: new LocalSwarm() })
    const request = await alice._makeRequest(alice.rooms.get(penId), srcKey)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-orphan-test-'))
    let bob = new PearPen({ dir, network: false, swarm: new LocalSwarm() })
    t.after(async () => {
      await bob.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })
    await bob.command('profile.import', keyInput(pairs[1]))
    const core = bob.store.get({ manifest: alice.rooms.get(penId).manifest })
    await core.ready()
    await core.close()
    await bob.command('pen.add', { multisigKey: penId })
    const { output: response } = await bob.command('manual.response', {
      penId,
      request
    })
    assert.equal(bob.snapshot().pens[0].request, null)
    assert.equal(bob.snapshot().pens[0].activity[0].response, response)
    assert.equal(bob.snapshot().pens[0].activity[0].requestId, undefined)
    assert.equal(bob.rooms.get(penId).events[0].data.srcKey, undefined)
    await bob.close()
    bob = new PearPen({ dir, network: false, swarm: new LocalSwarm() })
    await bob.ready()
    assert.equal(bob.snapshot().pens[0].request, null)
    assert.equal(bob.snapshot().pens[0].activity[0].response, response)
    await alice.command('request.create', { penId, srcKey })
    const requestId = alice.snapshot().pens[0].request.id
    const disconnect = await connectLocal(t, alice, bob)
    await until(
      () =>
        alice.snapshot().pens[0].request.signatures.length === 1 &&
        bob.snapshot().pens[0].request?.id === requestId
    )
    assert.equal(
      bob.snapshot().pens[0].request.creator,
      z32.encode(pairs[0].publicKey)
    )
    assert.deepEqual(bob.snapshot().pens[0].request.signatures, [
      z32.encode(pairs[1].publicKey)
    ])
    disconnect()
    await bob.close()
    bob = new PearPen({ dir, network: false })
    await bob.ready()
    bob._source = async () => {
      throw new Error('Copy attempted a source fetch')
    }
    bob._manifest = async () => {
      throw new Error('Copy attempted a manifest fetch')
    }
    const copied = await bob.command('request.response', { penId, requestId })
    assert.equal(copied.output, response)
    await CoreSign.verify(
      copied.output,
      request,
      z32.encode(pairs[1].publicKey)
    )
  }
)

test('relayed signatures retain their signers and never automatically carry into reopened attempts', async (t) => {
  const { engine, pairs, penId, srcKey } = await fixture(t)
  const { output: first } = await engine.command('manual.request', {
    penId,
    srcKey
  })
  const firstId = engine.snapshot().pens[0].request.id
  const bob = sign(first, pairs[1])
  const charlie = sign(first, pairs[2])
  await engine.command('manual.review', {
    penId,
    request: first,
    responses: [bob, charlie, bob]
  })
  assert.deepEqual(
    engine.snapshot().pens[0].request.signatures.sort(),
    pairs
      .slice(1)
      .map((pair) => z32.encode(pair.publicKey))
      .sort()
  )
  const shared = engine
    .snapshot()
    .pens[0].activity.filter((item) => item.response)
  assert.equal(shared.length, 2)
  assert.ok(
    shared.every(
      (item) =>
        item.sharedBy === z32.encode(pairs[0].publicKey) &&
        item.author !== item.sharedBy
    )
  )
  await assert.rejects(
    engine.command('request.response', { penId, requestId: firstId }),
    /not signed/
  )
  await engine._publish(engine.rooms.get(penId), {
    type: 'response',
    requestId: firstId,
    request: first,
    response: bob
  })
  assert.equal(engine.snapshot().pens[0].request.signatures.length, 2)
  const other = new Hyperdrive(engine.store.namespace('reopened-other'))
  await other.ready()
  await other.put('/app.js', Buffer.from('different snapshot'))
  const otherKey = z32.encode(other.key)
  await other.close()
  await engine.command('request.create', { penId, srcKey: otherKey })
  const second = engine.snapshot().pens[0].request.request
  assert.deepEqual(engine.snapshot().pens[0].request.signatures, [])
  const before = engine.snapshot()
  const verification = {
    penId,
    response: bob,
    request: first,
    publicKey: z32.encode(pairs[1].publicKey)
  }
  assert.equal(
    (await engine.command('manual.verify', verification)).verified,
    true
  )
  await assert.rejects(
    engine.command('manual.verify', { ...verification, request: second })
  )
  assert.deepEqual(engine.snapshot(), before)
  await assert.rejects(
    engine.command('manual.review', {
      penId,
      request: second,
      responses: [bob]
    }),
    /not made over this request/
  )
  await engine.command('request.create', { penId, srcKey })
  const reopened = engine.snapshot().pens[0].request
  assert.equal(reopened.request, first)
  assert.notEqual(reopened.id, firstId)
  assert.deepEqual(reopened.signatures, [])
  await engine.command('manual.request', { penId, srcKey })
  assert.equal(engine.snapshot().pens[0].request.id, reopened.id)
  await engine.command('manual.review', {
    penId,
    request: first,
    responses: [bob]
  })
  assert.deepEqual(engine.snapshot().pens[0].request.signatures, [
    z32.encode(pairs[1].publicKey)
  ])
})

test('a manual commit observation waits for matching metadata and content proof', async (t) => {
  const { engine, pairs, penId, srcKey } = await fixture(t, 2)
  const { output: request } = await engine.command('manual.request', {
    penId,
    srcKey
  })
  const room = engine.rooms.get(penId)
  const requestId = room.current.id
  const responses = pairs.map((pair) => sign(request, pair))
  const identity = keys.importIdentity(keyInput(pairs[1]))
  await engine._receive(
    room,
    protocol.create(
      identity,
      penId,
      {
        type: 'commit',
        manual: true,
        requestId,
        request,
        srcKey,
        responses
      },
      room.clock + 1
    )
  )
  assert.equal(engine.snapshot().pens[0].request.id, requestId)
  const req = SigningRequest.decode(z32.decode(request))
  const signatures = responses.map(
    (response) =>
      c.decode(CoreSign.messages.Response, z32.decode(response)).signatures
  )
  const source = await engine._source(srcKey)
  await signCore(
    room.target.core,
    source.core,
    signatures.map((value) => value[0]),
    { length: req.length, commit: true }
  )
  await engine.queue
  assert.equal(engine.snapshot().pens[0].request.id, requestId)
  await signCore(
    room.contentCore,
    source.blobs.core,
    signatures.map((value) => value[1]),
    { length: req.content.length, commit: true }
  )
  await until(() => engine.snapshot().pens[0].request === null)
  assert.ok(
    engine
      .snapshot()
      .pens[0].activity.some(
        (item) => item.type === 'commit' && item.author === identity.publicKey
      )
  )
})

test('late committed or wrong-fork requests cannot supersede an active request', async (t) => {
  const { engine, pairs, penId, srcKey } = await fixture(t, 2)
  const { output: first } = await engine.command('manual.request', {
    penId,
    srcKey
  })
  await engine.command('manual.commit', {
    penId,
    request: first,
    responses: pairs.map((pair) => sign(first, pair)),
    confirmation: 'COMMIT'
  })
  const source = await engine._drive(srcKey)
  await source.put('/app.js', Buffer.from('next snapshot'))
  await engine.command('request.create', { penId, srcKey })
  const current = engine.snapshot().pens[0].request
  const room = engine.rooms.get(penId)
  await engine._publish(room, { type: 'request', srcKey, request: first })
  assert.equal(engine.snapshot().pens[0].request.id, current.id)
  const wrongFork = z32.encode(
    await SigningRequest.generateDrive(source, {
      manifest: room.manifest,
      fork: 1
    })
  )
  await engine._publish(room, { type: 'request', srcKey, request: wrongFork })
  assert.equal(engine.snapshot().pens[0].request.id, current.id)
  assert.ok(
    engine
      .snapshot()
      .pens[0].activity.some((item) => item.request === wrongFork)
  )
  const clone = new Hyperdrive(engine.store.namespace('cloned-source'))
  await clone.ready()
  await clone.put('/app.js', Buffer.from('hello'))
  await clone.put('/app.js', Buffer.from('next snapshot'))
  const cloneKey = z32.encode(clone.key)
  await clone.close()
  const copied = await engine.command('manual.request', {
    penId,
    srcKey: cloneKey
  })
  assert.equal(copied.output, current.request)
  assert.notEqual(engine.snapshot().pens[0].request.id, current.id)
  assert.equal(
    engine.snapshot().pens[0].request.srcKey,
    `pear://${room.current.req.fork}.${room.current.req.length}.${cloneKey}`
  )
})

test('a different manual commit closes a stale automatic request without inventing its creator', async (t) => {
  const { engine, pairs, penId, srcKey } = await fixture(t, 2)
  await engine.command('request.create', { penId, srcKey })
  const first = engine.snapshot().pens[0].request
  const other = new Hyperdrive(
    engine.store.namespace('independent-manual-source')
  )
  await other.ready()
  await other.put('/app.js', Buffer.from('other committed snapshot'))
  const otherKey = z32.encode(other.key)
  await other.close()
  const room = engine.rooms.get(penId)
  const request = await engine._makeRequest(room, otherKey)
  await engine.command('manual.commit', {
    penId,
    request,
    srcKey: otherKey,
    responses: pairs.map((pair) => sign(request, pair)),
    confirmation: 'COMMIT'
  })
  assert.equal(engine.snapshot().pens[0].request, null)
  assert.equal(room.requests.get(first.id).status, 'unanswered')
  assert.equal(
    room.events.filter((event) => event.data.type === 'request').length,
    1
  )
  assert.ok(
    engine
      .snapshot()
      .pens[0].activity.some(
        (item) => item.type === 'commit' && item.request === request
      )
  )
  await assert.rejects(
    engine.command('request.response', { penId, requestId: first.id }),
    /not signed/
  )
  await engine._publish(room, { type: 'request', srcKey: otherKey, request })
  assert.equal(engine.snapshot().pens[0].request, null)
})

test(
  'two local peers exchange durable signed requests, reach quorum and commit',
  { timeout: 15000 },
  async (t) => {
    const swarm = new LocalSwarm()
    const {
      engine: alice,
      pairs,
      penId,
      srcKey,
      dir
    } = await fixture(t, 2, { swarm })
    const bobDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-bob-'))
    const bob = new PearPen({
      dir: bobDir,
      network: false,
      swarm: new LocalSwarm(),
      timeout: 3000
    })
    await bob.ready()
    await bob.command('profile.import', keyInput(pairs[1], 'Bob'))
    await bob.command('pen.add', { multisigKey: penId, name: 'App' })
    assert.equal(bob.snapshot().pens[0].quorum, 0)
    await alice.command('request.create', { penId, srcKey })
    const left = new SecretStream(true)
    const right = new SecretStream(false)
    left.on('error', () => {})
    right.on('error', () => {})
    left.rawStream.pipe(right.rawStream).pipe(left.rawStream)
    await Promise.all([left.opened, right.opened])
    alice._connection(left)
    bob._connection(right)
    t.after(async () => {
      left.destroy()
      right.destroy()
      await bob.close()
      fs.rmSync(bobDir, { force: true, recursive: true })
    })
    await until(
      () =>
        alice.snapshot().pens[0].peers === 1 &&
        bob.snapshot().pens[0].peers === 1
    )
    await until(() => bob.snapshot().pens[0].request)
    const requestId = bob.snapshot().pens[0].request.id
    await bob.command('request.sign', { penId, requestId })
    await until(() => alice.snapshot().pens[0].request.signatures.length === 1)
    await alice.command('request.sign', { penId, requestId })
    await until(() => bob.snapshot().pens[0].request.signatures.length === 2)
    await assert.rejects(
      bob.command('request.commit', {
        penId,
        requestId,
        confirmation: 'COMMIT'
      }),
      /Only the request creator/
    )
    const review = await bob.command('request.review', { penId, requestId })
    assert.equal(review.files[0].path, '/app.js')
    await alice.command('request.commit', {
      penId,
      requestId,
      confirmation: 'COMMIT'
    })
    await until(
      () =>
        bob.snapshot().pens[0].request === null &&
        bob.snapshot().pens[0].activity.some((item) => item.type === 'commit')
    )
    assert.equal(alice.snapshot().pens[0].request, null)
    assert.ok(
      bob.snapshot().pens[0].activity.some((event) => event.type === 'commit')
    )
    assert.ok(
      fs
        .readFileSync(path.join(dir, `events-${penId}.json`), 'utf8')
        .includes('commit')
    )
  }
)

test(
  'a fresh key-only peer recovers history beyond the pre-manifest buffer',
  { timeout: 30000 },
  async (t) => {
    const {
      engine: alice,
      pairs,
      penId,
      srcKey
    } = await fixture(t, 2, { swarm: new LocalSwarm() })
    const { output: request } = await alice.command('manual.request', {
      penId,
      srcKey
    })
    const room = alice.rooms.get(penId)
    const opened = protocol.create(
      alice.identity,
      penId,
      { type: 'request', srcKey, request },
      1
    )
    const bobIdentity = keys.importIdentity(keyInput(pairs[1]))
    room.events = [
      opened,
      protocol.create(
        alice.identity,
        penId,
        {
          type: 'response',
          requestId: opened.id,
          response: sign(request, pairs[0])
        },
        2
      ),
      protocol.create(
        bobIdentity,
        penId,
        {
          type: 'response',
          requestId: opened.id,
          response: sign(request, pairs[1])
        },
        3
      )
    ]
    for (let clock = 4; clock <= 270; clock++) {
      room.events.push(
        protocol.create(
          alice.identity,
          penId,
          { type: 'review', requestId: opened.id },
          clock
        )
      )
    }
    await alice._rebuild(room)
    const bobDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'pear-pen-history-test-')
    )
    const bob = new PearPen({
      dir: bobDir,
      network: false,
      swarm: new LocalSwarm()
    })
    await bob.ready()
    await bob.command('profile.import', keyInput(pairs[1]))
    await bob.command('pen.add', { name: 'App', multisigKey: penId })
    const loadManifest = bob._manifest.bind(bob)
    let holdManifest = true
    bob._manifest = async (room, required) => {
      if (!holdManifest || required) return loadManifest(room, required)
    }
    const receive = bob._receive.bind(bob)
    bob._receive = async (room, event) => {
      if (holdManifest && !room.manifest) return bob._buffer(room, event)
      return receive(room, event)
    }
    const left = new SecretStream(true)
    const right = new SecretStream(false)
    left.on('error', () => {})
    right.on('error', () => {})
    left.rawStream.pipe(right.rawStream).pipe(left.rawStream)
    await Promise.all([left.opened, right.opened])
    alice._connection(left)
    bob._connection(right)
    t.after(async () => {
      left.destroy()
      right.destroy()
      await bob.close()
      fs.rmSync(bobDir, { force: true, recursive: true })
    })
    const bobRoom = bob.rooms.get(penId)
    await until(() => bobRoom.pending.length === 256)
    await bob.queue
    assert.equal(bobRoom.events.length, 0)
    holdManifest = false
    await bob._manifest(bobRoom)
    await until(() => bobRoom.events.length === 270)
    assert.equal(bob.snapshot().pens[0].activity.length, 270)
    assert.deepEqual(
      bob.snapshot().pens[0].request.signatures.sort(),
      pairs.map((pair) => z32.encode(pair.publicKey)).sort()
    )
  }
)
