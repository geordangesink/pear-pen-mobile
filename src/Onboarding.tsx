import { useState } from 'react'
import {
  Image,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'
import * as DocumentPicker from 'expo-document-picker'
import { File } from 'expo-file-system'
import { requireOptionalNativeModule } from 'expo-modules-core'
import { call, errorMessage } from './client'
import { Action, Field, Icon, type Palette } from './ui'
import { styles } from './styles'
import { usePassword } from './usePassword'

export default function Onboarding({
  colors,
  suggestedName,
  onSubmitting
}: {
  colors: Palette
  suggestedName: string
  onSubmitting: (busy: boolean) => void
}) {
  const [name, setName] = useState('')
  const [importing, setImporting] = useState(false)
  const [publicKey, setPublic] = useState('')
  const [secretKey, setSecret] = useState('')
  const [unlocking, setUnlocking] = useState(false)
  const password = usePassword()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const hasSecret = !!secretKey.trim()
  const generating = !hasSecret && !publicKey.trim()
  const username = name.trim() || suggestedName

  function toggleImport() {
    if (importing) {
      setPublic('')
      setSecret('')
    }
    setError('')
    setImporting(!importing)
  }

  async function pick(set: (value: string) => void) {
    setBusy(true)
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
    } finally {
      setBusy(false)
    }
  }

  async function submit() {
    if (publicKey.trim() && !hasSecret) {
      setError('Add the private key, or clear both keys to create new ones.')
      return
    }
    if (generating && !unlocking) {
      setName(username)
      setError('')
      setUnlocking(true)
      return
    }
    setBusy(true)
    setError('')
    setName(username)
    Keyboard.dismiss()
    onSubmitting(true)
    try {
      await call('profile.import', {
        name: username,
        publicKey: publicKey.trim(),
        secretKey: secretKey.trim(),
        ...(unlocking && { password: password.take(generating) })
      })
      if (!hasSecret && Platform.OS === 'android') {
        const autofill = requireOptionalNativeModule<{ commit(): Promise<void> }>('PenAutofill')
        await autofill?.commit().catch(() => {})
      }
    } catch (problem) {
      password.clear()
      if (problem instanceof Error && 'code' in problem && problem.code === 'PASSWORD_REQUIRED') {
        setUnlocking(true)
      } else {
        setName(name)
        setError(errorMessage(problem))
      }
    } finally {
      setBusy(false)
      onSubmitting(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.page}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps='handled'
        pointerEvents={busy ? 'none' : 'auto'}
        contentContainerStyle={styles.onboarding}
      >
        <Image source={require('../assets/icon.png')} style={styles.onboardingIcon} />
        <Text style={[styles.onboardingTitle, { color: colors.ink }]}>Pear Pen</Text>
        <Field
          label='USERNAME (enter to customize)'
          value={name}
          onChange={busy ? undefined : setName}
          colors={colors}
          placeholder={suggestedName}
          autoComplete={Platform.OS === 'android' && !hasSecret ? 'username-new' : 'username'}
          maxLength={120}
        />
        {unlocking && (
          <Field
            key={hasSecret ? 'current-password' : 'new-password'}
            label={hasSecret ? 'KEY PASSWORD' : 'CREATE PASSWORD'}
            inputRef={password.input}
            onChange={busy ? undefined : password.onChange}
            placeholder={hasSecret ? 'Enter your key password' : 'Create a password'}
            autoComplete={hasSecret ? 'current-password' : 'new-password'}
            colors={colors}
            secure
          />
        )}
        {!unlocking && (
          <Pressable
            accessibilityRole='button'
            accessibilityState={{ expanded: importing }}
            disabled={busy}
            onPress={toggleImport}
            style={styles.importToggle}
          >
            <Text style={[styles.importText, { color: colors.muted }]}>Import keys (optional)</Text>
            <Icon name={importing ? 'chevron-up' : 'chevron-down'} color={colors.muted} size={15} />
          </Pressable>
        )}
        {!unlocking && importing && (
          <>
            <View style={styles.labelRow}>
              <Text style={[styles.fieldLabel, { color: colors.muted }]}>
                PUBLIC KEY · OPTIONAL
              </Text>
              <Pressable
                accessibilityLabel='Import public key file'
                disabled={busy}
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
              autoComplete='off'
              editable={!busy}
              mono
              multiline
            />
            <View style={styles.labelRow}>
              <Text style={[styles.fieldLabel, { color: colors.muted }]}>
                PRIVATE KEY · OPTIONAL
              </Text>
              <Pressable
                accessibilityLabel='Import private key file'
                disabled={busy}
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
              autoComplete='off'
              editable={!busy}
              secure
              mono
            />
          </>
        )}
        {generating && (
          <Text style={[styles.onboardingHint, { color: colors.ink }]}>
            After setup, export your keys from Settings and keep a backup. Your password alone can’t
            recover a lost private key.
          </Text>
        )}
        {!!error && (
          <Text accessibilityLiveRegion='polite' style={[styles.error, { color: colors.danger }]}>
            {error}
          </Text>
        )}
        <Action
          title='Continue'
          onPress={() => void submit()}
          colors={colors}
          busy={busy}
          disabled={unlocking && !password.filled}
        />
        {unlocking && (
          <Action
            title='Back'
            secondary
            colors={colors}
            disabled={busy}
            onPress={() => {
              password.clear()
              setError('')
              setUnlocking(false)
            }}
          />
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  )
}
