import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native'
import { Ionicons } from '@expo/vector-icons'
import { styles } from './styles'

type IconName = React.ComponentProps<typeof Ionicons>['name']

export type Palette = typeof light

export const light = {
  background: '#f8f9f5',
  card: '#ffffff',
  ink: '#1b251c',
  muted: '#7a8479',
  line: '#e5e9e1',
  soft: '#eef1e9',
  accent: '#d5ee87',
  accentInk: '#293c19',
  overlay: 'rgba(16,25,16,0.28)',
  danger: '#b64a43',
  success: '#527735'
}

export const dark: Palette = {
  background: '#111611',
  card: '#1b221b',
  ink: '#f0f4ea',
  muted: '#98a391',
  line: '#2e382b',
  soft: '#232d21',
  accent: '#d5ee87',
  accentInk: '#293c19',
  overlay: 'rgba(0,0,0,0.64)',
  danger: '#ed9990',
  success: '#b7d784'
}

export function Icon({ name, color, size = 22 }: { name: IconName; color: string; size?: number }) {
  return <Ionicons name={name} size={size} color={color} />
}

export function Action({
  title,
  onPress,
  colors,
  secondary = false,
  disabled = false,
  busy = false
}: {
  title: string
  onPress: () => void
  colors: Palette
  secondary?: boolean
  disabled?: boolean
  busy?: boolean
}) {
  return (
    <Pressable
      accessibilityRole='button'
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        {
          backgroundColor: secondary ? colors.soft : colors.accent,
          opacity: disabled ? 0.45 : pressed ? 0.7 : 1
        }
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.accentInk} />
      ) : (
        <Text style={[styles.actionText, { color: secondary ? colors.ink : colors.accentInk }]}>
          {title}
        </Text>
      )}
    </Pressable>
  )
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  colors,
  secure = false,
  multiline = false,
  mono = false,
  numeric = false
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  colors: Palette
  secure?: boolean
  multiline?: boolean
  mono?: boolean
  numeric?: boolean
}) {
  return (
    <View style={styles.field}>
      <Text style={[styles.fieldLabel, { color: colors.muted }]}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        autoCapitalize='none'
        autoCorrect={false}
        keyboardType={numeric ? 'number-pad' : undefined}
        inputMode={numeric ? 'numeric' : undefined}
        secureTextEntry={secure}
        multiline={multiline}
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.muted}
        selectionColor={colors.success}
        style={[
          styles.input,
          { backgroundColor: colors.soft, color: colors.ink, borderColor: colors.line },
          multiline && styles.multiline,
          mono && styles.mono
        ]}
      />
    </View>
  )
}

export function Segments({
  items,
  value,
  onChange,
  colors
}: {
  items: string[]
  value: string
  onChange: (value: string) => void
  colors: Palette
}) {
  return (
    <View style={[styles.segments, { backgroundColor: colors.soft }]}>
      {items.map((item) => (
        <Pressable
          key={item}
          accessibilityRole='button'
          accessibilityState={{ selected: item === value }}
          onPress={() => onChange(item)}
          style={[
            styles.segment,
            item === value && { backgroundColor: colors.card, shadowOpacity: 0.06 }
          ]}
        >
          <Text style={[styles.segmentText, { color: item === value ? colors.ink : colors.muted }]}>
            {item[0].toUpperCase() + item.slice(1)}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}
