const assert = require('node:assert/strict')
const test = require('node:test')
const crypto = require('hypercore-crypto')
const z32 = require('z32')
const keys = require('../lib/keys')
const protocol = require('../lib/protocol')
const rebuildActivity = require('../lib/activity')

function fixture() {
  const identities = Array.from({ length: 2 }, () =>
    keys.importIdentity({ secretKey: z32.encode(crypto.keyPair().secretKey) })
  )
  const target = z32.encode(Buffer.alloc(32, 1))
  const source = z32.encode(Buffer.alloc(32, 2))
  const request = z32.encode(Buffer.from('author-name activity fixture'))
  const room = {
    pen: { multisigKey: target },
    manifest: {
      signers: identities.map((identity) => ({
        publicKey: z32.decode(identity.publicKey)
      }))
    },
    events: [],
    target: { core: { fork: 0, length: 0 } }
  }
  const event = (actor, type, clock, authorName, payload = {}) =>
    protocol.create(
      identities[actor],
      target,
      {
        type,
        request,
        srcKey: source,
        ...(type !== 'request' && { manual: true, responses: [] }),
        ...(authorName !== undefined && { authorName }),
        ...payload
      },
      clock
    )
  const callbacks = {
    parseRequest: () => ({ fork: 0, length: 3, manifest: { quorum: 1 } }),
    verifyResponses: async (_, values) =>
      new Map(
        values.includes('Alice signature')
          ? [[identities[0].publicKey, { response: 'Alice signature' }]]
          : []
      ),
    isCommitted: async () => false
  }
  return { identities, room, event, callbacks, target }
}

test('signed names are optional, bounded strings', () => {
  const { event, target, identities } = fixture()
  const signers = identities.map((identity) => identity.publicKey)
  for (const name of [undefined, '', 'Alice', 'x'.repeat(120)])
    assert.equal(
      protocol.verify(event(0, 'request', 1, name), target, signers),
      true
    )
  for (const name of [null, 42, [], {}, 'x'.repeat(121)])
    assert.equal(
      protocol.verify(event(0, 'request', 1, name), target, signers),
      false
    )
})

test('activity uses the newest own signed name and preserves legacy names', async () => {
  const { room, event, callbacks } = fixture()
  room.events = [
    event(0, 'request', 1, 'Alice'),
    event(0, 'review', 2, '  Alice renamed  '),
    event(0, 'review', 3)
  ]
  const original = JSON.stringify(room.events)
  const state = await rebuildActivity(room, callbacks)
  assert.equal(state.activity.length, 3)
  assert.ok(state.activity.every((item) => item.authorName === 'Alice renamed'))
  assert.equal(JSON.stringify(room.events), original)
})

test('an authenticated empty name clears the display name', async () => {
  const { room, event, callbacks } = fixture()
  room.events = [
    event(0, 'request', 1, 'Alice'),
    event(0, 'review', 2, ''),
    event(0, 'review', 3)
  ]
  const state = await rebuildActivity(room, callbacks)
  assert.equal(state.activity.length, 3)
  assert.ok(state.activity.every((item) => !Object.hasOwn(item, 'authorName')))
})

test('a relay cannot give its name to a different response signer', async () => {
  const { room, event, callbacks, identities } = fixture()
  room.events = [
    event(1, 'request', 1, 'Pretending to be Alice'),
    event(1, 'review', 2, 'Pretending to be Alice', {
      responses: ['Alice signature']
    })
  ]
  const state = await rebuildActivity(room, callbacks)
  const response = state.activity.find((item) => item.type === 'response')
  assert.equal(response.author, identities[0].publicKey)
  assert.equal(Object.hasOwn(response, 'authorName'), false)
  assert.equal(response.sharedBy, identities[1].publicKey)
  assert.equal(response.sharedByName, 'Pretending to be Alice')
})

test('relayed signatures use only the signer’s own authenticated name', async () => {
  const { room, event, callbacks } = fixture()
  room.events = [
    event(0, 'request', 1, 'Alice'),
    event(1, 'review', 2, 'Relay', { responses: ['Alice signature'] })
  ]
  const forged = event(0, 'review', 3, 'Alice')
  forged.data.authorName = 'Forged name'
  room.events.push(forged)
  const state = await rebuildActivity(room, callbacks)
  const response = state.activity.find((item) => item.type === 'response')
  assert.equal(response.authorName, 'Alice')
  assert.equal(response.sharedByName, 'Relay')
  assert.equal(
    state.activity.some((item) => item.authorName === 'Forged name'),
    false
  )
})

test('display names remain literal text for the UI to escape', async () => {
  const { room, event, callbacks } = fixture()
  const name = '<b>Alice & Bob</b>'
  room.events = [event(0, 'request', 1, name)]
  const state = await rebuildActivity(room, callbacks)
  assert.equal(state.activity[0].authorName, name)
})
