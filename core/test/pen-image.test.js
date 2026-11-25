const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('hypercore-crypto')
const z32 = require('z32')
const PearPen = require('..')

const images = [
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGPQ2BIAAAI0AS1lNoRhAAAAAElFTkSuQmCC',
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwBKKKK8g+IP/9k=',
  'data:image/webp;base64,UklGRjgAAABXRUJQVlA4ICwAAACwAQCdASoBAAEAAUAmJaACdLoABKoAAP4TH/AXT3Ri3/69H/56P/z0f5wAAA=='
]

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-image-'))
  const context = {
    dir,
    penId: z32.encode(crypto.keyPair().publicKey),
    engine: null,
    publications: 0
  }
  const open = async () => {
    context.engine = new PearPen({ dir, network: false, timeout: 50 })
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
  await context.engine.command('pen.add', {
    multisigKey: context.penId,
    name: 'Local image'
  })
  return context
}

test('local raster images survive restart and can be cleared without gossip', async (t) => {
  const context = await fixture(t)
  assert.equal(context.engine.snapshot().pens[0].image, null)
  for (const image of images) {
    const state = await context.engine.command('pen.image', {
      penId: context.penId,
      image
    })
    assert.equal(state.pens[0].image, image)
    assert.deepEqual(context.engine.rooms.get(context.penId).events, [])
    await context.restart()
    assert.equal(context.engine.snapshot().pens[0].image, image)
  }
  await context.engine.command('pen.image', {
    penId: context.penId,
    image: null
  })
  await context.restart()
  assert.equal(context.engine.snapshot().pens[0].image, null)
  assert.equal(context.publications, 0)
  assert.deepEqual(context.engine.rooms.get(context.penId).events, [])
})

test('removing a pen discards its local image when the pen is added again', async (t) => {
  const context = await fixture(t)
  await context.engine.command('pen.image', {
    penId: context.penId,
    image: images[0]
  })
  await context.engine.command('pen.remove', { penId: context.penId })
  await context.restart()
  assert.deepEqual(context.engine.snapshot().pens, [])
  await context.engine.command('pen.add', { multisigKey: context.penId })
  assert.equal(context.engine.snapshot().pens[0].image, null)
  assert.equal(context.publications, 0)
  assert.deepEqual(context.engine.rooms.get(context.penId).events, [])
})

test('unsafe image inputs fail before saving or publishing state', async (t) => {
  const context = await fixture(t)
  const engine = context.engine
  await engine.command('pen.image', { penId: context.penId, image: images[0] })
  const state = engine.snapshot()
  const saved = fs.readFileSync(path.join(context.dir, 'state.json'))
  let writes = 0
  let stateEvents = 0
  const save = engine._save.bind(engine)
  engine._save = () => {
    writes++
    return save()
  }
  engine.on('state', () => stateEvents++)
  const invalid = [
    undefined,
    {},
    '<img src=x onerror=alert(1)>',
    'https://example.com/image.png',
    'file:///tmp/image.png',
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIj48L3N2Zz4=',
    'data:image/gif;base64,R0lGODlh',
    'data:image/png;base64,',
    'data:image/png;base64,not-base64!',
    'data:image/png;base64,A===',
    `data:image/png;base64,${Buffer.alloc(100 * 1024).toString('base64')}`
  ]
  for (const image of invalid) {
    await assert.rejects(
      engine.command('pen.image', { penId: context.penId, image }),
      /Choose a JPEG, PNG or WebP image no larger than 128 KB/
    )
    assert.deepEqual(engine.snapshot(), state)
    assert.deepEqual(
      fs.readFileSync(path.join(context.dir, 'state.json')),
      saved
    )
  }
  assert.equal(writes, 0)
  assert.equal(stateEvents, 0)
  assert.equal(context.publications, 0)
  assert.deepEqual(engine.rooms.get(context.penId).events, [])
})
