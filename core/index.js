const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const c = require('compact-encoding')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hypercore = require('hypercore')
const Hyperswarm = require('hyperswarm')
const Protomux = require('protomux')
const crypto = require('hypercore-crypto')
const id = require('hypercore-id-encoding')
const CoreSign = require('hypercore-sign')
const SigningRequest = require('hypercore-signing-request')
const { MultisigTools } = require('@holepunchto/multisig-tools')
const z32 = require('z32')
const keys = require('./lib/keys')
const protocol = require('./lib/protocol')
const rebuildActivity = require('./lib/activity')
const { MAX_MESSAGE, cleanEncoded, normalizeKey, requestHash } = protocol

class PearPen extends EventEmitter {
  constructor(options = {}) {
    super()
    this.dir = options.dir
    if (!this.dir) throw new Error('A storage directory is required')
    this.timeout = options.timeout || 15000
    this.network = options.network !== false
    this.store = options.store || null
    this.swarm = options.swarm || null
    this.ownsStore = !options.store
    this.ownsSwarm = !options.swarm
    this.data = {
      profile: null,
      settings: { theme: 'system', mode: 'automatic' },
      pens: [],
      dialog: null
    }
    this.identity = null
    this.privateExports = new Set()
    this.rooms = new Map()
    this.drives = new Map()
    this.driveDiscoveries = new Map()
    this.channels = new Map()
    this.queue = Promise.resolve()
    this.closed = false
    this.opening = null
  }

  ready() {
    if (!this.opening) this.opening = this._open()
    return this.opening
  }

