const EventEmitter = require('events')
const fs = require('fs')
const path = require('path')
const b4a = require('b4a')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hypercore = require('hypercore')
const Hyperswarm = require('hyperswarm')
const Protomux = require('protomux')
const crypto = require('hypercore-crypto')
const id = require('hypercore-id-encoding')
const CoreSign = require('hypercore-sign-v4')
const SigningRequest = require('hypercore-signing-request')
const z32 = require('z32')
const commitDrive = require('./lib/commit')
const keys = require('./lib/keys')
const protocol = require('./lib/protocol')
const rebuildActivity = require('./lib/activity')
const download = require('./lib/download')
const {
  parseConfiguration,
  serializeManifest,
  emptyConfiguration,
  configurationMismatch
} = require('./lib/configuration')
const {
  MAX_MESSAGE,
  cleanEncoded,
  normalizeKey,
  parseSource,
  normalizeSource,
  requestHash
} = protocol

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
    this.suggestedName = null
    this.privateExports = new Set()
    this.rooms = new Map()
    this.drives = new Map()
    this.driveDiscoveries = new Map()
    this.driveReady = new Map()
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
    if (this.data.version === undefined) {
      for (const pen of this.data.pens) {
        if (pen.name === 'Untitled pen') pen.name = ''
      }
      this.data.version = 1
    }
    this.identity = readJSON(path.join(this.dir, 'identity.json'), null)
    if (this.identity) {
      const publicKey = keys.decode(this.identity.publicKey)
      if (publicKey.length !== 32)
        throw new Error(
          'The saved signing identity is invalid. Restore your identity backup before continuing'
        )
      const profile = {
        name: cleanName(this.data.profile?.name ?? this.identity.username),
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
    } else {
      this.suggestedName = suggestUsername()
    }
    if (!this.store)
      this.store = new Corestore(path.join(this.dir, 'corestore'))
    await this.store.ready()
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
        suggestedName: this.suggestedName,
        profile: this.data.profile && {
          ...this.data.profile,
          username: this.identity?.username || this.data.profile.publicKey,
          encrypted: !!this.identity?.encrypted
        },
        settings: this.data.settings,
        pens: this.data.pens.map((pen) => {
          const room = this.rooms.get(pen.id)
          return {
            id: pen.id,
            name: pen.name || `pear://${pen.multisigKey}`,
            multisigKey: pen.multisigKey,
            image: pen.image || null,
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
      const name = cleanName(params.name) || this.suggestedName
      const identity = keys.importIdentity(params)
      identity.username = name
      atomicJSON(path.join(this.dir, 'identity.json'), identity)
      this.identity = identity
      this.suggestedName = null
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
      const configuration =
        params.config === undefined ? null : parseConfiguration(params.config)
      const expectedKey =
        params.multisigKey === undefined
          ? null
          : normalizeKey(params.multisigKey)
      if (
        configuration &&
        expectedKey &&
        configuration.multisigKey !== expectedKey
      )
        throw configurationMismatch(expectedKey, configuration.multisigKey)
      const multisigKey = configuration?.multisigKey || expectedKey
      if (!multisigKey)
        throw new Error('Enter a multisig link or import a configuration')
      const configuredQuorum = configuration ? null : parseQuorum(params.quorum)
      if (this.data.pens.some((pen) => pen.multisigKey === multisigKey))
        throw new Error('This pen is already in your list')
      const pen = {
        id: multisigKey,
        multisigKey,
        name: cleanName(params.name),
        configuredQuorum,
        drafts: {}
      }
      const cached = this.drives.has(multisigKey)
      let room
      try {
        await this._openPen(pen, true)
        room = this.rooms.get(pen.id)
        if (configuration)
          await this._installManifest(
            room,
            configuration.manifest,
            configuration.config
          )
        this.data.pens.push(pen)
        try {
          this._save()
        } catch (error) {
          this.data.pens = this.data.pens.filter((item) => item !== pen)
          throw error
        }
      } catch (error) {
        if (room) {
          await this._closeRoom(room)
          this.rooms.delete(pen.id)
          if (!cached) {
            this.drives.delete(multisigKey)
            await this.driveDiscoveries.get(multisigKey)?.destroy()
            this.driveDiscoveries.delete(multisigKey)
            await room.target.close()
          }
        }
        throw error
      }
      return this.snapshot()
    }
    if (method === 'pen.preview') {
      const { config, multisigKey } = parseConfiguration(params.config)
      const room =
        params.penId === undefined ? null : this.rooms.get(params.penId)
      if (params.penId !== undefined && !room) throw new Error('Pen not found')
      const expectedKey =
        room?.pen.multisigKey ||
        (params.multisigKey === undefined
          ? null
          : normalizeKey(params.multisigKey))
      return {
        config,
        multisigKey,
        changed: !!expectedKey && multisigKey !== expectedKey
      }
    }
    const room = this.rooms.get(params.penId)
    if (!room) throw new Error('Pen not found')
    if (method === 'pen.configuration') {
      return {
        config:
          room.pen.config ||
          (room.manifest
            ? JSON.stringify(
                { manifest: serializeManifest(room.manifest) },
                null,
                2
              )
            : emptyConfiguration())
      }
    }
    if (method === 'pen.image') {
      this._requireIdentity()
      const image = params.image
      if (
        image !== null &&
        (typeof image !== 'string' ||
          b4a.byteLength(image) > 128 * 1024 ||
          !/^data:image\/(?:jpeg|png|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{4}|[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)$/.test(
            image
          ))
      )
        throw new Error(
          'Choose a JPEG, PNG or WebP image no larger than 128 KB'
        )
      room.pen.image = image
      this._save()
      return this.snapshot()
    }
    if (method === 'pen.configure') {
      this._requireIdentity()
      const { config, manifest, multisigKey } = parseConfiguration(
        params.config
      )
      const name =
        params.name === undefined ? room.pen.name : cleanName(params.name)
      if (multisigKey !== room.pen.multisigKey)
        throw configurationMismatch(room.pen.multisigKey, multisigKey)
      const previous = {
        name: room.pen.name,
        config: room.pen.config,
        configuredQuorum: room.pen.configuredQuorum
      }
      try {
        await this._installManifest(room, manifest, config)
        room.pen.name = name
        this._save()
      } catch (error) {
        Object.assign(room.pen, previous)
        throw error
      }
      return this.snapshot()
    }
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
    if (method === 'manual.verify') {
      const request = cleanEncoded(params.request)
      const response = cleanEncoded(params.response)
      const key =
        typeof params.publicKey === 'string' ? params.publicKey.trim() : ''
      if (key.includes('/') || !id.isValid(key))
        throw new Error(
          'Enter the expected signer’s public key in z-base-32 or hex'
        )
      const signer = id.normalize(key)
      const req = this._requestManifest(room, request)
      CoreSign.verify(
        z32.decode(response),
        z32.decode(request),
        id.decode(signer)
      )
      const details = requestDetails(req, 'hex')
      const output = [
        'Signature verified.',
        `Signer: ${signer}`,
        `Multisig key: ${details.key}`,
        `Fork: ${details.fork}`,
        `Metadata length: ${details.length}`,
        `Metadata tree hash: ${details.treeHash}`,
        `Content length: ${details.content.length}`,
        `Content tree hash: ${details.content.treeHash}`
      ].join('\n')
      return { verified: true, signer, details, output }
    }
    const creatingRequest =
      method === 'manual.request' || method === 'request.create'
    const manualRelease =
      method === 'manual.review' || method === 'manual.commit'
    const manualDestination =
      (method === 'manual.request' &&
        (params.multisigKey !== undefined || params.length !== undefined)) ||
      (manualRelease &&
        (params.multisigKey !== undefined || params.request === undefined))
    if (
      manualDestination &&
      normalizeKey(params.multisigKey) !== room.pen.multisigKey
    )
      throw new Error(
        'The destination multisig drive key does not match this pen'
      )
    if (method === 'manual.inspect') {
      this._requireIdentity()
      const request = cleanEncoded(params.request)
      const req = this._requestManifest(room, request)
      SigningRequest.signable(id.decode(this.identity.publicKey), req)
      return { ...requestDetails(req, 'hex'), signer: this.identity.publicKey }
    }
    if (method === 'manual.response') {
      const request = cleanEncoded(params.request)
      const req = this._requestManifest(room, request)
      this._requireSigner(req.manifest)
      if (room.target.core.manifest) await this._manifest(room, true)
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
      if (!room.manifest) await this._installManifest(room, req.manifest)
      await this._publish(room, {
        type: 'response',
        request,
        requestHash: requestHash(request),
        ...(record && { requestId: record.id }),
        response
      })
      return { output: response }
    }
    let srcKey = creatingRequest ? normalizeSource(params.srcKey) : null
    let length = null
    if (method === 'manual.request' && manualDestination) {
      length = manualLength(params.length)
      const pin = parseSource(srcKey)
      if (pin.length !== null && length !== pin.length)
        throw new Error('The length must match the versioned source link')
    }
    if (creatingRequest && parseSource(srcKey).key === room.pen.multisigKey)
      throw new Error('Choose a source drive different from the multisig drive')
    let source
    if (creatingRequest && !room.target.core.manifest) {
      source = await this._source(srcKey, length)
      srcKey = pinnedSource(srcKey, source, length)
      await this._bootstrapManifest(room, srcKey, source)
    }
    if (!room.target.core.manifest && manualRelease && params.request) {
      const req = this._requestManifest(room, cleanEncoded(params.request))
      await this._installManifest(room, req.manifest)
    }
    await this._manifest(room, true)
    this._requireSigner(room.manifest)
    if (creatingRequest) {
      source ||= await this._source(srcKey, length)
      srcKey = pinnedSource(srcKey, source, length)
      const request = await this._makeRequest(room, srcKey, source)
      room.pen.drafts[request] = srcKey
      this._save()
      if (
        method !== 'manual.request' ||
        room.current?.status !== 'open' ||
        room.current.request !== request ||
        room.current.srcKey !== srcKey
      )
        await this._publish(room, { type: 'request', srcKey, request })
      if (method === 'manual.request')
        return {
          output: request,
          details: requestDetails(this._parseRequest(room, request))
        }
      return this.snapshot()
    }
    if (method === 'manual.submitResponse') {
      const record = room.current
      if (!record || record.status !== 'open')
        throw new Error('There is no open request')
      const response = cleanEncoded(params.response)
      const verified = await this._responses(room, record.request, [response])
      const signer = verified.keys().next().value
      if (!record.responses.has(signer))
        await this._publish(room, {
          type: 'response',
          requestId: record.id,
          request: record.request,
          requestHash: record.hash,
          signer,
          response
        })
      const responses = room.requests.get(record.id).responses
      const result = {
        quorum: responses.size,
        required: record.req.manifest.quorum,
        signers: signerStatus(record.req, responses),
        request: requestDetails(record.req)
      }
      return { ...result, output: JSON.stringify(result, null, 2) }
    }
    if (manualRelease) {
      const stored =
        params.request === undefined
          ? this._currentRequest(room, params.requestId)
          : null
      const request = stored?.request || cleanEncoded(params.request)
      this._parseRequest(room, request)
      const record = stored || this._findRequest(room, request)
      const srcKey = params.srcKey
        ? normalizeSource(params.srcKey)
        : record?.srcKey || room.pen.drafts[request]
      if (!srcKey)
        throw new Error('Enter the source key for this signing request')
      const confirmation = manualDestination ? 'CONFIRM' : 'COMMIT'
      if (method === 'manual.commit' && params.confirmation !== confirmation)
        throw new Error(`Type ${confirmation} to confirm`)
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
        method === 'manual.commit',
        manualDestination
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
    const current = this._currentRequest(room, params.requestId)
    if (method === 'request.sign') {
      if (current.responses.has(this.identity.publicKey))
        throw new Error('You have already signed this request')
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

  _currentRequest(room, requestId) {
    const current = room.current
    if (!current || current.status !== 'open')
      throw new Error('There is no open request')
    if (requestId !== current.id)
      throw new Error('The request changed. Review the current request again')
    return current
  }

  _requireSigner(manifest) {
    this._requireIdentity()
    if (
      !manifest.signers.some(
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
      await drive.ready()
      const discovery = this.swarm?.join(drive.discoveryKey, {
        client: true,
        server: true
      })
      this.drives.set(key, drive)
      if (discovery) {
        this.driveDiscoveries.set(key, discovery)
        this._discover(key, drive, discovery)
      }
      return drive
    } catch (error) {
      if (drive) await drive.close()
      else await store.close()
      throw error
    }
  }

  _discover(key, drive, discovery, refresh = false) {
    if (this.driveReady.has(key)) return this.driveReady.get(key)
    const done = drive.core.findingPeers()
    let resolveDiscovery
    const ready = new Promise((resolve) => {
      resolveDiscovery = resolve
    })
    this.driveReady.set(key, ready)
    let finished = false
    let running = false
    let again = false
    const finish = (success = false) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      drive.off('close', finish)
      this.swarm.off('connection', retry)
      done()
      this.driveReady.delete(key)
      resolveDiscovery(success)
    }
    const timer = setTimeout(finish, this.timeout)
    timer.unref?.()
    drive.once('close', finish)
    const attempt = () => {
      if (finished) return
      if (running) {
        again = true
        return
      }
      running = true
      Promise.resolve()
        .then(async () => {
          if (refresh && (await discovery.refresh?.()) === false) return false
          if ((await discovery.flushed()) === false) return false
          if ((await this.swarm.flush?.()) === false) return false
          return true
        })
        .catch(() => false)
        .then((success) => {
          running = false
          if (finished) return
          if (success) return finish(true)
          if (again) {
            again = false
            attempt()
          }
        })
    }
    const retry = () => {
      refresh = true
      attempt()
    }
    this.swarm.on('connection', retry)
    attempt()
    return ready
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
            if (this.closed || this.rooms.get(pen.id) !== room) return
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
    room.closed = true
    if (room.refresh) {
      room.target.core.off('manifest', room.refresh)
      room.target.core.off('append', room.refresh)
      room.contentCore?.off('append', room.refresh)
    }
    for (const [key, channel] of this.channels) {
      if (!key.startsWith(`${room.pen.id}:`)) continue
      this.channels.delete(key)
      channel.close()
    }
    await room.discovery?.destroy()
    await room.contentCore?.close()
  }

  async _manifest(room, required = false) {
    if (!room.target.core.manifest && required)
      await this._update(room.target.core, 'manifest')
    const manifest = room.target.core.manifest
    if (!manifest) {
      if (required)
        throw new Error(
          'The multisig drive manifest is unavailable. Import its pear.json in Pen details, or keep a peer seeding the complete drive and try again'
        )
      return
    }
    this._validateManifest(room, manifest)
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

  _validateManifest(room, manifest) {
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
  }

  async _installManifest(room, manifest, config) {
    if (!b4a.equals(Hypercore.key(manifest), id.decode(room.pen.multisigKey)))
      throw configurationMismatch(
        room.pen.multisigKey,
        id.normalize(Hypercore.key(manifest))
      )
    const core = room.target.corestore.get({ key: room.target.key, manifest })
    try {
      await core.ready()
    } finally {
      await core.close()
    }
    await this._manifest(room, true)
    await this._rebuild(room)
    if (config !== undefined) {
      room.pen.config = config
      room.pen.configuredQuorum = null
    }
    this._emit()
  }

  async _bootstrapManifest(room, srcKey, source) {
    const pin = parseSource(srcKey)
    if (pin.key === room.pen.multisigKey)
      throw new Error('Choose a source drive different from the multisig drive')
    source ||= await this._source(srcKey)
    if (room.target.core.manifest) return source
    const view = source.checkout(pin.length ?? source.core.length)
    try {
      await view.ready()
      const entry = await view.entry('/pear.json', { timeout: this.timeout })
      if (room.target.core.manifest) return source
      const blob = entry?.value.blob
      if (!blob)
        throw new Error(
          'The source drive is missing /pear.json. Stage the public multisig configuration there, or import it in Pen details.'
        )
      if (!Number.isSafeInteger(blob.byteLength) || blob.byteLength > 64 * 1024)
        throw new Error('The source /pear.json must be no larger than 64 KB')
      await view.getBlobs()
      const length = await view.blobs.getByteLength(blob)
      if (!Number.isSafeInteger(length) || length < 1 || length > 64 * 1024)
        throw new Error('The source /pear.json must be no larger than 64 KB')
      const buffer = await view.get(entry, {
        timeout: this.timeout,
        length,
        prefetch: false
      })
      if (!buffer || buffer.length > 64 * 1024)
        throw new Error('The source /pear.json must be no larger than 64 KB')
      if (room.target.core.manifest) return source
      const { config, manifest } = parseConfiguration(b4a.toString(buffer))
      await this._installManifest(room, manifest, config)
      this._save()
      return source
    } finally {
      await view.close()
    }
  }

  async _source(value, length = null) {
    const pin = parseSource(value)
    pin.length ??= length
    const drive = await this._drive(pin.key)
    const available =
      pin.length !== null &&
      drive.core.length >= pin.length &&
      (pin.fork === null || drive.core.fork === pin.fork)
    if (!available) {
      const discovery = this.driveDiscoveries.get(pin.key)
      const discovered =
        !discovery || (await this._discover(pin.key, drive, discovery, true))
      if (!discovered && pin.length === null)
        throw new Error(
          'Could not discover the latest source version. Keep its peer online and try again, or use an exact versioned source link.'
        )
      const updated = await this._update(drive.core, 'length', {
        length: Math.max(1, pin.length ?? 1),
        fork: pin.fork,
        peers: pin.length === null && !!this.swarm
      })
      if (!updated && pin.length === null)
        throw new Error(
          'The source drive is offline. Keep its peer online and try again'
        )
    }
    if (pin.fork !== null && drive.core.fork !== pin.fork)
      throw new Error('The requested source fork is unavailable')
    if (pin.length !== null && drive.core.length < pin.length)
      throw new Error('The requested source version is unavailable')
    if (!drive.core.length)
      throw new Error('The source drive is empty or offline')
    await drive.core.get(0, { timeout: this.timeout })
    drive.core.timeout = this.timeout
    await drive.getBlobs()
    if (!drive.blobs) throw new Error('The source is not a Hyperdrive')
    drive.blobs.core.timeout = this.timeout
    this.swarm?.join(drive.blobs.core.discoveryKey, {
      client: true,
      server: true
    })
    return drive
  }

  async _update(
    core,
    property = 'length',
    { length = 1, fork = null, peers = false } = {}
  ) {
    const session = core.session()
    const event = property === 'manifest' ? 'manifest' : 'append'
    let timer
    let check
    let update
    let active = true
    let running = false
    let again = false
    try {
      return await new Promise((resolve, reject) => {
        check = () => {
          const available =
            property === 'manifest'
              ? !!core.manifest
              : core.length >= length && (fork === null || core.fork === fork)
          if (available && (!peers || core.writable || core.peers.length > 0))
            resolve(true)
        }
        update = () => {
          if (!active) return
          if (running) {
            again = true
            return
          }
          running = true
          session.update({ wait: true }).then(
            () => {
              running = false
              if (!active) return
              check()
              if (again) {
                again = false
                update()
              }
            },
            (error) => {
              running = false
              if (active) reject(error)
            }
          )
        }
        core.on(event, check)
        core.on('peer-add', update)
        timer = setTimeout(() => resolve(false), this.timeout)
        update()
      })
    } finally {
      active = false
      clearTimeout(timer)
      core.off(event, check)
      core.off('peer-add', update)
      await session.close()
    }
  }

  async _makeRequest(room, srcKey, source) {
    const pin = parseSource(srcKey)
    if (pin.key === room.pen.multisigKey)
      throw new Error('Choose a source drive different from the multisig drive')
    source ||= await this._source(srcKey)
    const length = pin.length ?? source.core.length
    const fork = pin.fork ?? source.core.fork
    if (source.core.length < length)
      throw new Error('The requested source version is unavailable')
    if (source.core.fork !== fork)
      throw new Error('The requested source fork is unavailable')
    if (length <= room.target.core.length)
      throw new Error('The source has no new changes to sign')
    if (fork !== room.target.core.fork)
      throw new Error('Source and multisig drive forks do not match')
    const request = await SigningRequest.generateDrive(source, {
      manifest: room.manifest,
      length,
      fork,
      // hypercore-sign v3 compatibility: emit the request format accepted by both signer versions.
      legacy: true
    })
    if (source.core.fork !== fork)
      throw new Error(
        'The source drive changed forks while creating the request'
      )
    return z32.encode(request)
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

  _requestManifest(room, request) {
    const req = this._parseRequest(room, request)
    this._validateManifest(room, req.manifest)
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
        b4a.equals(
          await Hypercore.treeHashFromStorage(room.target.core, req.length),
          req.treeHash
        ) &&
        b4a.equals(
          await Hypercore.treeHashFromStorage(
            room.contentCore,
            req.content.length
          ),
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
      const encoded = z32.decode(request)
      const response = SigningRequest.encodeResponse({
        version: req.version,
        requestHash: crypto.hash(encoded),
        publicKey,
        signatures
      })
      CoreSign.verify(response, encoded, publicKey)
      return z32.encode(response)
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
    const encodedRequest = z32.decode(request)
    const responses = new Map()
    for (const value of values) {
      const response = cleanEncoded(value)
      let encodedResponse
      let decoded
      try {
        encodedResponse = z32.decode(response)
        decoded = SigningRequest.decodeResponse(encodedResponse)
      } catch {
        throw new Error('Invalid signing response')
      }
      const publicKey = z32.encode(decoded.publicKey)
      CoreSign.verify(encodedResponse, encodedRequest, decoded.publicKey)
      responses.set(publicKey, { response, decoded })
    }
    return responses
  }

  async _treeHash(core, length) {
    try {
      return await Hypercore.treeHashFromStorage(core, length)
    } catch (error) {
      if (
        length < 1 ||
        error.code !== 'INVALID_OPERATION' ||
        !/Expected tree node \d+ from storage, got \(nil\)/.test(error.message)
      )
        throw error
      await core.get(length - 1, { timeout: this.timeout })
      return Hypercore.treeHashFromStorage(core, length)
    }
  }

  async _review(room, record, values, commit, includeBatch = false) {
    const req = this._decodeRequest(room, record.request)
    const responses = await this._responses(room, record.request, values)
    if (commit && responses.size < req.manifest.quorum)
      throw new Error(
        `Insufficient quorum: ${responses.size} / ${req.manifest.quorum}`
      )
    const pin = parseSource(record.srcKey)
    if (pin.key === room.pen.multisigKey)
      throw new Error('Choose a source drive different from the multisig drive')
    if (
      pin.fork !== null &&
      (pin.fork !== req.fork || pin.length !== req.length)
    )
      throw new Error('Source version does not match the signing request')
    const srcKey = normalizeSource(
      `pear://${req.fork}.${req.length}.${pin.key}`
    )
    const source = await this._source(srcKey)
    const content = room.contentCore
    if (content.length > req.content.length)
      throw new Error('The signing request is older than the committed content')
    if (
      source.blobs.core.length < req.content.length ||
      source.blobs.core.fork !== req.fork
    )
      await this._update(source.blobs.core, 'length', {
        length: req.content.length,
        fork: req.fork
      })
    if (source.blobs.core.length < req.content.length)
      throw new Error('The requested source content version is unavailable')
    if (source.blobs.core.fork !== req.fork)
      throw new Error('The source content changed forks after this request')
    const [metadataHash, contentHash] = await Promise.all([
      this._treeHash(source.core, req.length),
      this._treeHash(source.blobs.core, req.content.length)
    ])
    if (
      !b4a.equals(metadataHash, req.treeHash) ||
      !b4a.equals(contentHash, req.content.treeHash)
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
      srcKey,
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
    if (includeBatch) {
      const [db, blobs] = await Promise.all([
        this._batchInfo(room.target.core, source.core, req),
        this._batchInfo(content, source.blobs.core, req.content)
      ])
      Object.assign(result, {
        db,
        blobs,
        signers: signerStatus(req, responses)
      })
    }
    if (source.core.fork !== req.fork || source.blobs.core.fork !== req.fork)
      throw new Error('The source drive changed forks after this request')
    if (!commit) return result
    await Promise.all([
      this._download(source.core, room.target.core.length, req.length),
      this._download(source.blobs.core, content.length, req.content.length)
    ])
    if (source.core.fork !== req.fork || source.blobs.core.fork !== req.fork)
      throw new Error('The source drive changed forks after this request')
    const signatures = req.manifest.signers.map(
      (signer) =>
        responses.get(z32.encode(signer.publicKey))?.decoded.signatures
    )
    await commitDrive(room, source, req, signatures)
    this.swarm?.join(content.discoveryKey, { client: true, server: true })
    result.committed = true
    if (includeBatch) {
      result.db.destCore = result.db.batch
      result.blobs.destCore = result.blobs.batch
    }
    return result
  }

  async _batchInfo(destination, source, signed) {
    const describe = async (core) => {
      const length = core.length
      const hash = await this._treeHash(core, length)
      return { key: id.normalize(core.key), length, treeHash: z32.encode(hash) }
    }
    const [destCore, srcCore] = await Promise.all([
      describe(destination),
      describe(source)
    ])
    if (
      destCore.length &&
      destCore.treeHash !==
        z32.encode(await this._treeHash(source, destCore.length))
    )
      throw new Error('The source history does not match the multisig drive')
    return {
      destCore,
      srcCore,
      batch: {
        key: destCore.key,
        length: signed.length,
        treeHash: z32.encode(signed.treeHash)
      }
    }
  }

  _download(core, start, end) {
    return download(core, start, end, {
      timeout: this.timeout,
      onprogress: () => this.emit('progress')
    })
  }

  async _publish(room, payload) {
    payload = { ...payload, authorName: cleanName(this.data.profile?.name) }
    if (payload.srcKey !== undefined)
      payload.srcKey = parseSource(payload.srcKey).key
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
      if (event?.data?.type !== 'request') {
        this._buffer(room, event)
        return
      }
      if (JSON.stringify(event).length > MAX_MESSAGE)
        throw new Error('Activity is too large')
      const req = this._requestManifest(room, cleanEncoded(event.data.request))
      const signers = req.manifest.signers.map((signer) =>
        z32.encode(signer.publicKey)
      )
      if (!protocol.verify(event, room.pen.multisigKey, signers))
        throw new Error('Invalid activity signature')
      await this._installManifest(room, req.manifest)
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
    if (this.closed || room.closed) return
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
        if (room.closed) return channel.close()
        room.channels.add(channel)
        sendHistory()
        this._emit()
      },
      onclose: () => {
        room.channels.delete(channel)
        if (this.channels.get(key) === channel) this.channels.delete(key)
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
                if (this.closed || this.rooms.get(room.pen.id) !== room) return
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

function manualLength(value) {
  const length =
    typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number(value)
      : value
  if (!Number.isSafeInteger(length) || length < 1)
    throw new Error('Enter a positive whole number for the source drive length')
  return length
}

function requestDetails(req, encoding) {
  const encode =
    encoding === 'hex' ? (hash) => hash.toString('hex') : z32.encode
  return {
    key: req.id,
    fork: req.fork,
    length: req.length,
    treeHash: encode(req.treeHash),
    content: {
      length: req.content.length,
      treeHash: encode(req.content.treeHash)
    }
  }
}

function signerStatus(req, responses) {
  return req.manifest.signers.map((signer) => {
    const publicKey = z32.encode(signer.publicKey)
    return { publicKey, signed: responses.has(publicKey) }
  })
}

function pinnedSource(value, source, length = null) {
  const pin = parseSource(value)
  return normalizeSource(
    `pear://${pin.fork ?? source.core.fork}.${pin.length ?? length ?? source.core.length}.${pin.key}`
  )
}

function cleanName(value) {
  if (value === undefined || value === null) return ''
  if (typeof value !== 'string' || value.length > 120)
    throw new Error('Names must be 120 characters or fewer')
  return value.trim()
}

function suggestUsername() {
  const adjectives = [
    'amber',
    'blue',
    'calm',
    'clear',
    'gentle',
    'green',
    'quiet',
    'silver'
  ]
  const nouns = [
    'birch',
    'cedar',
    'fern',
    'finch',
    'heron',
    'lark',
    'otter',
    'willow'
  ]
  const [a, b, first, second] = crypto.randomBytes(4)
  return `${adjectives[a % adjectives.length]}-${nouns[b % nouns.length]}-${first}-${second}`
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
