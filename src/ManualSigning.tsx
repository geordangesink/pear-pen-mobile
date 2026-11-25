import { useEffect, useRef, useState } from 'react'
import { Keyboard, Pressable, Text } from 'react-native'
import {
  call,
  errorMessage,
  verifySignature,
  type ManualRelease,
  type OutputOptions,
  type Pen,
  type State
} from './client'
import { Action, Field, KeyCredentials, type Palette } from './ui'
import { styles } from './styles'

export type ManualAction = 'request' | 'sign' | 'response' | 'verify' | 'review' | 'commit'

type RequestDetails = {
  key: string
  fork: number
  length: number
  treeHash: string
  content: { length: number; treeHash: string }
}

function describeRequest(details: RequestDetails) {
  return [
    `Multisig key: ${details.key}`,
    `Fork: ${details.fork}`,
    `Metadata length: ${details.length}`,
    `Metadata tree hash: ${details.treeHash}`,
    `Content length: ${details.content.length}`,
    `Content tree hash: ${details.content.treeHash}`
  ].join('\n')
}

export default function ManualSigning({
  method,
  pen,
  profile,
  requestId,
  manualCommit,
  colors,
  busy,
  setBusy,
  onBack,
  onOutput
}: {
  method: ManualAction
  pen: Pen
  profile: NonNullable<State['profile']>
  requestId?: string
  manualCommit?: ManualRelease
  colors: Palette
  busy: boolean
  setBusy: (busy: boolean) => void
  onBack: () => void
  onOutput: (value: unknown, title: string, options?: OutputOptions) => Promise<void>
}) {
  const [step, setStep] = useState(0)
  const [destination, setDestination] = useState(`pear://${pen.multisigKey}`)
  const [source, setSource] = useState('')
  const [length, setLength] = useState('')
  const [request, setRequest] = useState(method === 'sign' ? pen.request?.request || '' : '')
  const [responses, setResponses] = useState('')
  const [publicKey, setPublicKey] = useState('')
  const [pasted, setPasted] = useState(false)
  const [details, setDetails] = useState<(RequestDetails & { signer: string }) | null>(null)
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')
  const submitting = useRef(false)
  const mounted = useRef(false)
  const release = method === 'review' || method === 'commit'
  const current = requestId && pen.request?.id === requestId ? pen.request : null
  const enteringDestination = !manualCommit && step === 0 && (release || method === 'request')
  const enteringPasted = release && pasted && step === 1
  const confirmingCommit = method === 'commit' && (!!manualCommit || step === (pasted ? 2 : 1))

  function move(next: number) {
    setError('')
    setPassword('')
    setConfirmation('')
    setStep(next)
  }

  const field = { colors, editable: !busy, autoComplete: 'off' as const }
  const encodedField = { ...field, mono: true, multiline: true }
  const reading = [styles.reviewKey, { color: colors.ink, backgroundColor: colors.soft }]
  const note = [styles.settingsHint, { color: colors.muted }]
  let input
  let label = 'Continue'
  let disabled = false
  let run: () => Promise<void> | void = () => move(step + 1)

  if (enteringDestination) {
    input = (
      <>
        <Field
          {...encodedField}
          label='DESTINATION MULTISIG KEY'
          value={destination}
          onChange={setDestination}
        />
        {release && (
          <>
            <Text selectable style={note}>
              {pasted
                ? 'Use the original request, source key and any collected responses.'
                : current?.srcKey ||
                  (requestId
                    ? 'The current request changed. Reopen this action to use it.'
                    : 'There is no open request.')}
            </Text>
            <Pressable
              accessibilityRole='button'
              disabled={busy}
              onPress={() => {
                setError('')
                setPasted(!pasted)
              }}
              style={styles.helpLink}
            >
              <Text style={[styles.small, { color: colors.success }]}>
                {pasted ? 'Use current request' : 'Use pasted request'}
              </Text>
            </Pressable>
          </>
        )}
      </>
    )
    disabled = !destination.trim() || (release && !pasted && !current)
  } else if (method === 'request' && step === 1) {
    input = (
      <Field
        {...encodedField}
        label='SOURCE DRIVE KEY'
        placeholder='Source key or pear:// link'
        value={source}
        onChange={(value) => {
          setSource(value)
          setLength(value.trim().match(/^pear:\/\/\d+\.(\d+)\./)?.[1] || '')
        }}
      />
    )
    disabled = !source.trim()
  } else if (method === 'request') {
    input = (
      <Field
        {...field}
        label='SOURCE DRIVE LENGTH'
        placeholder='Number of metadata blocks to sign'
        numeric
        value={length}
        onChange={setLength}
      />
    )
    disabled = !/^\d+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) < 1
    label = 'Create request'
    run = async () => {
      const result = await call('manual.request', {
        penId: pen.id,
        multisigKey: destination.trim(),
        srcKey: source.trim(),
        length: Number(length)
      })
      await onOutput(result.output, 'Signing request', { details: describeRequest(result.details) })
    }
  } else if (method === 'response' || (method === 'verify' && step === 0)) {
    input = (
      <Field
        {...encodedField}
        label='SIGNED RESPONSE'
        placeholder='Paste the response from a signer'
        value={responses}
        onChange={setResponses}
      />
    )
    disabled = !responses.trim()
    if (method === 'response') {
      label = 'Submit response'
      run = async () => {
        const result = await call('manual.submitResponse', {
          penId: pen.id,
          requestId,
          response: responses.trim()
        })
        await onOutput(result, 'Response submitted')
      }
    }
  } else if (method === 'verify' && step === 1) {
    input = (
      <Field
        {...encodedField}
        label='SIGNING REQUEST'
        placeholder='Paste the original signing request'
        value={request}
        onChange={setRequest}
      />
    )
    disabled = !request.trim()
  } else if (method === 'verify') {
    input = (
      <Field
        {...encodedField}
        label='EXPECTED SIGNER PUBLIC KEY'
        placeholder='Paste the expected signer’s public key'
        value={publicKey}
        onChange={setPublicKey}
      />
    )
    disabled = !publicKey.trim()
    label = 'Verify signature'
    run = async () => {
      const output = await verifySignature(pen.id, {
        response: responses.trim(),
        request: request.trim(),
        publicKey: publicKey.trim()
      })
      if (mounted.current) await onOutput(output, 'Signature verified')
    }
  } else if (method === 'sign') {
    if (step === 0) {
      input = (
        <Field
          {...encodedField}
          label='SIGNING REQUEST'
          value={request}
          onChange={setRequest}
          placeholder='Paste the encoded request'
        />
      )
      disabled = !request.trim()
      label = 'Inspect request'
      run = async () => {
        setDetails(await call('manual.inspect', { penId: pen.id, request: request.trim() }))
        move(1)
      }
    } else if (step === 1 && details) {
      input = (
        <Text selectable style={reading}>
          {describeRequest(details)}
        </Text>
      )
      label = 'Confirm request'
    } else if (step === 2 && details) {
      input = (
        <>
          <Text style={note}>Sign with this public key?</Text>
          <Text selectable style={reading}>
            {details.signer}
          </Text>
        </>
      )
      label = profile.encrypted ? 'Confirm signing key' : 'Confirm key and sign'
    } else {
      input = (
        <KeyCredentials
          username={profile.username || profile.name || profile.publicKey}
          password={password}
          onChange={setPassword}
          colors={colors}
          busy={busy}
        />
      )
      label = 'Sign request'
      disabled = !password
    }
    if (step === 3 || (step === 2 && !profile.encrypted)) {
      run = async () => {
        const result = await call('manual.response', {
          penId: pen.id,
          request: request.trim(),
          password
        })
        setPassword('')
        await onOutput(result, 'Signature response')
      }
    }
  } else if (enteringPasted) {
    input = (
      <>
        <Field
          {...encodedField}
          label='SOURCE DRIVE KEY'
          value={source}
          onChange={setSource}
          placeholder='Source key or pear:// link'
        />
        <Field
          {...encodedField}
          label='SIGNING REQUEST'
          value={request}
          onChange={setRequest}
          placeholder='Paste the original request'
        />
        <Field
          {...encodedField}
          label='ADDITIONAL RESPONSES · OPTIONAL'
          value={responses}
          onChange={setResponses}
          placeholder='One encoded response per line'
        />
      </>
    )
    disabled = !source.trim() || !request.trim()
  } else if (confirmingCommit) {
    input = (
      <>
        <Text style={note}>This publishes the signed changes to the multisig drive.</Text>
        <Text selectable style={reading}>
          {manualCommit?.srcKey ||
            (pasted ? source : current?.srcKey) ||
            'The current request changed. Reopen Review to use it.'}
        </Text>
        <Field
          {...field}
          label='TYPE COMMIT TO PUBLISH'
          value={confirmation}
          onChange={setConfirmation}
          placeholder='COMMIT'
        />
      </>
    )
    disabled = confirmation !== 'COMMIT' || (!manualCommit?.request && !pasted && !current)
  }

  if ((method === 'review' && (!pasted || enteringPasted)) || confirmingCommit) {
    label = method === 'review' ? 'Review changes' : 'Commit changes'
    run = async () => {
      const params = manualCommit ?? {
        penId: pen.id,
        multisigKey: destination.trim(),
        ...(pasted
          ? {
              request: request.trim(),
              srcKey: source.trim(),
              responses: responses
                .trim()
                .split(/[\s,]+/)
                .filter(Boolean)
            }
          : { requestId })
      }
      const result = await call(`manual.${method}`, {
        ...params,
        ...(confirmingCommit && { confirmation })
      })
      if (method === 'review') await onOutput(result, 'Review', { manualCommit: params })
      else await onOutput(result, 'Commit complete')
    }
  }

  async function advance() {
    if (disabled || busy || submitting.current) return
    submitting.current = true
    Keyboard.dismiss()
    setError('')
    setBusy(true)
    try {
      await run()
    } catch (problem) {
      if (mounted.current) setError(errorMessage(problem))
    } finally {
      submitting.current = false
      if (mounted.current) setBusy(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  return (
    <>
      {input}
      {busy && method === 'request' && step === 2 && (
        <Text accessibilityLiveRegion='polite' style={note}>
          Connecting and loading source…
        </Text>
      )}
      {!!error && (
        <Text accessibilityLiveRegion='polite' style={[styles.error, { color: colors.danger }]}>
          {error}
        </Text>
      )}
      <Action
        title={label}
        colors={colors}
        busy={busy}
        disabled={disabled}
        onPress={() => void advance()}
      />
      <Action
        title='Back'
        colors={colors}
        disabled={busy}
        secondary
        onPress={() => (step === 0 ? onBack() : move(step - 1))}
      />
    </>
  )
}
