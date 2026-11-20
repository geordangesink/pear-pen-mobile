import { useEffect, useState } from 'react'
import {
  Image,
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { call, errorMessage, type SavedDialog, type State } from './client'
import KeyExport from './KeyExport'
import { Action, Field, Icon, Segments, type Palette } from './ui'
import { styles } from './styles'
import { version } from '../package.json'

export type Dialog = {
  kind:
    | 'add'
    | 'settings'
    | 'actions'
    | 'request'
    | 'response'
    | 'review'
    | 'commit'
    | 'unlock'
    | 'output'
  title?: string
  text?: string
  penId?: string
  automatic?: boolean
  autoSubmit?: boolean
  requestId?: string
  srcKey?: string
}

const help = 'https://docs.pears.com/pear/how-to/operate-an-app/multisig/set-up-multisig/'

const submitTitles: Partial<Record<Dialog['kind'], string>> = {
  add: 'Add pen',
  request: 'Create request',
  response: 'Sign request',
  unlock: 'Sign request',
  review: 'Review changes',
  commit: 'Commit changes'
}

export async function saveOutput(value: unknown, title: string): Promise<SavedDialog> {
  let text: string
  if (typeof value === 'string') text = value
  else if (
    value &&
    typeof value === 'object' &&
    'output' in value &&
    typeof value.output === 'string'
  )
    text = value.output
  else text = JSON.stringify(value, null, 2) ?? ''
  const dialog: SavedDialog = { kind: 'output', title, text }
  await call('dialog.save', { dialog })
  return dialog
}

export default function DialogView({
  dialog,
  state,
  colors,
  onClose,
  onDialog,
  onToast
}: {
  dialog: Dialog
  state: State
  colors: Palette
  onClose: () => void
  onDialog: (dialog: Dialog) => void
  onToast: (text: string) => void
}) {
  const pen = state.pens.find((item) => item.id === dialog.penId)
  const manualReview = !dialog.automatic && ['review', 'commit'].includes(dialog.kind)
  const manualRequest = !dialog.automatic && ['response', 'review', 'commit'].includes(dialog.kind)
  const [name, setName] = useState(dialog.kind === 'settings' ? state.profile!.name : '')
  const [editing, setEditing] = useState(false)
  const [exportKind, setExportKind] = useState<'public' | 'private' | null>(null)
  const [key, setKey] = useState(manualReview ? pen?.request?.srcKey || '' : '')
  const [request, setRequest] = useState(manualRequest ? pen?.request?.request || '' : '')
  const [responses, setResponses] = useState('')
  const [quorum, setQuorum] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const kind = dialog.kind
  const needsKey = kind === 'add' || kind === 'request' || manualReview
  const submitDisabled =
    (needsKey && !key.trim()) ||
    (manualRequest && !request.trim()) ||
    (kind === 'commit' && confirmation !== 'COMMIT')
  const submitTitle = submitTitles[kind]
  const title =
    (exportKind ? `Export ${exportKind} key` : '') ||
    dialog.title ||
    {
      add: 'Add a pen',
      settings: 'Settings',
      actions: pen?.name || 'Signing actions',
      request: 'New request',
      response: 'Sign request',
      review: 'Review request',
      commit: 'Commit release',
      unlock: 'Sign request',
      output: 'Output'
    }[kind]

  async function output(result: unknown, title: string) {
    onDialog(await saveOutput(result, title))
  }
  async function submit() {
    setBusy(true)
    setError('')
    try {
      if (kind === 'add') {
        const enteredQuorum = quorum.trim()
        const requiredSignatures = Number(enteredQuorum)
        if (
          enteredQuorum &&
          (!/^\d+$/.test(enteredQuorum) ||
            !Number.isSafeInteger(requiredSignatures) ||
            requiredSignatures < 1)
        ) {
          throw new Error('Enter a positive whole number, or leave quorum blank for Automatic.')
        }
        await call('pen.add', {
          name: name.trim(),
          multisigKey: key.trim(),
          ...(enteredQuorum && { quorum: requiredSignatures })
        })
        onClose()
      } else if (kind === 'settings') {
        await call('settings.update', { name: name.trim() })
        setEditing(false)
        onToast('Name saved')
      } else if (kind === 'unlock') {
        await call('request.sign', { penId: pen!.id, password, requestId: dialog.requestId })
        setPassword('')
        onClose()
        onToast('Signature sent')
      } else if (kind === 'request') {
        const result = await call(dialog.automatic ? 'request.create' : 'manual.request', {
          penId: pen!.id,
          srcKey: key.trim()
        })
        if (dialog.automatic) {
          onClose()
          onToast('Request shared')
        } else await output(result, 'Signing request')
      } else if (kind === 'response') {
        const result = await call('manual.response', {
          penId: pen!.id,
          request: request.trim(),
          password
        })
        setPassword('')
        await output(result, 'Signature response')
      } else if (kind === 'review' || kind === 'commit') {
        const params = dialog.automatic
          ? { penId: pen!.id, confirmation, requestId: dialog.requestId }
          : {
              penId: pen!.id,
              request: request.trim(),
              responses: responses
                .trim()
                .split(/[\s,]+/)
                .filter(Boolean),
              srcKey: key.trim(),
              confirmation
            }
        const result = await call(`${dialog.automatic ? 'request' : 'manual'}.${kind}`, params)
        if (kind === 'review' || !dialog.automatic)
          await output(result, kind === 'review' ? 'Review' : 'Commit complete')
        else {
          onClose()
          onToast('Request committed')
        }
      }
    } catch (problem) {
      setError(errorMessage(problem))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    if (kind === 'unlock' && dialog.autoSubmit) void submit()
  }, [])

  async function setting(change: Record<string, string>) {
    try {
      await call('settings.update', change)
    } catch (problem) {
      setError(errorMessage(problem))
    }
  }

  function closeSheet() {
    if (busy) return
    if (exportKind) setExportKind(null)
    else onClose()
  }

  return (
    <Modal
      visible
      transparent
      animationType='slide'
      onRequestClose={kind === 'output' ? () => {} : closeSheet}
      statusBarTranslucent
    >
      <KeyboardAvoidingView
        style={[styles.modalOverlay, { backgroundColor: colors.overlay }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={[styles.sheet, { backgroundColor: colors.card }]}>
          <View style={[styles.sheetHandle, { backgroundColor: colors.line }]} />
          <View style={styles.sheetHeader}>
            <Text style={[styles.sheetTitle, { color: colors.ink }]}>{title}</Text>
            <Pressable
              accessibilityLabel='Close dialog'
              disabled={busy}
              onPress={closeSheet}
              style={[styles.closeButton, { backgroundColor: colors.soft }]}
            >
              <Icon name='close' color={colors.muted} size={20} />
            </Pressable>
          </View>
          <ScrollView
            keyboardShouldPersistTaps='handled'
            contentContainerStyle={styles.sheetContent}
          >
            {kind === 'add' && (
              <>
                <Text style={[styles.body, { color: colors.muted }]}>
                  Add an existing multisig drive.
                </Text>
                <Field
                  label='PEN NAME · OPTIONAL'
                  value={name}
                  onChange={setName}
                  placeholder='e.g. Our next release'
                  colors={colors}
                />
                <Field
                  label='MULTISIG DRIVE KEY'
                  value={key}
                  onChange={setKey}
                  placeholder='Paste a multisig key or pear:// link'
                  colors={colors}
                  mono
                  multiline
                />
                <Pressable onPress={() => void Linking.openURL(help)} style={styles.helpLink}>
                  <Icon name='help-circle-outline' color={colors.success} size={17} />
                  <Text style={[styles.small, { color: colors.success }]}>
                    Where do I find this key? ↗
                  </Text>
                </Pressable>
                <Field
                  label='Quorum'
                  value={quorum}
                  onChange={setQuorum}
                  placeholder='Automatic'
                  colors={colors}
                  numeric
                />
                <Text style={[styles.small, { color: colors.muted, marginTop: 7 }]}>
                  Required signatures. Verified from the drive.
                </Text>
              </>
            )}
            {kind === 'settings' && !exportKind && (
              <>
                <Text style={[styles.sectionLabel, { color: colors.muted }]}>YOUR NAME</Text>
                {editing ? (
                  <View>
                    <Field
                      label=''
                      value={name}
                      onChange={setName}
                      placeholder='Your name'
                      colors={colors}
                    />
                    <Action
                      title='Save name'
                      colors={colors}
                      busy={busy}
                      onPress={() => void submit()}
                      secondary
                    />
                  </View>
                ) : (
                  <Pressable
                    accessibilityLabel='Edit your name'
                    onPress={() => setEditing(true)}
                    style={[styles.nameRow, { borderBottomColor: colors.line }]}
                  >
                    <Text style={[styles.settingsName, { color: colors.ink }]}>
                      {state.profile?.name || 'Add your name'}
                    </Text>
                    <Icon name='pencil-outline' color={colors.muted} size={19} />
                  </Pressable>
                )}
                <Text style={[styles.sectionLabel, { color: colors.muted }]}>APPEARANCE</Text>
                <Segments
                  items={['system', 'light', 'dark']}
                  value={state.settings.theme}
                  onChange={(theme) => void setting({ theme })}
                  colors={colors}
                />
                <Text style={[styles.sectionLabel, { color: colors.muted }]}>SIGNING MODE</Text>
                <Segments
                  items={['automatic', 'manual']}
                  value={state.settings.mode}
                  onChange={(mode) => void setting({ mode })}
                  colors={colors}
                />
                <Text style={[styles.settingsHint, { color: colors.muted }]}>
                  {state.settings.mode === 'automatic'
                    ? 'Requests and signatures sync with connected peers, including manual signers.'
                    : 'Exchange requests and responses yourself. Your signing activity still syncs with connected peers.'}
                </Text>
                <Text style={[styles.sectionLabel, { color: colors.muted }]}>KEYS</Text>
                {(['public', 'private'] as const).map((kind) => (
                  <Pressable
                    key={kind}
                    accessibilityRole='button'
                    onPress={() => {
                      setError('')
                      setExportKind(kind)
                    }}
                    style={[styles.manualAction, { borderBottomColor: colors.line }]}
                  >
                    <Icon
                      name={kind === 'public' ? 'arrow-up-circle-outline' : 'key-outline'}
                      color={colors.success}
                    />
                    <Text style={[styles.manualText, { color: colors.ink }]}>
                      Export {kind} key
                    </Text>
                    <Icon name='chevron-forward' color={colors.muted} size={17} />
                  </Pressable>
                ))}
                <View style={[styles.row, { justifyContent: 'center', gap: 24, marginTop: 20 }]}>
                  {[
                    ['Privacy policy', 'https://realpainpoints.com/pear-pen/privacy'],
                    ['Support', 'https://realpainpoints.com/pear-pen']
                  ].map(([label, url]) => (
                    <Pressable
                      key={url}
                      accessibilityRole='link'
                      hitSlop={10}
                      onPress={() =>
                        void Linking.openURL(url).catch((problem) => onToast(errorMessage(problem)))
                      }
                    >
                      <Text style={[styles.small, { color: colors.success }]}>{label} ↗</Text>
                    </Pressable>
                  ))}
                </View>
                <View style={styles.settingsVersion}>
                  <Image source={require('../assets/icon.png')} style={styles.versionIcon} />
                  <Text style={[styles.small, { color: colors.muted }]}>Pear Pen · {version}</Text>
                </View>
              </>
            )}
            {exportKind && (
              <KeyExport key={exportKind} kind={exportKind} colors={colors} onToast={onToast} />
            )}
            {kind === 'actions' && (
              <>
                <Text style={[styles.body, styles.actionsIntro, { color: colors.muted }]}>
                  Choose an action.
                </Text>
                {(['request', 'response', 'review', 'commit'] as const).map((action) => (
                  <Pressable
                    key={action}
                    accessibilityRole='button'
                    onPress={() => onDialog({ kind: action, penId: pen!.id })}
                    style={[styles.manualAction, { borderBottomColor: colors.line }]}
                  >
                    <Icon
                      name={
                        action === 'request'
                          ? 'add-circle-outline'
                          : action === 'response'
                            ? 'pencil-outline'
                            : action === 'review'
                              ? 'reader-outline'
                              : 'checkmark-done-outline'
                      }
                      color={colors.success}
                    />
                    <Text style={[styles.manualText, { color: colors.ink }]}>
                      {action[0].toUpperCase() + action.slice(1)}
                    </Text>
                    <Icon name='chevron-forward' color={colors.muted} size={17} />
                  </Pressable>
                ))}
                <View style={styles.cancelGap}>
                  <Action title='Cancel' onPress={onClose} colors={colors} secondary />
                </View>
              </>
            )}
            {kind === 'request' && (
              <>
                <Text style={[styles.body, { color: colors.muted }]}>
                  {dialog.automatic && pen?.request
                    ? 'Opening a new request closes the current one as unanswered.'
                    : 'Enter the source drive key.'}
                </Text>
                <Field
                  label='SOURCE KEY'
                  value={key}
                  onChange={setKey}
                  placeholder='Paste the full source key'
                  colors={colors}
                  mono
                  multiline
                />
              </>
            )}
            {kind === 'response' && (
              <>
                <Field
                  label='SIGNING REQUEST'
                  value={request}
                  onChange={setRequest}
                  placeholder='Paste the request from the requester'
                  colors={colors}
                  mono
                  multiline
                />
                {state.profile?.encrypted && (
                  <Field
                    label='KEY PASSWORD'
                    value={password}
                    onChange={setPassword}
                    colors={colors}
                    placeholder='Unlock your signing key'
                    secure
                  />
                )}
              </>
            )}
            {(kind === 'review' || kind === 'commit') && !dialog.automatic && (
              <>
                <Field
                  label='SOURCE KEY'
                  value={key}
                  onChange={setKey}
                  placeholder='The source key used in the request'
                  colors={colors}
                  mono
                  multiline
                />
                <Field
                  label='SIGNING REQUEST'
                  value={request}
                  onChange={setRequest}
                  placeholder='Paste the original request'
                  colors={colors}
                  mono
                  multiline
                />
                <Field
                  label='ADDITIONAL RESPONSES · OPTIONAL'
                  value={responses}
                  onChange={setResponses}
                  placeholder='Paste extra responses, one per line'
                  colors={colors}
                  mono
                  multiline
                />
              </>
            )}
            {kind === 'review' && dialog.automatic && (
              <>
                <Text style={[styles.body, { color: colors.muted }]}>
                  Verify the proposed changes before they are committed.
                </Text>
                <Text
                  selectable
                  style={[styles.reviewKey, { color: colors.ink, backgroundColor: colors.soft }]}
                >
                  {dialog.srcKey}
                </Text>
              </>
            )}
            {kind === 'commit' && (
              <>
                <Text style={[styles.body, { color: colors.muted }]}>
                  This publishes the signed changes to the multisig drive. Review them first, then
                  type COMMIT to continue.
                </Text>
                <Field
                  label='TYPE COMMIT TO CONFIRM'
                  value={confirmation}
                  onChange={setConfirmation}
                  placeholder='COMMIT'
                  colors={colors}
                />
              </>
            )}
            {kind === 'unlock' && (
              <>
                <Text style={[styles.body, { color: colors.muted }]}>
                  {busy
                    ? 'Verifying the request and sending your signature…'
                    : 'Unlock your key to sign the current request.'}
                </Text>
                <Text
                  selectable
                  style={[styles.reviewKey, { color: colors.ink, backgroundColor: colors.soft }]}
                >
                  {dialog.srcKey}
                </Text>
                {state.profile?.encrypted && (
                  <Field
                    label='KEY PASSWORD'
                    value={password}
                    onChange={setPassword}
                    colors={colors}
                    placeholder='Your key password'
                    secure
                  />
                )}
              </>
            )}
            {kind === 'output' && (
              <>
                <Text style={[styles.body, { color: colors.muted }]}>
                  Tap to copy. This stays here until you close it.
                </Text>
                <Pressable
                  accessibilityRole='button'
                  accessibilityLabel='Copy output'
                  onPress={async () => {
                    try {
                      await Clipboard.setStringAsync(dialog.text || '')
                      setCopied(true)
                      onToast('Copied to clipboard')
                    } catch {
                      setError('Could not copy. Try again.')
                    }
                  }}
                  style={[
                    styles.output,
                    { backgroundColor: colors.soft, borderColor: colors.line }
                  ]}
                >
                  <Text style={[styles.outputText, { color: colors.ink }]}>{dialog.text}</Text>
                  <View style={styles.outputHint}>
                    <Icon
                      name={copied ? 'checkmark-circle-outline' : 'copy-outline'}
                      color={colors.success}
                      size={17}
                    />
                    <Text style={[styles.small, { color: colors.success }]}>
                      {copied ? 'Copied · Tap to copy again' : 'Tap anywhere to copy'}
                    </Text>
                  </View>
                </Pressable>
                <Action title='Close' colors={colors} onPress={onClose} />
              </>
            )}
            {!!error && (
              <Text
                accessibilityLiveRegion='polite'
                style={[styles.error, { color: colors.danger }]}
              >
                {error}
              </Text>
            )}
            {submitTitle && (
              <Action
                title={submitTitle}
                onPress={() => void submit()}
                colors={colors}
                busy={busy}
                disabled={submitDisabled}
              />
            )}
            {kind === 'settings' && !exportKind && (
              <Action title='Done' onPress={onClose} colors={colors} secondary />
            )}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}
