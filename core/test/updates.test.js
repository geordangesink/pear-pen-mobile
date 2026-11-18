const assert = require('node:assert/strict')
const test = require('node:test')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { once, EventEmitter } = require('node:events')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const SecretStream = require('@hyperswarm/secret-stream')
const PearRuntime = require('pear-runtime')
const z32 = require('z32')

test(
  'the real OTA updater downloads from a local peer and swaps the installed app',
  { timeout: 15000, skip: process.platform === 'win32' },
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-pen-ota-test-'))
    const publisher = new Corestore(path.join(dir, 'publisher'))
    const subscriber = new Corestore(path.join(dir, 'subscriber'))
    const drive = new Hyperdrive(publisher)
    await drive.ready()
    const name = 'PearPen.app'
    const host = `${process.platform}-${process.arch}`
    await drive.put(
      '/package.json',
      Buffer.from(
        JSON.stringify({ name: 'pear-pen-desktop', version: '1.0.1' })
      )
    )
    await drive.put(
      `/by-arch/${host}/app/${name}/Contents/version.txt`,
      Buffer.from('1.0.1')
    )
    const installed = path.join(dir, name)
    fs.mkdirSync(path.join(installed, 'Contents'), { recursive: true })
    fs.writeFileSync(path.join(installed, 'Contents/version.txt'), '1.0.0')
    const left = new SecretStream(true)
    const right = new SecretStream(false)
    left.on('error', () => {})
    right.on('error', () => {})
    left.rawStream.pipe(right.rawStream).pipe(left.rawStream)
    await Promise.all([left.opened, right.opened])
    publisher.replicate(left)
    subscriber.replicate(right)
    const runtime = new PearRuntime({
      dir: path.join(dir, 'runtime'),
      version: '1.0.0',
      upgrade: `pear://${z32.encode(drive.key)}`,
      name,
      app: installed,
      delay: 0,
      store: subscriber,
      swarm: new EventEmitter()
    })
    t.after(async () => {
      left.destroy()
      right.destroy()
      await runtime.close()
      await drive.close()
      await publisher.close()
      await subscriber.close()
      fs.rmSync(dir, { recursive: true, force: true })
    })
    const updated = once(runtime.updater, 'updated')
    await runtime.ready()
    await updated
    assert.equal(runtime.updater.nextVersion, '1.0.1')
    assert.equal(
      fs.readFileSync(path.join(installed, 'Contents/version.txt'), 'utf8'),
      '1.0.0'
    )
    await runtime.updater.applyUpdate()
    assert.equal(runtime.updater.applied, true)
    assert.equal(
      fs.readFileSync(path.join(installed, 'Contents/version.txt'), 'utf8'),
      '1.0.1'
    )
  }
)
