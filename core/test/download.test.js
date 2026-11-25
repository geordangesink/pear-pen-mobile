const assert = require('node:assert/strict')
const test = require('node:test')
const EventEmitter = require('node:events')
const download = require('../lib/download')

class Transfer extends EventEmitter {
  constructor() {
    super()
    this.destroyed = 0
    this.ranges = []
    this.completed = new Promise((resolve, reject) => {
      this.finish = resolve
      this.fail = reject
    })
  }

  download(range) {
    this.ranges.push(range)
    return {
      done: () => this.completed,
      destroy: () => this.destroyed++
    }
  }
}

test('stalled downloads fail and release their range and listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const core = new Transfer()
  const existing = () => {}
  core.on('download', existing)
  const pending = download(core, 2, 5, { timeout: 50 })
  const failure = assert.rejects(pending, /The source data is unavailable/)
  t.mock.timers.tick(50)
  await failure
  assert.equal(core.destroyed, 1)
  assert.deepEqual(core.listeners('download'), [existing])
  assert.deepEqual(core.ranges, [{ start: 2, end: 5 }])
})

test('relevant progress keeps a transfer alive beyond one timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const core = new Transfer()
  let progress = 0
  const pending = download(core, 2, 5, {
    timeout: 50,
    onprogress: () => progress++
  })
  t.mock.timers.tick(40)
  core.emit('download', 2)
  t.mock.timers.tick(40)
  core.emit('download', 3)
  t.mock.timers.tick(40)
  assert.equal(core.destroyed, 0)
  core.finish()
  await pending
  assert.equal(progress, 2)
  assert.equal(core.destroyed, 1)
  assert.equal(core.listenerCount('download'), 0)
  t.mock.timers.tick(1000)
  core.emit('download', 4)
  assert.equal(progress, 2)
})

test('downloads outside the requested range do not postpone a stall', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const core = new Transfer()
  let progress = 0
  const pending = download(core, 2, 5, {
    timeout: 50,
    onprogress: () => progress++
  })
  const failure = assert.rejects(pending, /The source data is unavailable/)
  t.mock.timers.tick(40)
  for (const index of [1, 5, undefined, NaN]) core.emit('download', index)
  t.mock.timers.tick(10)
  await failure
  assert.equal(progress, 0)
  assert.equal(core.destroyed, 1)
  assert.equal(core.listenerCount('download'), 0)
})

test('range failures keep their cause and clean up progress tracking', async () => {
  const core = new Transfer()
  const error = new Error('Source disconnected')
  const pending = download(core, 0, 3, { timeout: 1000 })
  const failure = assert.rejects(pending, (cause) => cause === error)
  core.fail(error)
  await failure
  assert.equal(core.destroyed, 1)
  assert.equal(core.listenerCount('download'), 0)
})

test('empty and already cached ranges complete without waiting', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const core = new Transfer()
  await download(core, 3, 3, { timeout: 50 })
  assert.deepEqual(core.ranges, [])
  core.finish()
  await download(core, 0, 3, { timeout: 50 })
  assert.equal(core.destroyed, 1)
  assert.equal(core.listenerCount('download'), 0)
  t.mock.timers.tick(1000)
})
