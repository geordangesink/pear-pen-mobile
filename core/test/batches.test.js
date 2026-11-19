const assert = require('node:assert/strict')
const test = require('node:test')
const { createUpdateBatch } = require('../lib/batches')

test('an append failure closes its temporary batch and preserves the error', async () => {
  const failure = new Error('Append failed')
  let closed = 0
  const batch = {
    append: async () => {
      throw failure
    },
    close: async () => {
      closed++
    }
  }
  const core = { length: 0, session: () => batch }
  const source = {
    length: 1,
    download: () => ({ done: async () => {} }),
    get: async () => Buffer.from('block')
  }
  await assert.rejects(
    createUpdateBatch(core, source),
    (error) => error === failure
  )
  assert.equal(closed, 1)
})