  async _open() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.data = readJSON(path.join(this.dir, 'state.json'), this.data)
    this.identity = readJSON(path.join(this.dir, 'identity.json'), null)
    if (this.identity) {
      const publicKey = keys.decode(this.identity.publicKey)
      if (publicKey.length !== 32)
        throw new Error(
          'The saved signing identity is invalid. Restore your identity backup before continuing'
        )
      const profile = {
        name: cleanName(this.data.profile?.name),
        publicKey: z32.encode(publicKey)
      }
      this.identity.publicKey = profile.publicKey
      this.privateExports.add(this.identity.secretKey)
      if (
        this.data.profile?.publicKey !== profile.publicKey ||
        this.data.profile?.name !== profile.name
      ) {
        this.data.profile = profile
        atomicJSON(path.join(this.dir, 'state.json'), this.data)
      }
    } else if (this.data.profile) {
      throw new Error(
        'Your signing identity is missing. Restore your identity backup before continuing'
      )
    }
    if (!this.store)
      this.store = new Corestore(path.join(this.dir, 'corestore'))
    await this.store.ready()
    this.tools = new MultisigTools(this.store)
    if (this.network && !this.swarm) this.swarm = new Hyperswarm()
    this.onConnection = (peer) => this._connection(peer)
    this.swarm?.on('connection', this.onConnection)
    for (const pen of this.data.pens) await this._openPen(pen)
    this._emit()
    return this
  }

  snapshot() {
    return JSON.parse(
      JSON.stringify({
        profile: this.data.profile && {
          ...this.data.profile,
          encrypted: !!this.identity?.encrypted
        },
        settings: this.data.settings,
        pens: this.data.pens.map((pen) => {
          const room = this.rooms.get(pen.id)
          return {
            id: pen.id,
            name: pen.name,
            multisigKey: pen.multisigKey,
            quorum: room?.manifest?.quorum || pen.configuredQuorum || 0,
            configuredQuorum: pen.configuredQuorum ?? null,
            quorumMismatch: !!(
              room?.manifest &&
              pen.configuredQuorum &&
              room.manifest.quorum !== pen.configuredQuorum
            ),
            signers:
              room?.manifest?.signers.map((signer) =>
                z32.encode(signer.publicKey)
              ) || [],
            peers: room?.channels.size || 0,
            request: room?.current
              ? {
                  id: room.current.id,
                  request: room.current.request,
                  requestHash: room.current.hash,
                  srcKey: room.current.srcKey,
                  creator: room.current.creator,
                  signatures: [...room.current.responses.keys()],
                  quorum: room.current.req.manifest.quorum,
                  status: room.current.status,
                  length: room.current.req.length,
                  contentLength: room.current.req.content.length
                }
              : null,
            activity: room?.activity || []
          }
        }),
        dialog: this.data.dialog
      })
    )
  }

  command(method, params = {}) {
    const next = this.queue.then(async () => {
      await this.ready()
      if (this.closed) throw new Error('Pear Pen is closed')
      return this._command(method, params)
    })
    this.queue = next.catch(() => {})
    return next
  }

  async _command(method, params) {
    if (method === 'state.get') return this.snapshot()
    if (method === 'profile.import') {
      if (this.identity)
        throw new Error('A signing identity has already been imported')
      const name = cleanName(params.name)
      const identity = keys.importIdentity(params)
      atomicJSON(path.join(this.dir, 'identity.json'), identity)
      this.identity = identity
      this.privateExports.add(identity.secretKey)
      this.data.profile = { name, publicKey: identity.publicKey }
      this._save()
      return this.snapshot()
    }
    if (method === 'profile.export') {
      this._requireIdentity()
      const result = keys.exportIdentity(this.identity, params)
      if (params.kind === 'private') this.privateExports.add(result.key)
      return result
    }
    if (method === 'settings.update') {
      if (params.theme !== undefined) {
        if (!['system', 'light', 'dark'].includes(params.theme))
          throw new Error('Invalid theme')
        this.data.settings.theme = params.theme
      }
      if (params.mode !== undefined) {
        if (!['automatic', 'manual'].includes(params.mode))
          throw new Error('Invalid signing mode')
        this.data.settings.mode = params.mode
      }
      if (params.name !== undefined && this.data.profile)
        this.data.profile.name = cleanName(params.name)
      this._save()
      return this.snapshot()
    }
    if (method === 'dialog.save') {
      const encoded = JSON.stringify(params.dialog ?? null)
      if (encoded.length > MAX_MESSAGE) throw new Error('Dialog is too large')
      if ([...this.privateExports].some((key) => encoded.includes(key)))
        throw new Error('Private keys cannot be saved in dialogs')
      this.data.dialog = JSON.parse(encoded)
      this._save()
      return { ok: true }
    }
    if (method === 'pen.add') {
      this._requireIdentity()
      const multisigKey = normalizeKey(params.multisigKey)
      const configuredQuorum = parseQuorum(params.quorum)
      if (this.data.pens.some((pen) => pen.multisigKey === multisigKey))
        throw new Error('This pen is already in your list')
      const pen = {
        id: multisigKey,
        multisigKey,
        name: cleanName(params.name) || 'Untitled pen',
        configuredQuorum,
        drafts: {}
      }
      await this._openPen(pen, true)
      this.data.pens.push(pen)
      this._save()
      return this.snapshot()
    }
    const room = this.rooms.get(params.penId)
    if (!room) throw new Error('Pen not found')
    if (method === 'pen.remove') {
      await this._closeRoom(room)
      this.rooms.delete(params.penId)
      this.data.pens = this.data.pens.filter((pen) => pen.id !== params.penId)
      this._save()
      return this.snapshot()
    }
    if (method === 'request.response') {
      this._requireIdentity()
      const response = room.requests
        .get(params.requestId)
        ?.responses.get(this.identity.publicKey)
      if (!response) throw new Error('You have not signed this request')
      return { output: response }
    }
    await this._manifest(room, true)
    this._requireSigner(room)
    if (method === 'manual.request' || method === 'request.create') {
      const srcKey = normalizeKey(params.srcKey)
      const request = await this._makeRequest(room, srcKey)
      room.pen.drafts[request] = srcKey
      this._save()
      if (
        method !== 'manual.request' ||
        room.current?.status !== 'open' ||
        room.current.request !== request ||
        room.current.srcKey !== srcKey
      )
        await this._publish(room, { type: 'request', srcKey, request })
      if (method === 'manual.request') return { output: request }
      return this.snapshot()
    }
    if (method === 'manual.response') {
      const request = cleanEncoded(params.request)
      this._parseRequest(room, request)
      const record = this._findRequest(room, request)
      const existing =
        record?.responses.get(this.identity.publicKey) ||
        (!record &&
          room.activity.find(
            (item) =>
              item.response &&
              item.author === this.identity.publicKey &&
              item.requestHash === requestHash(request) &&
              !item.requestId
          )?.response)
      if (existing) return { output: existing }
      const response = await this._sign(room, request, params.password)
      await this._publish(room, {
        type: 'response',
        request,
        requestHash: requestHash(request),
        ...(record && { requestId: record.id }),
        response
      })
      return { output: response }
    }
    if (method === 'manual.review' || method === 'manual.commit') {
      const request = cleanEncoded(params.request)
      this._parseRequest(room, request)
      const record = this._findRequest(room, request)
      const srcKey = params.srcKey
        ? normalizeKey(params.srcKey)
        : record?.srcKey || room.pen.drafts[request]
      if (!srcKey)
        throw new Error('Enter the source key for this signing request')
      if (method === 'manual.commit' && params.confirmation !== 'COMMIT')
        throw new Error('Type COMMIT to confirm')
      const pasted = await this._responses(
        room,
        request,
        params.responses || []
      )
      const responses = new Map(record?.responses || [])
      for (const [publicKey, response] of pasted)
        responses.set(publicKey, response.response)
      const result = await this._review(
        room,
        { request, srcKey },
        [...responses.values()],
        method === 'manual.commit'
      )
      const payload = {
        request,
        requestHash: requestHash(request),
        srcKey,
        ...(record && { requestId: record.id })
      }
      const own = responses.get(this.identity.publicKey)
      if (own && !record?.responses.has(this.identity.publicKey))
        await this._publish(room, {
          type: 'response',
          ...payload,
          response: own
        })
      await this._publish(room, {
        type: method === 'manual.commit' ? 'commit' : 'review',
        ...payload,
        manual: true,
        responses: [...responses.values()]
      })
      return { ...result, output: JSON.stringify(result, null, 2) }
    }
    const current = room.current
    if (!current || current.status !== 'open')
      throw new Error('There is no open request')
    if (params.requestId !== current.id)
      throw new Error('The request changed. Review the current request again')
    if (method === 'request.sign') {
      if (current.responses.has(this.identity.publicKey))
        throw new Error('You have already signed this request')
      await this._review(room, current, [], false)
      const response = await this._sign(room, current.request, params.password)
      await this._publish(room, {
        type: 'response',
        requestId: current.id,
        request: current.request,
        requestHash: current.hash,
        response
      })
      return { ...this.snapshot(), output: response }
    }
    if (method === 'request.review' || method === 'request.commit') {
      if (current.responses.size < current.req.manifest.quorum)
        throw new Error('The request has not reached quorum')
      if (method === 'request.commit') {
        if (current.creator !== this.identity.publicKey)
          throw new Error('Only the request creator can commit')
        if (params.confirmation !== 'COMMIT')
          throw new Error('Type COMMIT to confirm')
      }
      const result = await this._review(
        room,
        current,
        [...current.responses.values()],
        method === 'request.commit'
      )
      await this._publish(room, {
        type: method === 'request.commit' ? 'commit' : 'review',
        requestId: current.id,
        request: current.request,
        requestHash: current.hash,
        srcKey: current.srcKey,
        responses: [...current.responses.values()]
      })
      return { ...result, output: JSON.stringify(result, null, 2) }
    }
    throw new Error('Unknown command')
  }

  _requireIdentity() {
    if (!this.identity) throw new Error('Import your signing keys first')
  }

  _requireSigner(room) {
    this._requireIdentity()
    if (
      !room.manifest.signers.some(
        (signer) => z32.encode(signer.publicKey) === this.identity.publicKey
      )
    )
      throw new Error('Your public key is not a signer for this pen')
  }

  async _drive(key) {
    if (this.drives.has(key)) return this.drives.get(key)
    const store = this.store.session()
    let drive
    try {
      drive = new Hyperdrive(store, id.decode(key))
      drive.core.timeout = this.timeout
      await drive.ready()
      const discovery = this.swarm?.join(drive.discoveryKey, {
        client: true,
        server: true
      })
      this.drives.set(key, drive)
      if (discovery) this.driveDiscoveries.set(key, discovery)
      return drive
    } catch (error) {
      if (drive) await drive.close()
      else await store.close()
      throw error
    }
  }

  async _openPen(pen, validateQuorum = false) {
    pen.drafts ||= {}
    const existingDrive = this.drives.has(pen.multisigKey)
    let target
    let room
    try {
      target = await this._drive(pen.multisigKey)
      room = {
        pen,
        target,
        manifest: null,
        events: readJSON(path.join(this.dir, `events-${pen.id}.json`), []),
        current: null,
        activity: [],
        channels: new Set(),
        clock: 0,
        topic: crypto.hash([
          b4a.from('pear-pen/room/v1'),
          id.decode(pen.multisigKey)
        ]),
        requests: new Map(),
        pending: []
      }
      await this._manifest(room)
      if (
        validateQuorum &&
        room.manifest &&
        pen.configuredQuorum &&
        room.manifest.quorum !== pen.configuredQuorum
      ) {
        const actual = room.manifest.quorum
        throw new Error(
          `This drive requires ${actual} signature${actual === 1 ? '' : 's'}; you entered ${pen.configuredQuorum}. Enter ${actual} or leave quorum blank.`
        )
      }
      this.rooms.set(pen.id, room)
      room.discovery = this.swarm?.join(room.topic, {
        client: true,
        server: true
      })
      room.discovery?.flushed().catch(() => {})
      const refresh = () => {
        this.queue = this.queue
          .then(async () => {
            if (this.closed || !this.rooms.has(pen.id)) return
            await this._manifest(room)
            await this._rebuild(room)
            this._emit()
          })
          .catch((error) => this.emit('warning', error.message))
      }
      target.core.on('manifest', refresh)
      target.core.on('append', refresh)
      room.refresh = refresh
      room.contentCore?.on('append', refresh)
      for (const peer of this.swarm?.connections || [])
        this._channel(peer, room)
      await this._rebuild(room)
    } catch (error) {
      if (room) {
        await this._closeRoom(room)
        if (this.rooms.get(pen.id) === room) this.rooms.delete(pen.id)
      }
      if (!existingDrive && target) {
        this.drives.delete(pen.multisigKey)
        await this.driveDiscoveries.get(pen.multisigKey)?.destroy()
        this.driveDiscoveries.delete(pen.multisigKey)
        await target.close()
      }
      throw error
    }
  }

  async _closeRoom(room) {
    if (room.refresh) {
      room.target.core.off('manifest', room.refresh)
      room.target.core.off('append', room.refresh)
      room.contentCore?.off('append', room.refresh)
    }
    for (const channel of room.channels) channel.close()
    await room.discovery?.destroy()
    await room.contentCore?.close()
  }

  async _manifest(room, required = false) {
    if (!room.target.core.manifest && required)
      await room.target.core.update({ wait: true, timeout: this.timeout })
    const manifest = room.target.core.manifest
    if (!manifest) {
      if (required)
        throw new Error(
          'The multisig drive is offline. Keep a peer seeding it and try again'
        )
      return
    }
    if (
      manifest.version !== 1 ||
      !b4a.equals(Hypercore.key(manifest), id.decode(room.pen.multisigKey)) ||
      manifest.quorum < 1 ||
      manifest.quorum > manifest.signers.length ||
      new Set(
        manifest.signers.map((signer) => signer.publicKey.toString('hex'))
      ).size !== manifest.signers.length
    )
      throw new Error(
        'This key does not have a supported multisig drive manifest'
      )
    const firstManifest = !room.manifest
    room.manifest = manifest
    if (!room.contentCore) {
      room.contentCore = this.store.get({
        manifest: Hyperdrive.getContentManifest(manifest, room.target.key)
      })
      await room.contentCore.ready()
      if (room.refresh) room.contentCore.on('append', room.refresh)
    }
    const pending = room.pending.splice(0)
    for (const event of pending) {
      try {
        await this._receive(room, event)
      } catch {}
    }
    if (firstManifest) {
      for (const channel of room.channels)
        channel.messages[0].send(b4a.from(JSON.stringify({ type: 'sync' })))
    }
  }

  async _source(key) {
    const drive = await this._drive(key)
    if (!drive.core.length)
      await drive.core.update({ wait: true, timeout: this.timeout })
    if (!drive.core.length)
      throw new Error('The source drive is empty or offline')
    await drive.core.get(0, { timeout: this.timeout })
    await drive.getBlobs()
    if (!drive.blobs) throw new Error('The source is not a Hyperdrive')
    drive.blobs.core.timeout = this.timeout
    this.swarm?.join(drive.blobs.core.discoveryKey, {
      client: true,
      server: true
    })
    return drive
  }

  async _makeRequest(room, srcKey) {
    if (srcKey === room.pen.multisigKey)
      throw new Error('Choose a source drive different from the multisig drive')
    const source = await this._source(srcKey)
    if (source.core.length <= room.target.core.length)
      throw new Error('The source has no new changes to sign')
    if (source.core.fork !== room.target.core.fork)
      throw new Error('Source and multisig drive forks do not match')
    return z32.encode(
      await SigningRequest.generateDrive(source, { manifest: room.manifest })
    )
  }

  _parseRequest(room, request) {
    let req
    try {
      req = SigningRequest.decode(z32.decode(request))
    } catch {
      throw new Error('Invalid signing request')
    }
    if (!req.isHyperdrive || !req.content)
      throw new Error('This pen requires a Hyperdrive signing request')
    if (req.id !== room.pen.multisigKey)
      throw new Error(
        'This signing request belongs to a different multisig drive'
      )
    return req
  }

  _decodeRequest(room, request) {
    const req = this._parseRequest(room, request)
    if (req.fork !== room.target.core.fork)
      throw new Error('The signing request has an incompatible fork')
    if (req.length <= room.target.core.length)
      throw new Error(
        'This signing request is already committed or out of date'
      )
    return req
  }

  _findRequest(room, request) {
    const hash = requestHash(request)
    if (room.current?.status === 'open' && room.current.hash === hash)
      return room.current
    return [...room.requests.values()]
      .reverse()
      .find((record) => record.hash === hash)
  }

  async _isCommitted(room, req) {
    try {
      if (
        room.target.core.fork !== req.fork ||
        room.target.core.length < req.length ||
        !room.contentCore ||
        room.contentCore.fork !== req.fork ||
        room.contentCore.length < req.content.length
      )
        return false
      return (
        b4a.equals(await room.target.core.treeHash(req.length), req.treeHash) &&
        b4a.equals(
          await room.contentCore.treeHash(req.content.length),
          req.content.treeHash
        )
      )
    } catch {
      return false
    }
  }

  async _sign(room, request, password) {
    const req = this._decodeRequest(room, request)
    const secret = keys.unlock(this.identity.secretKey, password)
    try {
      const publicKey = z32.decode(this.identity.publicKey)
      const signatures = SigningRequest.signable(publicKey, req).map((item) =>
        crypto.sign(item.signable, secret)
      )
      const response = z32.encode(
        c.encode(CoreSign.messages.Response, {
          version: req.version,
          requestHash: crypto.hash(z32.decode(request)),
          publicKey,
          signatures
        })
      )
      await CoreSign.verify(response, request, this.identity.publicKey)
      return response
    } finally {
      secret.fill(0)
    }
  }

  async _responses(room, request, values) {
    if (
      !Array.isArray(values) ||
      values.length > room.manifest.signers.length * 2
    )
      throw new Error('Invalid signing responses')
    const responses = new Map()
    for (const value of values) {
      const response = cleanEncoded(value)
      let decoded
      try {
        decoded = c.decode(CoreSign.messages.Response, z32.decode(response))
      } catch {
        throw new Error('Invalid signing response')
      }
      const publicKey = z32.encode(decoded.publicKey)
      await CoreSign.verify(response, request, publicKey)
      responses.set(publicKey, { response, decoded })
    }
    return responses
  }

  async _review(room, record, values, commit) {
    const req = this._decodeRequest(room, record.request)
    const responses = await this._responses(room, record.request, values)
    if (commit && responses.size < req.manifest.quorum)
      throw new Error(
        `Insufficient quorum: ${responses.size} / ${req.manifest.quorum}`
      )
    const source = await this._source(record.srcKey)
    if (source.core.fork !== req.fork)
      throw new Error('The source drive changed forks after this request')
    if (source.core.length < req.length)
      throw new Error('The source is shorter than the signed request')
    const contentManifest = Hyperdrive.getContentManifest(
      req.manifest,
      room.target.key
    )
    const content = this.store.get({ manifest: contentManifest })
    await content.ready()
    let metadataBatch
    let contentBatch
    try {
      if (content.length > req.content.length)
        throw new Error(
          'The signing request is older than the committed content'
        )
      await Promise.all([
        this._download(source.core, room.target.core.length, req.length),
        this._download(source.blobs.core, content.length, req.content.length)
      ])
      metadataBatch = await this.tools.createUpdateBatch(
        room.target.core,
        source.core,
        { end: req.length }
      )
      contentBatch = await this.tools.createUpdateBatch(
        content,
        source.blobs.core,
        { end: req.content.length }
      )
      if (
        !b4a.equals(await metadataBatch.treeHash(), req.treeHash) ||
        !b4a.equals(await contentBatch.treeHash(), req.content.treeHash)
      )
        throw new Error('The source data does not match the signed request')
      const files = []
      const checkout = source.checkout(req.length)
      try {
        for await (const diff of checkout.diff(room.target.core.length)) {
          const entry = diff.left || diff.right
          files.push({
            path: entry.key,
            action: diff.left ? 'put' : 'delete',
            size: diff.left?.value?.blob?.byteLength || 0
          })
        }
      } finally {
        await checkout.close()
      }
      const result = {
        multisigKey: room.pen.multisigKey,
        srcKey: record.srcKey,
        quorum: responses.size,
        required: req.manifest.quorum,
        length: req.length,
        treeHash: z32.encode(req.treeHash),
        content: {
          length: req.content.length,
          treeHash: z32.encode(req.content.treeHash)
        },
        files,
        committed: false
      }
      if (commit) {
        const signatures = req.manifest.signers.map(
          (signer) =>
            responses.get(z32.encode(signer.publicKey))?.decoded.signatures
        )
        if (content.length < req.content.length)
          await this.tools.commitUpdateBatch(
            content,
            contentBatch,
            signatures.map((signature) => signature?.[1]),
            { length: req.content.length }
          )
        await this.tools.commitUpdateBatch(
          room.target.core,
          metadataBatch,
          signatures.map((signature) => signature?.[0]),
          { length: req.length }
        )
        this.swarm?.join(content.discoveryKey, { client: true, server: true })
        result.committed = true
      }
      return result
    } finally {
      await metadataBatch?.close()
      await contentBatch?.close()
      await content.close()
    }
  }

  async _download(core, start, end) {
    if (start >= end) return
    const download = core.download({ start, end })
    let timer
    try {
      await Promise.race([
        download.done(),
        new Promise((resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  'The source data is unavailable. Keep its peer online and try again'
                )
              ),
            this.timeout
          )
        })
      ])
    } finally {
      clearTimeout(timer)
      download.destroy()
    }
  }

  async _publish(room, payload) {
    const event = protocol.create(
      this.identity,
      room.pen.multisigKey,
      payload,
      room.clock + 1
    )
    await this._receive(room, event)
    return event
  }

  async _receive(room, event) {
    if (!room.manifest) {
      this._buffer(room, event)
      return
    }
    if (room.events.some((item) => item.id === event?.id)) return
    const signers = room.manifest.signers.map((signer) =>
      z32.encode(signer.publicKey)
    )
    if (!protocol.verify(event, room.pen.multisigKey, signers))
      throw new Error('Invalid activity signature')
    if (JSON.stringify(event).length > MAX_MESSAGE)
      throw new Error('Activity is too large')
    if (event.data.clock > room.clock + 1) {
      this._buffer(room, event)
      return
    }
    room.events.push(event)
    room.clock = Math.max(room.clock, event.data.clock)
    atomicJSON(path.join(this.dir, `events-${room.pen.id}.json`), room.events)
    await this._rebuild(room)
    for (const channel of room.channels)
      channel.messages[0].send(b4a.from(JSON.stringify(event)))
    this._emit()
    const next = room.pending
      .sort(protocol.compare)
      .findIndex((item) => item.data.clock <= room.clock + 1)
    if (next !== -1) await this._receive(room, room.pending.splice(next, 1)[0])
  }

  _buffer(room, event) {
    if (
      room.pending.length >= 256 ||
      room.pending.some((item) => item.id === event?.id)
    )
      return
    const bytes = room.pending.reduce(
      (total, item) => total + b4a.byteLength(JSON.stringify(item)),
      0
    )
    if (bytes + b4a.byteLength(JSON.stringify(event)) <= MAX_MESSAGE)
      room.pending.push(event)
  }

  async _rebuild(room) {
    if (!room.manifest) return
    const state = await rebuildActivity(room, {
      parseRequest: (request) => this._parseRequest(room, request),
      verifyResponses: (request, values) =>
        this._responses(room, request, values),
      isCommitted: (request) => this._isCommitted(room, request)
    })
    Object.assign(room, state)
  }

  _connection(peer) {
    this.store.replicate(peer)
    const mux = Protomux.from(peer)
    mux.pair({ protocol: 'pear-pen/activity/v1' }, (topic) => {
      for (const room of this.rooms.values())
        if (topic && b4a.equals(topic, room.topic)) this._channel(peer, room)
    })
    for (const room of this.rooms.values()) this._channel(peer, room)
  }

  _channel(peer, room) {
    const key = `${room.pen.id}:${peer.remotePublicKey.toString('hex')}`
    if (this.channels.has(key)) return
    let channel
    let lastSync = 0
    const sendHistory = () => {
      for (const event of [...room.events].sort(protocol.compare))
        channel.messages[0].send(b4a.from(JSON.stringify(event)))
    }
    channel = Protomux.from(peer).createChannel({
      protocol: 'pear-pen/activity/v1',
      id: room.topic,
      onopen: () => {
        room.channels.add(channel)
        sendHistory()
        this._emit()
      },
      onclose: () => {
        room.channels.delete(channel)
        this.channels.delete(key)
        this._emit()
      },
      messages: [
        {
          onmessage: (buffer) => {
            if (buffer.length > MAX_MESSAGE) return channel.close()
            let event
            try {
              event = JSON.parse(b4a.toString(buffer))
            } catch {
              return
            }
            if (event?.type === 'sync') {
              if (Date.now() - lastSync >= 1000) {
                lastSync = Date.now()
                sendHistory()
              }
              return
            }
            this.queue = this.queue
              .then(async () => {
                if (this.closed || !this.rooms.has(room.pen.id)) return
                await this._manifest(room)
                await this._receive(room, event)
              })
              .catch(() => {})
          }
        }
      ]
    })
    if (!channel) return
    this.channels.set(key, channel)
    channel.open()
  }

  _save() {
    atomicJSON(path.join(this.dir, 'state.json'), this.data)
    this._emit()
  }

  _emit() {
    this.emit('state', this.snapshot())
  }

  async close() {
    this.closed = true
    await this.queue
    this.swarm?.off('connection', this.onConnection)
    for (const room of this.rooms.values()) await this._closeRoom(room)
    for (const discovery of this.driveDiscoveries.values())
      await discovery.destroy()
    this.driveDiscoveries.clear()
    if (this.swarm && this.ownsSwarm) await this.swarm.destroy()
    for (const drive of this.drives.values()) await drive.close()
    if (this.ownsStore) await this.store?.close()
    this.identity = null
    this.privateExports.clear()
  }
}

function cleanName(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > 120)
    throw new Error('Names must be 120 characters or fewer')
  return value.trim()
}

function parseQuorum(value) {
  if (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && !value.trim())
  )
    return null
  if (!Number.isSafeInteger(value) || value < 1)
    throw new Error('Quorum must be a positive whole number')
  return value
}

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new Error(
      'Local data could not be read. Restore your data backup before continuing'
    )
  }
}

function atomicJSON(file, value) {
  const temporary = `${file}.tmp`
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 })
  fs.renameSync(temporary, file)
}

module.exports = PearPen
