import { useEffect, useState } from 'react'
import { ActivityIndicator, Text, View } from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { call, errorMessage } from './client'
import { shareKey } from './key-files'
import { Action, type Palette } from './ui'
import { styles } from './styles'

export default function KeyExport({
  kind,
  colors,
  onToast
}: {
  kind: 'public' | 'private'
  colors: Palette
  onToast: (text: string) => void
}) {
  const [result, setResult] = useState<{ name: string; key: string; encrypted: boolean } | null>(
    null
  )
  const [error, setError] = useState('')
  const [sharing, setSharing] = useState(false)

  useEffect(() => {
    let active = true
    call('profile.export', { kind })
      .then((value) => {
        if (active) setResult(value)
      })
      .catch((problem: Error) => {
        if (active) setError(problem.message)
      })
    return () => {
      active = false
    }
  }, [kind])

  async function copy() {
    if (!result) return
    try {
      await Clipboard.setStringAsync(result.key)
      onToast('Key copied')
    } catch {
      setError('Could not copy. Try again.')
    }
  }

  async function share() {
    if (!result || sharing) return
    setSharing(true)
    setError('')
    try {
      await shareKey(result.name, result.key)
    } catch (problem) {
      setError(errorMessage(problem))
    } finally {
      setSharing(false)
    }
  }

  return (
    <>
      {result ? (
        <>
          <Text style={[styles.fieldLabel, { color: colors.muted }]}>
            {result.encrypted ? 'ENCRYPTED PRIVATE KEY' : `${kind.toUpperCase()} KEY`}
          </Text>
          <Text
            selectable
            style={[styles.reviewKey, { color: colors.ink, backgroundColor: colors.soft }]}
          >
            {result.key}
          </Text>
          <View style={styles.buttonPair}>
            <View style={styles.grow}>
              <Action title='Copy key' colors={colors} secondary onPress={() => void copy()} />
            </View>
            <View style={styles.grow}>
              <Action
                title='Share file'
                colors={colors}
                busy={sharing}
                onPress={() => void share()}
              />
            </View>
          </View>
        </>
      ) : (
        !error && <ActivityIndicator color={colors.success} style={styles.exportLoading} />
      )}
      {!!error && (
        <Text accessibilityLiveRegion='polite' style={[styles.error, { color: colors.danger }]}>
          {error}
        </Text>
      )}
    </>
  )
}
