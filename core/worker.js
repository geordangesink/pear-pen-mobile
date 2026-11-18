const path = require('bare-path')
const fs = require('bare-fs')
const b4a = require('b4a')
const FramedStream = require('framed-stream')
const goodbye = require('graceful-goodbye')
const { isBareKit, platform, arch } = require('which-runtime')
const PearPen = require('./index')

const argv = (index) => Bare.argv[index + (isBareKit ? 0 : 2)]
const config = {
  updates: argv(0) !== 'false',
  version: argv(1),
  upgrade: argv(2),
  name: argv(3) || 'Pear Pen',
  dir: argv(4) || require('bare-storage').persistent(),
  app: argv(5)
}
const pipe = new FramedStream(Bare.IPC)
const engine = new PearPen({ dir: path.join(config.dir, 'pear-pen') })
let pear = null
let updateStore = null
let manifestWrite = Promise.resolve()

function send(message) {
  pipe.write(b4a.from(JSON.stringify(message)))
}

function updateError(error) {
  send({
    type: 'update',
    status: 'error',
    error: error.message,
    message: error.message
  })
}

engine.on('state', (state) => send({ type: 'state', state }))
engine.on('warning', (message) => send({ type: 'warning', message }))

async function start() {
  await engine.ready()
  if (!config.updates || !/^pear:\/\/[a-z\d]{52}$/.test(config.upgrade || '')) {
    send({ type: 'update', status: 'disabled' })
    return
  }
  const PearRuntime = require('#runtime')
  updateStore = engine.store.namespace('updates')
  pear = new PearRuntime({ ...config, swarm: engine.swarm, store: updateStore })
  if (typeof pear._writeManifest === 'function') {
    const writeManifest = pear._writeManifest.bind(pear)
    pear._writeManifest = () => {
      manifestWrite = writeManifest()
      manifestWrite.catch(() => {})
      return manifestWrite
    }
  }
  pear.updater.on('error', updateError)
  pear.updater.on('update-scheduled', (delay) =>
    send({ type: 'update', status: 'scheduled', delay })
  )
  pear.updater.on('updating', () =>
    send({ type: 'update', status: 'downloading' })
  )
  pear.updater.on('updated', () => {
    updateReady()
      .then(() => send({ type: 'update', status: 'available' }))
      .catch(updateError)
  })
  pear.on('minver-required', ({ minver } = {}) =>
    send({ type: 'update', status: 'minver-required', minver })
  )
  engine.swarm.join(pear.updater.drive.core.discoveryKey, {
    client: true,
    server: false
  })
}

async function updateReady() {
  await manifestWrite
  if (!isBareKit) return
  const next = path.join(
    pear.updater.next,
    'by-arch',
    `${platform}-${arch}`,
    'app',
    pear.updater.name
  )
  if (
    !fs.existsSync(path.join(next, 'package.json')) ||
    !fs.existsSync(path.join(next, 'app.bundle'))
  )
    throw new Error(
      'The update is incomplete. Restart Pear Pen to download it again'
    )
  const manifest = JSON.parse(
    fs.readFileSync(path.join(next, 'package.json'), 'utf8')
  )
  if (manifest.version !== pear.updater.nextVersion)
    throw new Error('The update manifest does not match its bundle')
}

const started = start().catch((error) => {
  send({ type: 'error', error: { message: error.message, code: error.code } })
  throw error
})
started.catch(() => {})

pipe.on('data', async (buffer) => {
  let message
  try {
    message = JSON.parse(b4a.toString(buffer))
  } catch {
    return
  }
  if (message.type === 'update.apply') {
    try {
      await started
      if (!pear) throw new Error('Updates are unavailable for this build')
      await pear.ready()
      if (
        !pear.updater.updated ||
        pear.updater.applied ||
        !pear.updater.bundled
      )
        throw new Error('There is no update ready to apply')
      await updateReady()
      await pear.updater.applyUpdate()
      send({ type: 'update', status: 'applied' })
    } catch (error) {
      updateError(error)
    }
    return
  }
  if (typeof message.method !== 'string' || message.id === undefined) return
  try {
    await started
    const result = await engine.command(message.method, message.params || {})
    send({ type: 'response', id: message.id, result })
  } catch (error) {
    send({
      type: 'response',
      id: message.id,
      error: { message: error.message, code: error.code }
    })
  }
})

goodbye(async () => {
  await pear?.close()
  await updateStore?.close()
  await engine.close()
})
