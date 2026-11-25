import { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  TextInput,
  View
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { call, errorMessage, type Pen, type State } from './client'
import { Action, Field, Icon, KeyCredentials, Segments, type Palette } from './ui'
import { styles } from './styles'

type Document = Record<string, any>
type Preview = { config: string; multisigKey: string; changed: boolean }

function object(value: unknown): value is Document {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parse(text: string): Document | null {
  try {
    const value = JSON.parse(text)
    return object(value) ? value : null
  } catch {
    return null
  }
}

const number = (value: string) => (/^\d+$/.test(value) ? Number(value) : value)

export default function Configuration({
  pen,
  creating,
  profile,
  initialName = '',
  colors,
  onClose,
  onSaved
}: {
  pen?: Pen
  creating: boolean
  profile: NonNullable<State['profile']>
  initialName?: string
  colors: Palette
  onClose: (name: string) => void
  onSaved: (penId: string) => void
}) {
  const link = pen ? `pear://${pen.multisigKey}` : ''
  const [name, setName] = useState(pen && pen.name !== link ? pen.name : initialName)
  const [draft, setDraft] = useState(
    pen ? '' : JSON.stringify({ multisig: { namespace: '', quorum: 1, publicKeys: [''] } }, null, 2)
  )
  const [mode, setMode] = useState('fields')
  const [loading, setLoading] = useState(!!pen)
  const [working, setWorking] = useState<'import' | 'preview' | 'save' | null>(null)
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [password, setPassword] = useState('')
  const needsPassword = creating && profile.encrypted
  const busy = loading || working !== null
  const mismatch =
    !!pen && !!preview && (preview.changed || preview.multisigKey !== pen.multisigKey)
  const document = parse(draft)
  const sectionName =
    object(document?.manifest) && !object(document?.multisig) ? 'manifest' : 'multisig'
  const recipe = sectionName === 'multisig'
  const currentSection = document?.[sectionName]
  const section = object(currentSection)
    ? currentSection
    : { namespace: '', quorum: 1, publicKeys: [] }
  const signerField = recipe ? 'publicKeys' : 'signers'
  const signers: any[] = Array.isArray(section[signerField]) ? section[signerField] : []

  useEffect(() => {
    if (!pen) return
    let active = true
    call('pen.configuration', { penId: pen.id })
      .then(({ config }: { config: string }) => {
        if (active) setDraft(config)
      })
      .catch((problem) => {
        if (active) setError(errorMessage(problem))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [pen?.id])

  function change(value: string) {
    setDraft(value)
    setPreview(null)
    setError('')
  }

  function edit(values: Document) {
    change(JSON.stringify({ ...document, [sectionName]: { ...section, ...values } }, null, 2))
  }

  function editSigner(index: number, key: string, value: string) {
    const next = [...signers]
    next[index] = recipe ? value : { ...next[index], [key]: value }
    edit({ [signerField]: next })
  }

  async function importJSON() {
    if (busy) return
    setWorking('import')
    setError('')
    try {
      const result = await DocumentPicker.getDocumentAsync({
        type: 'application/json',
        copyToCacheDirectory: true,
        multiple: false
      })
      if (result.canceled) return
      const file = new File(result.assets[0].uri)
      if (file.size > 65536) throw new Error('Choose a JSON file smaller than 64 KB.')
      const text = await file.text()
      change(text)
      if (!parse(text)) setMode('JSON')
    } catch (problem) {
      setError(errorMessage(problem))
    } finally {
      setWorking(null)
    }
  }

  async function previewLink() {
    if (busy) return
    setWorking('preview')
    setPreview(null)
    setError('')
    try {
      const result: Preview = await call('pen.preview', {
        ...(pen && { penId: pen.id }),
        config: draft
      })
      setDraft(result.config)
      setPreview(result)
    } catch (problem) {
      setError(errorMessage(problem))
    } finally {
      setWorking(null)
    }
  }

  async function save() {
    if (busy || !preview || mismatch) return
    setWorking('save')
    setError('')
    try {
      const result: State = await call(creating ? 'pen.create' : 'pen.configure', {
        ...(pen && { penId: pen.id }),
        config: preview.config,
        ...(creating && { password }),
        name: name.trim()
      })
      setPassword('')
      const saved = result.pens.find((item) => item.multisigKey === preview.multisigKey)
      onSaved(saved?.id || preview.multisigKey)
    } catch (problem) {
      setError(errorMessage(problem))
    } finally {
      setWorking(null)
    }
  }

  return (
    <Modal
      visible
      animationType='slide'
      presentationStyle='fullScreen'
      onRequestClose={() => !busy && onClose(name)}
    >
      <SafeAreaView style={[styles.page, { backgroundColor: colors.background }]}>
        <KeyboardAvoidingView
          style={styles.page}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={[styles.header, { paddingHorizontal: 20, paddingBottom: 16, gap: 10 }]}>
            <Pressable
              accessibilityRole='button'
              accessibilityLabel={creating ? 'Back to room setup' : 'Back to pen details'}
              disabled={busy}
              onPress={() => onClose(name)}
              style={styles.iconButton}
            >
              <Icon name='chevron-back' color={colors.ink} />
            </Pressable>
            <Text
              numberOfLines={1}
              style={[styles.wordmark, styles.grow, { color: colors.ink, fontSize: 20 }]}
            >
              {creating ? 'Create private room' : 'Configuration'}
            </Text>
            <Pressable
              accessibilityRole='button'
              disabled={busy}
              onPress={() => void importJSON()}
              hitSlop={10}
            >
              <Text style={[styles.small, { color: colors.success }]}>Import JSON</Text>
            </Pressable>
          </View>
          {loading ? (
            <View style={[styles.page, styles.center]}>
              <ActivityIndicator color={colors.success} />
            </View>
          ) : (
            <ScrollView
              keyboardShouldPersistTaps='handled'
              contentContainerStyle={{ paddingHorizontal: 25, paddingBottom: 25 }}
            >
              {creating && (
                <Text style={[styles.body, { color: colors.muted }]}>
                  Invitees receive this configuration after they prove they are one of its signers.
                </Text>
              )}
              <Field
                label='PEN NAME · OPTIONAL'
                placeholder={link || 'Defaults to the drive link'}
                value={name}
                onChange={setName}
                colors={colors}
                editable={!busy}
              />
              <View style={{ marginTop: 24 }}>
                <Segments
                  items={['fields', 'JSON']}
                  value={mode}
                  onChange={(value) => !busy && setMode(value)}
                  colors={colors}
                />
              </View>
              {mode === 'JSON' ? (
                <TextInput
                  accessibilityLabel='Configuration JSON'
                  value={draft}
                  onChangeText={change}
                  editable={!busy}
                  multiline
                  autoCapitalize='none'
                  autoCorrect={false}
                  spellCheck={false}
                  style={[
                    styles.input,
                    styles.mono,
                    {
                      minHeight: 340,
                      textAlignVertical: 'top',
                      marginTop: 20,
                      backgroundColor: colors.soft,
                      color: colors.ink,
                      borderColor: colors.line
                    }
                  ]}
                />
              ) : document ? (
                <>
                  {recipe ? (
                    <Field
                      label='NAMESPACE'
                      value={String(section.namespace ?? '')}
                      onChange={(value) => edit({ namespace: value })}
                      colors={colors}
                      editable={!busy}
                    />
                  ) : (
                    <>
                      <Field
                        label='VERSION'
                        value={String(section.version ?? '')}
                        onChange={(value) => edit({ version: number(value) })}
                        colors={colors}
                        numeric
                        editable={!busy}
                      />
                      <Field
                        label='HASH'
                        value={String(section.hash ?? '')}
                        onChange={(value) => edit({ hash: value })}
                        colors={colors}
                        editable={!busy}
                      />
                      <View style={[styles.between, { marginTop: 20 }]}>
                        <Text style={[styles.body, { color: colors.ink }]}>Allow patch</Text>
                        <Switch
                          disabled={busy}
                          value={!!section.allowPatch}
                          onValueChange={(value) => edit({ allowPatch: value })}
                        />
                      </View>
                    </>
                  )}
                  <Field
                    label='QUORUM'
                    value={String(section.quorum ?? '')}
                    onChange={(value) => edit({ quorum: number(value) })}
                    colors={colors}
                    numeric
                    editable={!busy}
                  />
                  {signers.map((signer, index) => (
                    <View key={index} style={{ marginTop: 25 }}>
                      <View style={styles.between}>
                        <Text style={[styles.fieldLabel, { color: colors.muted }]}>
                          SIGNER {index + 1}
                        </Text>
                        <Pressable
                          accessibilityRole='button'
                          accessibilityLabel={`Remove signer ${index + 1}`}
                          disabled={busy}
                          onPress={() =>
                            edit({
                              [signerField]: signers.filter((_, position) => position !== index)
                            })
                          }
                          hitSlop={10}
                        >
                          <Icon name='remove-circle-outline' color={colors.muted} size={20} />
                        </Pressable>
                      </View>
                      {(recipe ? ['publicKey'] : ['publicKey', 'namespace', 'signature']).map(
                        (key) => (
                          <Field
                            key={key}
                            label={
                              key === 'publicKey'
                                ? 'PUBLIC KEY'
                                : key === 'namespace'
                                  ? 'NAMESPACE HASH'
                                  : 'SIGNATURE'
                            }
                            value={String(recipe ? signer : (signer?.[key] ?? ''))}
                            onChange={(value) => editSigner(index, key, value)}
                            colors={colors}
                            mono
                            multiline={key !== 'signature'}
                            editable={!busy}
                          />
                        )
                      )}
                    </View>
                  ))}
                  <Action
                    title='Add signer'
                    disabled={busy}
                    onPress={() =>
                      edit({
                        [signerField]: [
                          ...signers,
                          recipe ? '' : { signature: 'ed25519', namespace: '', publicKey: '' }
                        ]
                      })
                    }
                    colors={colors}
                    secondary
                  />
                </>
              ) : (
                <Text style={[styles.settingsHint, { color: colors.muted }]}>
                  Import JSON or edit the document in JSON mode.
                </Text>
              )}
              {preview && (
                <>
                  <Text style={[styles.sectionLabel, { color: colors.muted }]}>
                    Configuration produces
                  </Text>
                  <Text
                    selectable
                    style={[styles.reviewKey, { color: colors.ink, backgroundColor: colors.soft }]}
                  >
                    pear://{preview.multisigKey}
                  </Text>
                  {mismatch && (
                    <>
                      <Text
                        accessibilityLiveRegion='polite'
                        style={[styles.error, { color: colors.danger }]}
                      >
                        This configuration does not match this pen. Its link cannot be changed.
                      </Text>
                      <Text style={[styles.sectionLabel, { color: colors.muted }]}>
                        Expected pen link
                      </Text>
                      <Text
                        selectable
                        style={[
                          styles.reviewKey,
                          { color: colors.ink, backgroundColor: colors.soft }
                        ]}
                      >
                        pear://{pen.multisigKey}
                      </Text>
                    </>
                  )}
                </>
              )}
              {preview && !mismatch && needsPassword && (
                <KeyCredentials
                  username={profile.username || profile.name || profile.publicKey}
                  password={password}
                  onChange={setPassword}
                  colors={colors}
                  busy={busy}
                />
              )}
              {!!error && (
                <Text
                  accessibilityLiveRegion='polite'
                  style={[styles.error, { color: colors.danger }]}
                >
                  {error}
                </Text>
              )}
            </ScrollView>
          )}
          <View style={[styles.detailFooter, { borderTopColor: colors.line }]}>
            <Action
              title='Preview link'
              onPress={() => void previewLink()}
              colors={colors}
              secondary
              disabled={busy || !draft.trim()}
              busy={working === 'preview'}
            />
            {preview && !mismatch && (
              <Action
                title={creating ? 'Create room' : 'Save configuration'}
                onPress={() => void save()}
                colors={colors}
                disabled={busy || (needsPassword && !password)}
                busy={working === 'save'}
              />
            )}
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  )
}
