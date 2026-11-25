import PearPenCore from 'pear-pen-core'
import b4a from 'b4a'
import bundle from './worker.bundle.js'
import { version, upgrade, productName } from '../package.json'

export type Activity = {
  localOnly?: boolean
  id: string
  type: string
  text: string
  author: string
  authorName?: string
  at: number
  packageVersion?: string
  request?: string
  response?: string
  sharedBy?: string
  sharedByName?: string
}
export type SignatureVerification = { response: string; request: string; publicKey: string }
export type SigningRequest = {
  id: string
  srcKey: string
  packageVersion?: string
  request?: string
  creator: string
  signatures: string[]
  quorum: number
  status: string
}
export type Pen = {
  privateRoom: boolean
  id: string
  name: string
  customName: string
  image?: string | null
  multisigKey: string
  quorum: number
  configuredQuorum: number | null
  quorumMismatch: boolean
  signers: string[]
  peers: number
  request: SigningRequest | null
  activity: Activity[]
}

export function knownQuorum(pen: Pen) {
  if (!pen.signers.length) return 0
  return pen.request?.quorum || pen.quorum
}

export type ManualRelease = {
  penId: string
  multisigKey: string
  requestId?: string
  request?: string
  srcKey?: string
  responses?: string[]
}
export type OutputOptions = { details?: string; manualCommit?: ManualRelease }
export type SavedDialog = OutputOptions & {
  kind: 'output'
  title: string
  text: string
}
export type State = {
  profile: null | { name: string; publicKey: string; encrypted: boolean }
  suggestedName: string | null
  settings: { theme: 'system' | 'light' | 'dark'; mode: 'automatic' | 'manual' }
  pens: Pen[]
  dialog: SavedDialog | null
}
export type Update = { status: string; message?: string }
const listeners = new Set<() => void>()
const pending = new Map<
  number,
  {
    resolve: (value: any) => void
    reject: (error: unknown) => void
    timer: ReturnType<typeof setTimeout>
    refresh: () => void
  }
>()
let serial = 0
let pipe: PearPenCore | null = null
let state: State | null = null
let update: Update = { status: '' }
let failure = ''
let warning = ''

function notify() {
  for (const listener of listeners) listener()
}

function takeRequest(id: number) {
  const request = pending.get(id)
  if (request) {
    clearTimeout(request.timer)
    pending.delete(id)
  }
  return request
}

function start() {
  if (pipe) return
  pipe = new PearPenCore({ bundle, updates: !__DEV__, version, upgrade, name: productName })
  pipe.on('data', (bytes) => {
    try {
      const message = JSON.parse(b4a.toString(bytes))
      if (message.type === 'progress') {
        for (const request of pending.values()) request.refresh()
        return
      }
      if (message.type === 'state') {
        state = message.state
        failure = ''
        notify()
      } else if (message.type === 'update') {
        update = { ...message, message: message.message || message.error }
        notify()
      } else if (message.id !== undefined) {
        const request = takeRequest(message.id)
        if (!request) return
        if (message.error) {
          request.reject(
            Object.assign(new Error(message.error.message || message.error), {
              code: message.error.code
            })
          )
        } else request.resolve(message.result)
      } else if (message.type === 'warning') {
        warning = message.message || 'A peer connection needs attention.'
        notify()
      } else if (message.type === 'error') {
        failure =
          message.message || message.error?.message || 'The signing service could not start.'
        notify()
      }
    } catch {
      failure = 'The signing service sent an unreadable message.'
      notify()
    }
  })
  const disconnected = (error: Error) => {
    for (const id of pending.keys()) takeRequest(id)?.reject(error)
    failure = error.message
    notify()
  }
  pipe.on('error', disconnected)
  pipe.on('close', () => disconnected(new Error('The signing service has stopped.')))
  call('state.get')
    .then((result) => {
      if (result?.settings) {
        state = result
        notify()
      }
    })
    .catch((error: Error) => {
      failure = error.message
      notify()
    })
}

export function call(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!pipe) return reject(new Error('The signing service is starting.'))
    const id = ++serial
    const expire = () => {
      let message = 'The signing service took too long to respond. Try again.'
      if (method === 'pen.create') {
        message = 'Room creation timed out. Check your pen list before trying again.'
      } else if (method === 'pen.join') {
        void call('pen.cancelJoin').catch(() => {})
        message = 'Joining timed out. Keep both devices online with Pear Pen open and try again.'
      }
      takeRequest(id)?.reject(new Error(message))
    }
    const request = {
      resolve,
      reject,
      timer: setTimeout(expire, 120000),
      refresh: () => {
        if (method !== 'request.commit' && method !== 'manual.commit') return
        clearTimeout(request.timer)
        request.timer = setTimeout(expire, 120000)
      }
    }
    pending.set(id, request)
    try {
      pipe.write(JSON.stringify({ id, method, params }))
    } catch (error) {
      takeRequest(id)?.reject(error)
    } finally {
      params = {}
    }
  })
}

export async function verifySignature(
  penId: string,
  signature: SignatureVerification
): Promise<string> {
  const result = await call('manual.verify', { penId, ...signature })
  if (result?.verified !== true || typeof result.output !== 'string')
    throw new Error('The signature could not be verified.')
  return result.output
}

export const client = {
  start,
  read: () => ({ state, update, failure, warning }),
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  },
  applyUpdate() {
    pipe?.write(JSON.stringify({ type: 'update.apply' }))
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
