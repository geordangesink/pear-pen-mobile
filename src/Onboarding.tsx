import { useState } from 'react'
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { call, errorMessage } from './client'
import { Action, Field, Icon, type Palette } from './ui'
import { styles } from './styles'

export default function Onboarding({ colors }: { colors: Palette }) {
  const [name, setName] = useState('')
  const [importing, setImporting] = useState(false)
  const [publicKey, setPublic] = useState('')
  const [secretKey, setSecret] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function pick(set: (value: string) => void) {
    try {
      const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false
      })
      if (!result.canceled) {
        const file = new File(result.assets[0].uri)
        if (file.size > 65536) throw new Error('Choose a key file smaller than 64 KB.')
        set((await file.text()).trim())
      }
    } catch (problem) {
      setError(errorMessage(problem))
    }
  }

  async function submit() {
    if (publicKey.trim() && !secretKey.trim()) {
      setImporting(true)
      setError('Add the private key, or clear both keys to create new ones.')
      return
    }
    setBusy(true)
    setError('')
    try {
      await call('profile.import', {
        name,
        publicKey: publicKey.trim(),
        secretKey: secretKey.trim(),
        password
      })
      setSecret('')
      setPassword('')
    } catch (problem) {
      setError(errorMessage(problem))
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView keyboardShouldPersistTaps='handled' contentContainerStyle={styles.onboarding}>
        <Image source={require('../assets/icon.png')} style={styles.onboardingIcon} />
        <Text style={[styles.onboardingTitle, { color: colors.ink }]}>Pear Pen</Text>
        <Field
          label='NAME · OPTIONAL'
          value={name}
          onChange={setName}
          colors={colors}
          placeholder='Your name'
        />
        <Pressable
          accessibilityRole='button'
          accessibilityState={{ expanded: importing }}
          onPress={() => setImporting(!importing)}
          style={styles.importToggle}
        >
          <Text style={[styles.importText, { color: colors.muted }]}>Import keys (optional)</Text>
          <Icon name={importing ? 'chevron-up' : 'chevron-down'} color={colors.muted} size={15} />
        </Pressable>
        {importing && (
          <>
            <View style={styles.labelRow}>
              <Text style={[styles.fieldLabel, { color: colors.muted }]}>
                PUBLIC KEY · OPTIONAL
              </Text>
              <Pressable
                accessibilityLabel='Import public key file'
                onPress={() => void pick(setPublic)}
                hitSlop={12}
              >
                <Text style={[styles.importText, { color: colors.success }]}>Import file ↗</Text>
              </Pressable>
            </View>
            <Field
              label=''
              value={publicKey}
              onChange={setPublic}
              colors={colors}
              placeholder='Paste a public key'
              mono
              multiline
            />
            <View style={styles.labelRow}>
              <Text style={[styles.fieldLabel, { color: colors.muted }]}>
                PRIVATE KEY · OPTIONAL
              </Text>
              <Pressable
                accessibilityLabel='Import private key file'
                onPress={() => void pick(setSecret)}
                hitSlop={12}
              >
                <Text style={[styles.importText, { color: colors.success }]}>Import file ↗</Text>
              </Pressable>
            </View>
            <Field
              label=''
              value={secretKey}
              onChange={setSecret}
              colors={colors}
              placeholder='Paste a private key'
              secure
              mono
            />
            {!!secretKey.trim() && (
              <Field
                label='KEY PASSWORD · IF ENCRYPTED'
                value={password}
                onChange={setPassword}
                colors={colors}
                placeholder='Your key password'
                secure
              />
            )}
          </>
        )}
        {!!error && (
          <Text accessibilityLiveRegion='polite' style={[styles.error, { color: colors.danger }]}>
            {error}
          </Text>
        )}
        <Action title='Continue' onPress={() => void submit()} colors={colors} busy={busy} />
        {!publicKey.trim() && !secretKey.trim() && (
          <Text style={[styles.onboardingHint, { color: colors.muted }]}>
            New keys are created automatically.
          </Text>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
