import { useState } from 'react'
import {
  ActivityIndicator,
  Alert,
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
import { call, errorMessage, knownQuorum, type SavedDialog, type State } from './client'
import KeyExport from './KeyExport'
import ManualSigning, { type ManualAction } from './ManualSigning'
import Configuration from './Configuration'
import PenAvatar from './PenAvatar'
import { choosePenImage } from './pen-images'
import { Action, Field, Icon, Segments, type Palette } from './ui'
import { styles } from './styles'
import { version } from '../package.json'

export type Dialog = {
  kind:
    | 'add'
    | 'settings'
    | 'actions'
    | 'details'
    | 'configuration'
    | ManualAction
    | 'unlock'
    | 'output'
  title?: string
  name?: string
  text?: string
  details?: string
  penId?: string
  automatic?: boolean
  requestId?: string
  srcKey?: string
}

const help = 'https://docs.pears.com/pear/how-to/operate-an-app/multisig/set-up-multisig/'

const signingActions = [
  ['details', 'Pen details', 'information-circle-outline'],
  ['request', 'Create request', 'add-circle-outline'],
  ['sign', 'Sign request', 'pencil-outline'],
  ['response', 'Submit response', 'send-outline'],
  ['verify', 'Verify signature', 'checkmark-circle-outline'],
  ['review', 'Review', 'reader-outline'],
  ['commit', 'Commit', 'checkmark-done-outline']
] as const

const submitTitles: Partial<Record<Dialog['kind'], string>> = {
  add: 'Add pen',
  request: 'Create request',
  unlock: 'Sign request',
  review: 'Review changes',
  commit: 'Commit changes'
}

export async function saveOutput(
  value: unknown,
  title: string,
  details?: string
): Promise<SavedDialog> {
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
  const dialog: SavedDialog = { kind: 'output', title, text, ...(details && { details }) }
  await call('dialog.save', { dialog })
  return dialog
}

export default function DialogView({
  dialog,
  state,
  colors,
  onClose,
  onDialog,
  onToast,
  onSelectPen,
  onPenRemoved
}: {
  dialog: Dialog
  state: State
  colors: Palette
  onClose: () => void
  onDialog: (dialog: Dialog) => void
  onToast: (text: string) => void
  onSelectPen: (penId: string) => void
  onPenRemoved: (penId: string) => void
}) {
  const pen = state.pens.find((item) => item.id === dialog.penId)
  const quorum = pen ? knownQuorum(pen) : 0
  const kind = dialog.kind
  const manual =
    !dialog.automatic &&
    (kind === 'request' ||
      kind === 'sign' ||
      kind === 'response' ||
      kind === 'verify' ||
      kind === 'review' ||
      kind === 'commit')
  const [name, setName] = useState(
    dialog.kind === 'settings' ? state.profile!.name : dialog.name || ''
  )
  const [editing, setEditing] = useState(false)
  const [exportKind, setExportKind] = useState<'public' | 'private' | null>(null)
  const [key, setKey] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const needsPassword = kind === 'unlock' && state.profile?.encrypted
  const username = state.profile?.username || state.profile?.name
  const needsKey = kind === 'add' || kind === 'request'
  const submitDisabled =
    (needsPassword && !password) ||
    (needsKey && !key.trim()) ||
    (kind === 'commit' && confirmation !== 'COMMIT')
  const submitTitle = !manual && submitTitles[kind]
  const title =
    (exportKind ? `Export ${exportKind} key` : '') ||
    dialog.title ||
    {
      add: 'Add a pen',
      settings: 'Settings',
      actions: pen?.name || 'Signing actions',
      details: 'Pen details',
      configuration: 'Configuration',
      request: 'New request',
      sign: 'Sign request',
      response: 'Submit response',
      verify: 'Verify signature',
      review: 'Review request',
      commit: 'Commit release',
      unlock: 'Sign request',
      output: 'Output'
    }[kind]

  async function output(result: unknown, title: string, details?: string) {
    onDialog(await saveOutput(result, title, details))
  }
  async function submit() {
    setBusy(true)
    setError('')
    try {
      if (kind === 'add') {
        await call('pen.add', {
          name: name.trim(),
          multisigKey: key.trim()
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
        await call('request.create', { penId: pen!.id, srcKey: key.trim() })
        onClose()
        onToast('Request shared')
      } else if (kind === 'review' || kind === 'commit') {
        const result = await call(`request.${kind}`, {
          penId: pen!.id,
          confirmation,
          requestId: dialog.requestId
        })
        if (kind === 'review') await output(result, 'Review')
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

  async function setting(change: Record<string, string>) {
    try {
      await call('settings.update', change)
    } catch (problem) {
      setError(errorMessage(problem))
    }
  }

  async function copy(text: string, message = 'Copied to clipboard') {
    try {
      await Clipboard.setStringAsync(text)
      setCopied(true)
      setError('')
      onToast(message)
    } catch {
      setError('Could not copy. Try again.')
    }
  }

  async function updateImage(action: 'change' | 'remove') {
    if (!pen || busy) return
    setBusy(true)
    setError('')
    try {
      let image: string | null = null
      if (action === 'change') {
        image = await choosePenImage()
        if (!image) return
      }
      await call('pen.image', { penId: pen.id, image })
      onToast(action === 'remove' ? 'Pen image removed' : 'Pen image updated')
    } catch (problem) {
      setError(errorMessage(problem))
    } finally {
      setBusy(false)
    }
  }

  function confirmRemoval() {
    if (!pen || busy) return
    Alert.alert(
      'Remove pen from this device?',
      `${pen.name}\n\nYou can add it again with its multisig link.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            setBusy(true)
            setError('')
            try {
              await call('pen.remove', { penId: pen.id })
              onPenRemoved(pen.id)
            } catch (problem) {
              setError(errorMessage(problem))
            } finally {
              setBusy(false)
            }
          }
        }
      ],
      { cancelable: true }
    )
  }

  function closeSheet() {
    if (busy) return
    if (exportKind) setExportKind(null)
    else onClose()
  }

  if (kind === 'configuration') {
    return (
      <Configuration
        pen={pen}
        initialName={dialog.name}
        colors={colors}
        onClose={(name) =>
          onDialog(pen ? { kind: 'details', penId: pen.id } : { kind: 'add', name })
        }
        onSaved={(penId) => {
          if (!pen) onSelectPen(penId)
          onToast(pen ? 'Configuration saved' : 'Pen added')
          onDialog({ kind: 'details', penId })
        }}
      />
    )
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
            keyboardDismissMode={Platform.OS === 'ios' ? 'interactive' : 'on-drag'}
            contentContainerStyle={styles.sheetContent}
          >
            {kind === 'add' && (
              <>
                <Segments
                  items={['link', 'configuration']}
                  value='link'
                  onChange={(mode) => {
                    if (!busy && mode === 'configuration') onDialog({ kind: 'configuration', name })
                  }}
                  colors={colors}
                />
                <Text style={[styles.body, { color: colors.muted }]}>
                  Add an existing multisig drive.
                </Text>
                <Field
                  label='MULTISIG DRIVE KEY'
                  value={key}
                  onChange={setKey}
                  placeholder='Paste a multisig key or pear:// link'
                  colors={colors}
                  mono
                  multiline
                />
                <Field
                  label='PEN NAME · OPTIONAL'
                  value={name}
                  onChange={setName}
                  placeholder='Defaults to the drive link'
                  colors={colors}
                />
                <Pressable onPress={() => void Linking.openURL(help)} style={styles.helpLink}>
                  <Icon name='help-circle-outline' color={colors.success} size={17} />
                  <Text style={[styles.small, { color: colors.success }]}>
                    Where do I find this key? ↗
                  </Text>
                </Pressable>
                <Text style={[styles.settingsHint, { color: colors.muted }]}>
                  You can sign or review an existing request without adding a configuration. To
                  create a request, Pear Pen can use /pear.json at the root of the source drive or
                  the configuration in Pen details.
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
                  selection={colors.signingMode[state.settings.mode]}
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
            {kind === 'details' && pen && (
              <>
                <View style={[styles.row, { gap: 16, marginTop: 8 }]}>
                  <PenAvatar image={pen.image} colors={colors} size={72} />
                  <View style={styles.grow}>
                    <Action
                      title={pen.image ? 'Change image' : 'Choose image'}
                      onPress={() => void updateImage('change')}
                      colors={colors}
                      busy={busy}
                      secondary
                    />
                    {pen.image && (
                      <Pressable
                        accessibilityRole='button'
                        disabled={busy}
                        onPress={() => void updateImage('remove')}
                        style={{ alignItems: 'center', paddingVertical: 10 }}
                      >
                        <Text style={[styles.small, { color: colors.muted }]}>Remove image</Text>
                      </Pressable>
                    )}
                  </View>
                </View>
                {pen.name !== `pear://${pen.multisigKey}` && (
                  <>
                    <Text style={[styles.sectionLabel, { color: colors.muted }]}>NAME</Text>
                    <Text style={[styles.settingsName, { color: colors.ink }]}>{pen.name}</Text>
                  </>
                )}
                <Text style={[styles.sectionLabel, { color: colors.muted }]}>
                  MULTISIG DRIVE LINK
                </Text>
                <Text
                  selectable
                  style={[styles.reviewKey, { color: colors.ink, backgroundColor: colors.soft }]}
                >
                  pear://{pen.multisigKey}
                </Text>
                <Action
                  title={copied ? 'Link copied' : 'Copy link'}
                  onPress={() => void copy(`pear://${pen.multisigKey}`, 'Pen link copied')}
                  colors={colors}
                  secondary
                />
                {quorum > 0 && (
                  <View style={[styles.manualAction, { borderBottomColor: colors.line }]}>
                    <Text style={[styles.manualText, { color: colors.ink }]}>Quorum</Text>
                    <Text style={[styles.body, { color: colors.muted }]}>{quorum}</Text>
                  </View>
                )}
                <View style={[styles.manualAction, { borderBottomColor: colors.line }]}>
                  <Text style={[styles.manualText, { color: colors.ink }]}>Connected peers</Text>
                  <Text style={[styles.body, { color: colors.muted }]}>{pen.peers}</Text>
                </View>
                {pen.quorumMismatch && (
                  <Text style={[styles.settingsHint, { color: colors.muted }]}>
                    Drive quorum is {pen.quorum} (entered {pen.configuredQuorum}).
                  </Text>
                )}
                <Text style={[styles.settingsHint, { color: colors.muted }]}>
                  Read from the source automatically, or import its pear.json.
                </Text>
                <Action
                  title='Configuration'
                  onPress={() => onDialog({ kind: 'configuration', penId: pen.id })}
                  colors={colors}
                  busy={busy}
                  secondary
                />
                <Pressable
                  accessibilityRole='button'
                  disabled={busy}
                  onPress={confirmRemoval}
                  style={[styles.manualAction, { borderBottomColor: colors.line }]}
                >
                  <Icon name='trash-outline' color={colors.danger} size={20} />
                  <Text style={[styles.manualText, { color: colors.danger }]}>
                    Remove pen from this device
                  </Text>
                </Pressable>
              </>
            )}
            {kind === 'actions' && (
              <>
                <Text style={[styles.body, styles.actionsIntro, { color: colors.muted }]}>
                  Choose an action.
                </Text>
                {signingActions.map(([action, label, icon]) => (
                  <Pressable
                    key={action}
                    accessibilityRole='button'
                    onPress={() =>
                      onDialog({ kind: action, penId: pen!.id, requestId: pen!.request?.id })
                    }
                    style={[styles.manualAction, { borderBottomColor: colors.line }]}
                  >
                    <Icon name={icon} color={colors.success} />
                    <Text style={[styles.manualText, { color: colors.ink }]}>{label}</Text>
                    <Icon name='chevron-forward' color={colors.muted} size={17} />
                  </Pressable>
                ))}
                <View style={styles.cancelGap}>
                  <Action title='Cancel' onPress={onClose} colors={colors} secondary />
                </View>
              </>
            )}
            {manual && pen && state.profile && (
              <ManualSigning
                method={kind}
                pen={pen}
                profile={state.profile}
                requestId={dialog.requestId}
                colors={colors}
                busy={busy}
                setBusy={setBusy}
                onBack={() => onDialog({ kind: 'actions', penId: pen.id })}
                onOutput={output}
              />
            )}
            {!manual &&
              kind === 'request' &&
              (busy ? (
                <View style={styles.center}>
                  <ActivityIndicator color={colors.success} size='large' />
                  <Text style={[styles.body, { color: colors.muted }]}>
                    Connecting and loading source…
                  </Text>
                  <Text selectable style={[styles.sourceKey, { color: colors.ink }]}>
                    {key.trim()}
                  </Text>
                </View>
              ) : (
                <>
                  <Text style={[styles.body, { color: colors.muted }]}>
                    {pen?.request
                      ? 'Opening a new request closes the current one as unanswered.'
                      : 'Enter the source drive key or pear:// link.'}
                  </Text>
                  <Field
                    label='SOURCE KEY'
                    value={key}
                    onChange={setKey}
                    placeholder='Paste a source key or pear:// link'
                    colors={colors}
                    mono
                    multiline
                  />
                </>
              ))}
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
            {kind === 'commit' && dialog.automatic && (
              <>
                <Text style={[styles.body, { color: colors.muted }]}>
                  This publishes the signed changes to the multisig drive. Review them first, then
                  type COMMIT to continue.
                </Text>
                <Text
                  selectable
                  style={[styles.reviewKey, { color: colors.ink, backgroundColor: colors.soft }]}
                >
                  {dialog.srcKey}
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
                    : 'Your signature approves this exact source snapshot.'}
                </Text>
                <Text
                  selectable
                  style={[styles.reviewKey, { color: colors.ink, backgroundColor: colors.soft }]}
                >
                  {dialog.srcKey}
                </Text>
              </>
            )}
            {needsPassword && (
              <>
                {username && (
                  <Field
                    label='USERNAME'
                    value={username}
                    colors={colors}
                    autoComplete='username'
                    editable={false}
                  />
                )}
                <Field
                  label='PASSWORD'
                  value={password}
                  onChange={setPassword}
                  colors={colors}
                  placeholder='Enter your key password'
                  autoComplete='current-password'
                  secure
                />
              </>
            )}
            {kind === 'output' && (
              <>
                <Text style={[styles.body, { color: colors.muted }]}>
                  Tap to copy. This stays here until you close it.
                </Text>
                {!!dialog.details && (
                  <Text
                    selectable
                    style={[styles.reviewKey, { color: colors.ink, backgroundColor: colors.soft }]}
                  >
                    {dialog.details}
                  </Text>
                )}
                <Pressable
                  accessibilityRole='button'
                  accessibilityLabel='Copy output'
                  onPress={() => void copy(dialog.text || '')}
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
            {submitTitle && !(kind === 'request' && busy) && (
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
