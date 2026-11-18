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
import { call, client, errorMessage, type Pen, type SavedDialog } from './client'
import { clearKeyExports } from './key-files'
import Onboarding from './Onboarding'
import Detail from './PenDetail'
import PenList from './PenList'
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
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [toast, setToast] = useState('')
  const applying = useRef(false)
  const shownDialog = useRef<SavedDialog | null>(null)
  const { state, update, failure, warning } = data
  const theme = state?.settings.theme || 'system'
  const colors = (theme === 'system' ? system : theme) === 'dark' ? dark : light
  const selected = state?.pens.find((pen) => pen.id === selectedId)

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

  async function close() {
    if (dialog?.kind === 'output') {
      try {
        await call('dialog.save', { dialog: null })
      } catch (error) {
        setToast(errorMessage(error))
        return
      }
    }
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
  function openPen(pen: Pen) {
    if (state?.settings.mode === 'manual') setDialog({ kind: 'actions', penId: pen.id })
    else setSelectedId(pen.id)
  }
  function openAutomatic(kind: 'request' | 'unlock' | 'review' | 'commit', pen: Pen) {
    setDialog({
      kind,
      penId: pen.id,
      automatic: true,
      autoSubmit: kind === 'unlock' && !state?.profile?.encrypted,
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
      {!state.profile ? (
        <Onboarding colors={colors} />
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
            <View style={styles.headerTitle}>
              <Text numberOfLines={1} style={[styles.wordmark, { color: colors.ink }]}>
                {selected?.name || 'Pear Pen'}
              </Text>
              <Text style={[styles.small, { color: colors.muted }]}>
                {selected ? `${selected.peers || 0} peers connected` : 'Multisig signing'}
              </Text>
            </View>
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
              onCopyResponse={(requestId) => void copyResponse(selected.id, requestId)}
              onOutput={(text, title) => void showOutput(text, title)}
              onReview={() => openAutomatic('review', selected)}
              onCommit={() => openAutomatic('commit', selected)}
            />
          ) : (
            <PenList
              state={state}
              colors={colors}
              onOpen={openPen}
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
