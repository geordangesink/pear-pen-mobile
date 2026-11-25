const b4a = require('b4a')
const z32 = require('z32')
const protocol = require('./protocol')
const { cleanEncoded, parseSource, normalizeSource, requestHash } = protocol

function sourceLink(value, request, target) {
  const source = parseSource(value)
  if (source.key === target)
    throw new Error('The source drive cannot be the multisig drive')
  if (
    source.fork !== null &&
    (source.fork !== request.fork || source.length !== request.length)
  )
    throw new Error('Source version does not match the signing request')
  return normalizeSource(
    `pear://${request.fork}.${request.length}.${source.key}`
  )
}

module.exports = async function rebuildActivity(
  room,
  { parseRequest, verifyResponses, isCommitted }
) {
  const signers = room.manifest.signers.map((signer) =>
    z32.encode(signer.publicKey)
  )
  let clock = 0
  const events = room.events
    .filter((event) => protocol.verify(event, room.pen.multisigKey, signers))
    .sort(protocol.compare)
    .filter((event) => {
      if (event.data.clock > clock + 1) return false
      clock = Math.max(clock, event.data.clock)
      return true
    })
  const names = new Map()
  for (const { data } of events) {
    if (data.authorName === undefined) continue
    const name = data.authorName.trim()
    if (name) names.set(data.author, name)
    else names.delete(data.author)
  }
  const requests = new Map()
  const activity = []
  const byHash = new Map()
  for (const [index, event] of events.entries()) {
    if (event.data.type !== 'request') continue
    try {
      const request = cleanEncoded(event.data.request)
      const req = parseRequest(request)
      const srcKey = sourceLink(event.data.srcKey, req, room.pen.multisigKey)
      const hash = requestHash(request)
      const record = {
        id: event.id,
        index,
        hash,
        request,
        req,
        srcKey,
        creator: event.data.author,
        responses: new Map(),
        status: 'open'
      }
      requests.set(record.id, record)
      if (!byHash.has(hash)) byHash.set(hash, [])
      byHash.get(hash).push(record)
    } catch {}
  }
  const context = (data, index) => {
    let record = data.requestId ? requests.get(data.requestId) : null
    let request = data.request ? cleanEncoded(data.request) : record?.request
    if (!request && data.requestHash) {
      const records = byHash.get(data.requestHash) || []
      request = records[0]?.request
    }
    if (!request) throw new Error('Unknown signing request')
    const req = parseRequest(request)
    const hash = requestHash(request)
    if (data.requestHash && data.requestHash !== hash)
      throw new Error('Request hash does not match')
    if (record && record.hash !== hash)
      throw new Error('Request ID does not match')
    if (!data.requestId) {
      const records = byHash.get(hash) || []
      record =
        [...records].reverse().find((item) => item.index <= index) || records[0]
    }
    return { record, request, req, hash }
  }
  const actions = new Map()
  const contributions = new Map()
  for (const [index, event] of events.entries()) {
    const data = event.data
    if (data.type === 'request') continue
    try {
      const ctx = context(data, index)
      const entries = []
      if (data.type === 'response') {
        const signer = data.signer ?? data.author
        const response = (
          await verifyResponses(ctx.request, [data.response])
        ).get(signer)
        if (!response) continue
        entries.push([signer, response.response])
      } else {
        if (data.srcKey !== undefined)
          sourceLink(data.srcKey, ctx.req, room.pen.multisigKey)
        const responses = await verifyResponses(
          ctx.request,
          data.responses || []
        )
        for (const [publicKey, response] of responses)
          entries.push([publicKey, response.response])
      }
      actions.set(event.id, ctx)
      const verified = entries.map(([author, response]) => ({
        author,
        response,
        request: ctx.request,
        requestHash: ctx.hash,
        requestId: ctx.record?.id || data.requestId,
        ...((data.type !== 'response' || author !== data.author) && {
          sharedBy: data.author
        }),
        binding: ctx.record?.id || `orphan:${data.requestId || ctx.hash}`
      }))
      for (const item of verified)
        ctx.record?.responses.set(item.author, item.response)
      contributions.set(event.id, verified)
    } catch {}
  }
  const proofs = new Map()
  const destination = async (ctx) => {
    if (!proofs.has(ctx.hash)) {
      let stale = ctx.req.fork !== room.target.core.fork
      const covered = !stale && room.target.core.length >= ctx.req.length
      let metadata = false
      if (covered) {
        try {
          metadata = b4a.equals(
            await room.target.core.treeHash(ctx.req.length),
            ctx.req.treeHash
          )
          stale = !metadata
        } catch {}
      }
      proofs.set(ctx.hash, {
        stale,
        covered,
        metadata,
        committed: metadata && (await isCommitted(ctx.req))
      })
    }
    return proofs.get(ctx.hash)
  }
  const shown = new Set()
  const counts = new Map()
  let current = null
  for (const event of events) {
    const data = event.data
    const record = requests.get(event.id)
    if (data.type === 'request') {
      if (!record) continue
      const state = await destination(record)
      if (state.committed) record.status = 'committed'
      else if (state.stale) record.status = 'unanswered'
      if (
        record.status === 'open' &&
        (!state.covered || (state.metadata && !current))
      ) {
        if (
          current?.status === 'open' &&
          !(await destination(current)).metadata
        ) {
          current.status = 'unanswered'
          activity.push({
            id: `${event.id}-unanswered`,
            type: 'unanswered',
            text: 'The previous request closed unanswered',
            author: data.author,
            at: data.at,
            requestId: current.id
          })
        }
        current = record
      }
      activity.push({
        id: event.id,
        type: 'request',
        text: `Requested signing for ${record.srcKey}`,
        author: data.author,
        at: data.at,
        requestId: record.id,
        request: record.request,
        requestHash: record.hash
      })
      continue
    }
    const ctx = actions.get(event.id)
    if (!ctx) continue
    for (const item of contributions.get(event.id) || []) {
      const key = `${item.binding}:${item.author}`
      if (shown.has(key)) continue
      shown.add(key)
      const count = (counts.get(item.binding) || 0) + 1
      counts.set(item.binding, count)
      const { binding, ...payload } = item
      activity.push({
        id: data.type === 'response' ? event.id : `${event.id}:${item.author}`,
        type: 'response',
        text: `${item.sharedBy && item.sharedBy !== item.author ? 'Signature shared' : 'Signed'} · ${count}/${ctx.req.manifest.quorum}`,
        at: data.at,
        ...payload
      })
    }
    if (data.type === 'response') continue
    if (data.type === 'review') {
      if (
        !data.manual &&
        (!ctx.record || ctx.record.responses.size < ctx.req.manifest.quorum)
      )
        continue
    } else if (data.type === 'commit') {
      if (!data.manual && ctx.record?.creator !== data.author) continue
      const responses = ctx.record?.responses || new Map()
      for (const item of contributions.get(event.id) || [])
        responses.set(item.author, item.response)
      if (
        responses.size < ctx.req.manifest.quorum ||
        !(await destination(ctx)).committed
      )
        continue
      if (ctx.record) ctx.record.status = 'committed'
    }
    activity.push({
      id: event.id,
      type: data.type,
      text:
        data.type === 'commit'
          ? 'Committed the request'
          : 'Reviewed the request',
      author: data.author,
      at: data.at,
      requestId: ctx.record?.id || data.requestId,
      request: ctx.request,
      requestHash: ctx.hash
    })
  }
  if (current?.status === 'open' && (await destination(current)).committed)
    current.status = 'committed'
  for (const item of activity) {
    const authorName = names.get(item.author)
    const sharedByName = names.get(item.sharedBy)
    if (authorName) item.authorName = authorName
    if (sharedByName) item.sharedByName = sharedByName
  }
  return {
    clock,
    requests,
    activity,
    current:
      current?.status === 'open' && current.req.fork === room.target.core.fork
        ? current
        : null
  }
}
