const assert = require('node:assert/strict')
const test = require('node:test')
const crypto = require('hypercore-crypto')
const z32 = require('z32')
const protocol = require('../lib/protocol')
const keys = require('../lib/keys')
const rebuildActivity = require('../lib/activity')

const key = z32.encode(Buffer.alloc(32, 1))
const target = z32.encode(Buffer.alloc(32, 2))

test('plain source keys retain the existing canonical wire format', () => {
  for (const value of [
    key,
    `pear://${key}`,
    ` pear://${key}/ `,
    Buffer.alloc(32, 1).toString('hex')
  ]) {
    assert.deepEqual(protocol.parseSource(value), {
      key,
      fork: null,
      length: null,
      link: key
    })
    assert.equal(protocol.normalizeSource(value), key)
  }
  assert.equal(protocol.normalizeKey(`pear://${key}/`), key)
  assert.throws(() => protocol.normalizeKey(`pear://0.3.${key}`))
})

test('versioned sources preserve fork, length and zero values', () => {
  for (const [fork, length] of [
    [0, 0],
    [0, 3],
    [2, 0],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]
  ]) {
    const link = `pear://${fork}.${length}.${key}`
    assert.deepEqual(protocol.parseSource(link + '/'), {
      key,
      fork,
      length,
      link
    })
    assert.equal(protocol.normalizeSource(link), link)
  }
  assert.equal(
    protocol.normalizeSource(`pear://000.003.${key}/`),
    `pear://0.3.${key}`
  )
})

test('source links reject malformed versions and URL suffixes', () => {
  const invalid = [
    undefined,
    null,
    42,
    {},
    '',
    `0.3.${key}`,
    `pear://0.${key}`,
    `pear://.3.${key}`,
    `pear://0..${key}`,
    `pear://-1.3.${key}`,
    `pear://0.-1.${key}`,
    `pear://-0.3.${key}`,
    `pear://1.5.3.${key}`,
    `pear://0.1.5.${key}`,
    `pear://1e2.3.${key}`,
    `pear://+1.3.${key}`,
    `pear://0.+3.${key}`,
    `pear://9007199254740992.3.${key}`,
    `pear://0.9007199254740992.${key}`,
    `pear://0.3.`,
    `pear://0.3.invalid`,
    `pear://${key}/file`,
    `pear://${key}?q=1`,
    `pear://${key}#section`,
    `pear://0.3.${key}/file`,
    `pear://0.3.${key}?q=1`,
    `pear://0.3.${key}#section`,
    `pear://0.3.${key}//`,
    `pear://0.3.${key}\\file`
  ]
  for (const value of invalid) assert.throws(() => protocol.parseSource(value))
})

function activityFixture(srcKey, type = 'request') {
  const identity = keys.importIdentity({
    secretKey: z32.encode(crypto.keyPair().secretKey)
  })
  const request = z32.encode(Buffer.from('source-link activity fixture'))
  const payload =
    type === 'request'
      ? { type, srcKey, request }
      : { type, srcKey, request, manual: true, responses: [] }
  const event = protocol.create(identity, target, payload, 1)
  const room = {
    pen: { multisigKey: target },
    manifest: { signers: [{ publicKey: z32.decode(identity.publicKey) }] },
    events: [event],
    target: { core: { fork: 0, length: 0 } }
  }
  const callbacks = {
    parseRequest: () => ({ fork: 0, length: 3, manifest: { quorum: 1 } }),
    verifyResponses: async () => new Map(),
    isCommitted: async () => false
  }
  return { room, callbacks, event }
}

test('activity derives the versioned source from legacy signed requests', async () => {
  for (const value of [key, `pear://${key}`, `pear://0.3.${key}/`]) {
    const { room, callbacks, event } = activityFixture(value)
    const original = JSON.stringify(event)
    const state = await rebuildActivity(room, callbacks)
    assert.equal(state.current.srcKey, `pear://0.3.${key}`)
    assert.equal(state.requests.get(event.id).srcKey, `pear://0.3.${key}`)
    assert.equal(JSON.stringify(event), original)
  }
})

test('activity rejects mismatched explicit pins and versioned target aliases', async () => {
  for (const value of [
    `pear://1.3.${key}`,
    `pear://0.4.${key}`,
    `pear://0.3.${target}`
  ]) {
    const { room, callbacks } = activityFixture(value)
    const state = await rebuildActivity(room, callbacks)
    assert.equal(state.requests.size, 0)
    assert.equal(state.current, null)
  }
})

test('manual review accepts a matching source version and rejects mismatches', async () => {
  for (const value of [key, `pear://0.3.${key}`]) {
    const { room, callbacks } = activityFixture(value, 'review')
    assert.equal(
      (await rebuildActivity(room, callbacks)).activity[0].type,
      'review'
    )
  }
  for (const value of [
    `pear://0.2.${key}`,
    `pear://1.3.${key}`,
    `pear://0.3.${target}`
  ]) {
    const { room, callbacks } = activityFixture(value, 'review')
    assert.deepEqual((await rebuildActivity(room, callbacks)).activity, [])
  }
})
