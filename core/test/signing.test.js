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
const Hyperdrive = require('hyperdrive')
const SecretStream = require('@hyperswarm/secret-stream')
const CoreSign = require('hypercore-sign')
const SigningRequest = require('hypercore-signing-request')
const PearPen = require('..')
const keys = require('../lib/keys')
const protocol = require('../lib/protocol')

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
  const target = await engine.tools.createDrive(
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
  const target = await engine.tools.createDrive(
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
  await assert.rejects(
    engine.command('request.sign', { penId, requestId: room.current.id }),
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
  const different = await engine.tools.createDrive(
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
  const engine = new PearPen({
    dir: path.join(dir, 'original'),
    network: false
  })
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
  const state = await engine.command('profile.import', { name: '  Alice  ' })
  assert.equal(state.profile.name, 'Alice')
  assert.equal(state.profile.encrypted, false)
  const publicExport = await engine.command('profile.export', {
    kind: 'public'
  })
  const privateExport = await engine.command('profile.export', {
    kind: 'private'
  })
  assert.equal(publicExport.name, 'default.public')
  assert.equal(publicExport.key, state.profile.publicKey)
  assert.equal(privateExport.name, 'default')
  assert.equal(privateExport.encrypted, false)
  assert.equal(z32.decode(privateExport.key).length, 64)
  target = await engine.tools.createDrive([publicExport.key], 'test/generated')
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
  const { output: response } = await engine.command('manual.response', {
    penId,
    request
  })
  await CoreSign.verify(response, request, publicExport.key)
  await assert.rejects(
    engine.command('profile.export', { kind: 'private', password: '1234567' }),
    /at least 8 bytes/
  )
  const password = 'éééé'
  const encryptedExport = await engine.command('profile.export', {
    kind: 'private',
    password
  })
  assert.equal(encryptedExport.encrypted, true)
  const packed = c.decode(keys.encryptedKey, z32.decode(encryptedExport.key))
  assert.equal(packed.mem, 16 * 1024 * 1024)
  const req = SigningRequest.decode(z32.decode(request))
  const securePassword = sodium.sodium_malloc(Buffer.byteLength(password))
  securePassword.write(password)
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
  await reimported.command('profile.import', { secretKey: privateExport.key })
  await reimported.close()
  reimported = new PearPen({
    dir: path.join(dir, 'reimported'),
    network: false
  })
  await reimported.ready()
  assert.equal(reimported.snapshot().profile.publicKey, publicExport.key)
  assert.deepEqual(
    await reimported.command('profile.export', { kind: 'private' }),
    privateExport
  )
  for (const key of [privateExport.key, encryptedExport.key]) {
    await assert.rejects(
      engine.command('dialog.save', { dialog: { output: key } }),
      /Private keys cannot be saved/
    )
    assert.ok(!JSON.stringify(engine.snapshot()).includes(key))
    assert.ok(
      !fs
        .readFileSync(path.join(dir, 'original/state.json'), 'utf8')
        .includes(key)
    )
  }
  assert.equal(engine.snapshot().dialog, null)
  assert.ok(
    !fs
      .readFileSync(path.join(dir, 'original/identity.json'), 'utf8')
      .includes(password)
  )
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
  await engine.command('profile.import', { name: 'Alice' })
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
    assert.equal(engine.snapshot().profile.name, profile?.name || '')
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

test('a missing saved identity produces a recovery error instead of generating replacement keys', async (t) => {
  const dir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pear-pen-missing-identity-test-')
  )
  let engine = new PearPen({ dir, network: false })
  t.after(async () => {
    await engine.close()
    fs.rmSync(dir, { force: true, recursive: true })
  })
  await engine.command('profile.import')
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
    const other = await bob.tools.createDrive(
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
    await until(() => alice.snapshot().pens[0].request === null)
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
  const metadata = await engine.tools.createUpdateBatch(
    room.target.core,
    source.core,
    { end: req.length }
  )
  await engine.tools.commitUpdateBatch(
    room.target.core,
    metadata,
    signatures.map((value) => value[0]),
    { length: req.length }
  )
  await metadata.close()
  await engine.queue
  assert.equal(engine.snapshot().pens[0].request.id, requestId)
  const content = await engine.tools.createUpdateBatch(
    room.contentCore,
    source.blobs.core,
    { end: req.content.length }
  )
  await engine.tools.commitUpdateBatch(
    room.contentCore,
    content,
    signatures.map((value) => value[1]),
    { length: req.content.length }
  )
  await content.close()
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
  assert.equal(engine.snapshot().pens[0].request.srcKey, cloneKey)
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
    await until(() => bob.snapshot().pens[0].request === null)
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
