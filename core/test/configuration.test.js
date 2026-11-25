const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('hypercore-crypto')
const Hypercore = require('hypercore')
const Hyperdrive = require('hyperdrive')
const z32 = require('z32')
const PearPen = require('..')
const {
  parseConfiguration,
  serializeManifest
} = require('../lib/configuration')

function recipe(publicKeys, namespace = 'test/configuration-editor') {
  return {
    project: { label: 'Keep this project metadata', options: [1, true, null] },
    multisig: { namespace, publicKeys, quorum: 1, note: 'Keep this note' }
  }
}

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-configuration-'))
  const context = { dir, engine: null, publications: 0 }
  const open = async () => {
    context.engine = new PearPen({ dir, network: false, timeout: 100 })
    await context.engine.ready()
    const publish = context.engine._publish.bind(context.engine)
    context.engine._publish = (...args) => {
      context.publications++
      return publish(...args)
    }
  }
  context.restart = async () => {
    await context.engine.close()
    await open()
  }
  t.after(async () => {
    await context.engine?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  await open()
  await context.engine.command('profile.import', {
    secretKey: z32.encode(crypto.keyPair().secretKey)
  })
  context.config = recipe([
    context.engine.snapshot().profile.publicKey,
    z32.encode(crypto.keyPair().publicKey)
  ])
  context.text = JSON.stringify(context.config)
  context.key = parseConfiguration(context.text).multisigKey
  return context
}

test('full recipe JSON is preserved and every signing-policy edit changes its key', () => {
  const keys = [1, 2].map((value) => z32.encode(Buffer.alloc(32, value)))
  const config = recipe(keys)
  const parsed = parseConfiguration(JSON.stringify(config))
  assert.deepEqual(JSON.parse(parsed.config), config)
  for (const edit of [
    { namespace: 'another/namespace' },
    { publicKeys: [...keys].reverse() },
    { publicKeys: keys.slice(0, 1) },
    { quorum: 2 }
  ]) {
    const changed = { ...config, multisig: { ...config.multisig, ...edit } }
    assert.notEqual(
      parseConfiguration(JSON.stringify(changed)).multisigKey,
      parsed.multisigKey
    )
  }
})

test('raw version 1 manifests round-trip all supported public fields', () => {
  const config = recipe([z32.encode(crypto.keyPair().publicKey)])
  const manifest = parseConfiguration(JSON.stringify(config)).manifest
  manifest.allowPatch = true
  manifest.prologue = { hash: crypto.hash(Buffer.from('prologue')), length: 2 }
  const raw = {
    manifest: serializeManifest(manifest),
    custom: { retained: true }
  }
  const parsed = parseConfiguration(JSON.stringify(raw))
  assert.equal(parsed.multisigKey, z32.encode(Hypercore.key(manifest)))
  assert.equal(parsed.manifest.allowPatch, true)
  assert.equal(parsed.manifest.prologue.length, 2)
  assert.deepEqual(JSON.parse(parsed.config), raw)
  for (const edit of [
    { version: 2 },
    { hash: 'sha256' },
    { allowPatch: 'true' },
    { userData: '00' },
    { linked: [config.multisig.publicKeys[0]] },
    { unsupportedPolicy: true },
    { signers: [{ ...raw.manifest.signers[0], signature: 'rsa' }] },
    { prologue: { ...raw.manifest.prologue, length: -1 } }
  ]) {
    assert.throws(() =>
      parseConfiguration(
        JSON.stringify({ manifest: { ...raw.manifest, ...edit } })
      )
    )
  }
})

test('configuration previews work before creation and never initialize or save a pen', async (t) => {
  const context = await fixture(t)
  const engine = context.engine
  const creating = await engine.command('pen.preview', { config: context.text })
  assert.equal(creating.multisigKey, context.key)
  assert.equal(creating.changed, false)
  await engine.command('pen.add', { multisigKey: context.key })
  const room = engine.rooms.get(context.key)
  const empty = JSON.parse(
    (await engine.command('pen.configuration', { penId: context.key })).config
  )
  assert.deepEqual(empty, {
    multisig: { namespace: '', publicKeys: [], quorum: 1 }
  })
  const before = fs.readFileSync(path.join(context.dir, 'state.json'))
  const state = engine.snapshot()
  const changedConfig = recipe(
    context.config.multisig.publicKeys,
    'changed/namespace'
  )
  const changed = await engine.command('pen.preview', {
    penId: context.key,
    config: JSON.stringify(changedConfig)
  })
  assert.equal(changed.changed, true)
  assert.notEqual(changed.multisigKey, context.key)
  const expected = await engine.command('pen.preview', {
    config: context.text,
    multisigKey: changed.multisigKey
  })
  assert.equal(expected.changed, true)
  assert.equal(room.target.core.manifest, null)
  assert.deepEqual(engine.snapshot(), state)
  assert.deepEqual(
    fs.readFileSync(path.join(context.dir, 'state.json')),
    before
  )
  assert.equal(context.publications, 0)
})

test('config-only creation and same-key editing preserve full local JSON across restart', async (t) => {
  const context = await fixture(t)
  let engine = context.engine
  await engine.command('pen.add', {
    config: context.text,
    name: 'Configured pen'
  })
  assert.equal(engine.snapshot().pens[0].multisigKey, context.key)
  assert.equal(engine.snapshot().pens[0].quorum, 1)
  const edited = {
    ...context.config,
    extra: { local: 'Never gossip this field' }
  }
  await engine.command('pen.configure', {
    penId: context.key,
    config: JSON.stringify(edited),
    name: 'Edited pen'
  })
  await context.restart()
  engine = context.engine
  assert.equal(engine.snapshot().pens[0].name, 'Edited pen')
  assert.equal(engine.snapshot().pens[0].multisigKey, context.key)
  assert.deepEqual(
    JSON.parse(
      (await engine.command('pen.configuration', { penId: context.key })).config
    ),
    edited
  )
  assert.equal(context.publications, 0)
  assert.deepEqual(engine.rooms.get(context.key).events, [])
})

test('unnamed pens display their canonical link on creation, rename and restart', async (t) => {
  const context = await fixture(t)
  const { engine, key, text } = context
  const link = `pear://${key}`
  const created = await engine.command('pen.add', { config: text })
  assert.equal(created.pens[0].name, link)
  const renamed = await engine.command('pen.configure', {
    penId: key,
    config: text,
    name: 'Releases'
  })
  assert.equal(renamed.pens[0].name, 'Releases')
  const cleared = await engine.command('pen.configure', {
    penId: key,
    config: text,
    name: '   '
  })
  assert.equal(cleared.pens[0].name, link)
  await engine.command('pen.remove', { penId: key })
  const added = await engine.command('pen.add', {
    multisigKey: z32.decode(key).toString('hex')
  })
  assert.equal(added.pens[0].name, link)
  await context.restart()
  assert.equal(context.engine.snapshot().pens[0].name, link)
})

test('legacy default pen names migrate while new explicit names survive restart', async (t) => {
  const context = await fixture(t)
  await context.engine.command('pen.add', { multisigKey: context.key })
  const other = z32.encode(crypto.keyPair().publicKey)
  await context.engine.command('pen.add', {
    multisigKey: other,
    name: 'Original pen'
  })
  const file = path.join(context.dir, 'state.json')
  const legacy = JSON.parse(fs.readFileSync(file, 'utf8'))
  delete legacy.version
  legacy.pens[0].name = 'Untitled pen'
  fs.writeFileSync(file, JSON.stringify(legacy))
  await context.restart()
  const pens = context.engine.snapshot().pens
  assert.equal(pens[0].name, `pear://${context.key}`)
  assert.equal(pens[1].name, 'Original pen')
  await context.engine.command('pen.configure', {
    penId: context.key,
    config: context.text,
    name: 'Untitled pen'
  })
  await context.restart()
  assert.equal(context.engine.snapshot().pens[0].name, 'Untitled pen')
})

test('verified configuration clears a legacy quorum hint without changing the link', async (t) => {
  const context = await fixture(t)
  await context.engine.command('pen.add', {
    multisigKey: context.key,
    quorum: 2
  })
  assert.equal(context.engine.snapshot().pens[0].configuredQuorum, 2)
  await context.engine.command('pen.configure', {
    penId: context.key,
    config: context.text
  })
  const pen = context.engine.snapshot().pens[0]
  assert.equal(pen.multisigKey, context.key)
  assert.equal(pen.configuredQuorum, null)
  assert.equal(pen.quorum, 1)
  assert.equal(pen.quorumMismatch, false)
})

test('known manifests without the original recipe use raw JSON without inventing a namespace', async (t) => {
  const context = await fixture(t)
  const parsed = parseConfiguration(context.text)
  const core = context.engine.store.get({ manifest: parsed.manifest })
  await core.ready()
  await core.close()
  await context.engine.command('pen.add', { multisigKey: context.key })
  const value = (
    await context.engine.command('pen.configuration', { penId: context.key })
  ).config
  const config = JSON.parse(value)
  assert.equal(config.multisig, undefined)
  assert.equal(
    config.manifest.signers[0].namespace,
    z32.encode(crypto.hash(Buffer.from(context.config.multisig.namespace)))
  )
  assert.equal(parseConfiguration(value).multisigKey, context.key)
  await context.engine.command('pen.configure', {
    penId: context.key,
    config: value
  })
  assert.equal(context.engine.snapshot().pens[0].multisigKey, context.key)
})

test('existing links and explicit creation links reject mismatched configurations atomically', async (t) => {
  const context = await fixture(t)
  const engine = context.engine
  await engine.command('pen.add', { multisigKey: context.key })
  const wrong = JSON.stringify(
    recipe(context.config.multisig.publicKeys, 'wrong/key')
  )
  const derived = parseConfiguration(wrong).multisigKey
  const before = fs.readFileSync(path.join(context.dir, 'state.json'))
  const state = engine.snapshot()
  const mismatch = (error) =>
    error.code === 'CONFIGURATION_KEY_MISMATCH' &&
    error.expectedKey === context.key &&
    error.derivedKey === derived &&
    error.message.includes(context.key) &&
    error.message.includes(derived)
  for (const strategy of [undefined, 'create', 'replace']) {
    await assert.rejects(
      engine.command('pen.configure', {
        penId: context.key,
        config: wrong,
        strategy
      }),
      mismatch
    )
  }
  await assert.rejects(
    engine.command('pen.add', { multisigKey: context.key, config: wrong }),
    mismatch
  )
  assert.deepEqual(engine.snapshot(), state)
  assert.deepEqual(
    fs.readFileSync(path.join(context.dir, 'state.json')),
    before
  )
  assert.equal(engine.rooms.get(context.key).target.core.manifest, null)
  assert.equal(engine.rooms.size, 1)
  assert.equal(engine.drives.size, 1)
  assert.equal(context.publications, 0)
})

test('failed config creation releases its candidate room without saving partial state', async (t) => {
  const context = await fixture(t)
  const engine = context.engine
  const before = fs.readFileSync(path.join(context.dir, 'state.json'))
  engine._installManifest = async () => {
    throw new Error('Initialization failed')
  }
  await assert.rejects(
    engine.command('pen.add', { config: context.text }),
    /Initialization failed/
  )
  assert.deepEqual(engine.snapshot().pens, [])
  assert.equal(engine.rooms.size, 0)
  assert.equal(engine.drives.size, 0)
  assert.deepEqual(
    fs.readFileSync(path.join(context.dir, 'state.json')),
    before
  )
})

test('verified source configuration is saved whole without adding JSON to activity messages', async (t) => {
  const context = await fixture(t)
  const source = new Hyperdrive(context.engine.store.namespace('editor-source'))
  await source.ready()
  await source.put('/app.js', Buffer.from('hello'))
  await source.put('/pear.json', Buffer.from(context.text))
  const srcKey = z32.encode(source.key)
  await source.close()
  await context.engine.command('pen.add', { multisigKey: context.key })
  await context.engine.command('request.create', { penId: context.key, srcKey })
  const value = (
    await context.engine.command('pen.configuration', { penId: context.key })
  ).config
  assert.deepEqual(JSON.parse(value), context.config)
  const events = context.engine.rooms.get(context.key).events
  assert.equal(events.length, 1)
  assert.equal(events[0].data.type, 'request')
  assert.equal(
    JSON.stringify(events).includes(context.config.project.label),
    false
  )
})
