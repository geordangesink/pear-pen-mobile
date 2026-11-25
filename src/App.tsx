import { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Image,
  Platform,
  Pressable,
  Text,
  useColorScheme,
  View
} from 'react-native'
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context'
import { reloadAppAsync } from 'expo-modules-core'
import { StatusBar } from 'expo-status-bar'
import {
  call,
  client,
  errorMessage,
  verifySignature,
  type Pen,
  type SavedDialog,
  type SignatureVerification
} from './client'
import { clearKeyExports } from './key-files'
import Onboarding from './Onboarding'
import Detail from './PenDetail'
import PenList from './PenList'
import PenAvatar from './PenAvatar'
import DialogView, { saveOutput, type Dialog } from './Dialogs'
import { dark, light, Icon } from './ui'
import { styles } from './styles'

export default function App() {
  return (
    <SafeAreaProvider>
      <PearPen />
    </SafeAreaProvider>
  )
}

function PearPen() {
  const system = useColorScheme()
  const [data, setData] = useState(client.read())
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [openDialog, setDialog] = useState<Dialog | null>(null)
  const [toast, setToast] = useState('')
  const [creatingIdentity, setCreatingIdentity] = useState(false)
  const [verifyingId, setVerifyingId] = useState<string | null>(null)
  const verification = useRef<Promise<string> | null>(null)
  const applying = useRef(false)
  const shownDialog = useRef<SavedDialog | null>(null)
  const { state, update, failure, warning } = data
  const theme = state?.settings.theme || 'system'
  const colors = (theme === 'system' ? system : theme) === 'dark' ? dark : light
  const manual = state?.settings.mode === 'manual'
  const activePen = state?.pens.find((pen) => pen.id === selectedId)
  const selected = manual ? undefined : activePen
  const dialog: Dialog | null =
    openDialog ?? (manual && activePen ? { kind: 'actions', penId: activePen.id } : null)

  useEffect(() => {
    const unsubscribe = client.subscribe(() => setData(client.read()))
    try {
      clearKeyExports()
    } catch {}
    client.start()
    return unsubscribe
  }, [])
  useEffect(() => {
    const saved = state?.dialog || null
    const previous = shownDialog.current
    if (saved && (!previous || saved.title !== previous.title || saved.text !== previous.text)) {
      setDialog(saved)
    }
    shownDialog.current = saved
  }, [state?.dialog])
  useEffect(() => {
    if (update.status === 'applied' && applying.current) {
      applying.current = false
      reloadAppAsync('Pear Pen update').catch((error: Error) => setToast(error.message))
    }
    if (update.status === 'error') applying.current = false
  }, [update.status])
  useEffect(() => {
    if (warning) setToast(warning)
  }, [warning])
  useEffect(() => {
    if (!toast) return
    const timer = setTimeout(() => setToast(''), 2800)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    setVerifyingId(null)
    return () => {
      verification.current = null
    }
  }, [selected?.id, openDialog])

  async function close() {
    if (dialog?.kind === 'output') {
      try {
        await call('dialog.save', { dialog: null })
      } catch (error) {
        setToast(errorMessage(error))
        return
      }
    }
    if (manual && dialog?.kind !== 'settings') setSelectedId(null)
    setDialog(null)
  }
  async function showOutput(text: string, title: string) {
    try {
      setDialog(await saveOutput(text, title))
    } catch (problem) {
      setToast(errorMessage(problem))
    }
  }
  async function copyResponse(penId: string, requestId: string) {
    try {
      const result = await call('request.response', { penId, requestId })
      await showOutput(result.output, 'Signature response')
    } catch (problem) {
      setToast(errorMessage(problem))
    }
  }
  async function verifyActivity(penId: string, entryId: string, signature: SignatureVerification) {
    if (verification.current) return
    const check = verifySignature(penId, signature)
    verification.current = check
    setVerifyingId(entryId)
    try {
      const text = await check
      if (verification.current === check) await showOutput(text, 'Signature verified')
    } catch (problem) {
      if (verification.current === check) setToast(errorMessage(problem))
    } finally {
      if (verification.current === check) {
        verification.current = null
        setVerifyingId(null)
      }
    }
  }
  function openAutomatic(kind: 'request' | 'unlock' | 'review' | 'commit', pen: Pen) {
    setDialog({
      kind,
      penId: pen.id,
      automatic: true,
      requestId: pen.request?.id,
      srcKey: pen.request?.srcKey
    })
  }

  if (!state)
    return (
      <SafeAreaView style={[styles.page, styles.center, { backgroundColor: colors.background }]}>
        <StatusBar style={colors === dark ? 'light' : 'dark'} />
        <Image source={require('../assets/icon.png')} style={styles.bootIcon} />
        {failure ? (
          <Text style={[styles.body, { color: colors.danger }]}>{failure}</Text>
        ) : (
          <ActivityIndicator color={colors.success} />
        )}
      </SafeAreaView>
    )

  return (
    <SafeAreaView
      style={[styles.page, { backgroundColor: colors.background }]}
      edges={['top', 'bottom']}
    >
      <StatusBar style={colors === dark ? 'light' : 'dark'} />
      {!state.profile || creatingIdentity ? (
        <Onboarding
          colors={colors}
          suggestedName={state.suggestedName || ''}
          onSubmitting={setCreatingIdentity}
        />
      ) : (
        <>
          <View style={styles.header}>
            {selected ? (
              <Pressable
                accessibilityLabel='Back to pens'
                onPress={() => setSelectedId(null)}
                style={[styles.iconButton, { backgroundColor: colors.soft }]}
              >
                <Icon name='chevron-back' color={colors.ink} />
              </Pressable>
            ) : (
              <Image source={require('../assets/icon.png')} style={styles.brandIcon} />
            )}
            {selected?.image && <PenAvatar image={selected.image} colors={colors} size={36} />}
            <View style={styles.headerTitle}>
              <Text numberOfLines={1} style={[styles.wordmark, { color: colors.ink }]}>
                {selected?.name || 'Pear Pen'}
              </Text>
              <Text style={[styles.small, { color: colors.muted }]}>
                {selected ? `${selected.peers || 0} peers connected` : 'Multisig signing'}
              </Text>
            </View>
            {selected && (
              <Pressable
                accessibilityRole='button'
                accessibilityLabel='Pen details'
                onPress={() => setDialog({ kind: 'details', penId: selected.id })}
                hitSlop={4}
                style={styles.iconButton}
              >
                <Icon name='information-circle-outline' color={colors.ink} />
              </Pressable>
            )}
            <Pressable
              accessibilityLabel='Settings'
              onPress={() => setDialog({ kind: 'settings' })}
              hitSlop={12}
              style={styles.iconButton}
            >
              <Icon name='settings-outline' color={colors.ink} />
            </Pressable>
          </View>
          {selected ? (
            <Detail
              key={selected.id}
              pen={selected}
              state={state}
              colors={colors}
              onRequest={() => openAutomatic('request', selected)}
              onSign={() => openAutomatic('unlock', selected)}
              onVerify={(entryId, signature) =>
                void verifyActivity(selected.id, entryId, signature)
              }
              verifyingId={verifyingId}
              onCopyResponse={(requestId) => void copyResponse(selected.id, requestId)}
              onOutput={(text, title) => void showOutput(text, title)}
              onReview={() => openAutomatic('review', selected)}
              onCommit={() => openAutomatic('commit', selected)}
            />
          ) : (
            <PenList
              state={state}
              colors={colors}
              onOpen={(pen) => setSelectedId(pen.id)}
              onDetails={(pen) => setDialog({ kind: 'details', penId: pen.id })}
              onAdd={() => setDialog({ kind: 'add' })}
            />
          )}
          {!!failure && <Text style={[styles.notice, { color: colors.danger }]}>{failure}</Text>}
          {['available', 'error', 'minver-required', 'downloading'].includes(update.status) && (
            <Pressable
              disabled={update.status !== 'available'}
              onPress={() => {
                if (applying.current) return
                applying.current = true
                client.applyUpdate()
              }}
              style={[styles.update, { backgroundColor: colors.soft }]}
            >
              <Icon name='arrow-down-circle-outline' color={colors.success} size={18} />
              <Text style={[styles.small, { color: colors.ink }]}>
                {update.status === 'available'
                  ? 'Update ready · Tap to install and restart'
                  : update.status === 'downloading'
                    ? 'Downloading an update…'
                    : update.status === 'minver-required'
                      ? `A new version is available in the ${Platform.OS === 'ios' ? 'App Store' : 'Play Store'}.`
                      : update.message || 'Update failed. Restart to try again.'}
              </Text>
            </Pressable>
          )}
        </>
      )}
      {dialog && (
        <DialogView
          key={`${dialog.kind}:${dialog.penId || ''}:${dialog.text || ''}`}
          dialog={dialog}
          state={state}
          colors={colors}
          onClose={() => void close()}
          onDialog={setDialog}
          onToast={setToast}
          onSelectPen={(penId) => {
            if (state.settings.mode === 'automatic') setSelectedId(penId)
          }}
          onPenRemoved={(penId) => {
            setSelectedId((current) => (current === penId ? null : current))
            setDialog(null)
            setToast('Pen removed')
          }}
        />
      )}
      {!!toast && (
        <View
          accessibilityLiveRegion='polite'
          pointerEvents='none'
          style={[styles.toast, { backgroundColor: colors.ink }]}
        >
          <Text style={[styles.toastText, { color: colors.card }]}>{toast}</Text>
        </View>
      )}
    </SafeAreaView>
  )
}
