import { Pressable, ScrollView, Text, View } from 'react-native'
import { knownQuorum, type Pen, type State } from './client'
import PenAvatar from './PenAvatar'
import { Icon, type Palette } from './ui'
import { styles } from './styles'

function penSummary(pen: Pen) {
  if (!pen.request) return pen.activity.at(-1)?.text || 'No open request'
  const quorum = knownQuorum(pen)
  return quorum > 0
    ? `${pen.request.signatures.length}/${quorum} signatures · Request open`
    : 'Request open'
}

export default function PenList({
  state,
  colors,
  onOpen,
  onDetails,
  onAdd
}: {
  state: State
  colors: Palette
  onOpen: (pen: Pen) => void
  onDetails: (pen: Pen) => void
  onAdd: () => void
}) {
  return (
    <>
      <View style={styles.listHeading}>
        <Text style={[styles.eyebrow, { color: colors.muted }]}>YOUR PENS</Text>
        <Text style={[styles.small, { color: colors.muted }]}>{state.pens.length || ''}</Text>
      </View>
      <ScrollView contentContainerStyle={state.pens.length ? styles.list : styles.emptyScroll}>
        {state.pens.length ? (
          state.pens.map((pen) => (
            <View key={pen.id} style={[styles.penRow, { borderBottomColor: colors.line }]}>
              <Pressable
                accessibilityRole='button'
                accessibilityLabel={`Open ${pen.name}`}
                onPress={() => onOpen(pen)}
                style={({ pressed }) => [styles.penOpen, { opacity: pressed ? 0.6 : 1 }]}
              >
                <PenAvatar image={pen.image} colors={colors} />
                <View style={styles.penInfo}>
                  <Text numberOfLines={1} style={[styles.penTitle, { color: colors.ink }]}>
                    {pen.name}
                  </Text>
                  <Text numberOfLines={1} style={[styles.small, { color: colors.muted }]}>
                    {penSummary(pen)}
                  </Text>
                  {pen.quorumMismatch && state.settings.mode === 'manual' && (
                    <Text style={[styles.quorumNote, { color: colors.muted }]}>
                      Drive quorum is {pen.quorum} (entered {pen.configuredQuorum}).
                    </Text>
                  )}
                </View>
              </Pressable>
              <Pressable
                accessibilityRole='button'
                accessibilityLabel={`Details for ${pen.name}`}
                onPress={() => onDetails(pen)}
                hitSlop={2}
                style={styles.iconButton}
              >
                <Icon name='information-circle-outline' color={colors.muted} size={22} />
              </Pressable>
            </View>
          ))
        ) : (
          <View style={styles.empty}>
            <View style={[styles.emptyMark, { backgroundColor: colors.soft }]}>
              <Icon name='pencil-outline' color={colors.success} size={34} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.ink }]}>No pens yet</Text>
            <Text style={[styles.body, styles.centerText, { color: colors.muted }]}>
              Create or join a private signing room.
            </Text>
          </View>
        )}
      </ScrollView>
      <View style={styles.homeFooter}>
        <Pressable
          accessibilityLabel='Add pen'
          onPress={onAdd}
          style={({ pressed }) => [
            styles.addButton,
            { backgroundColor: colors.accent, opacity: pressed ? 0.7 : 1 }
          ]}
        >
          <Icon name='add' color={colors.accentInk} size={30} />
        </Pressable>
        <Text style={[styles.footerNote, { color: colors.muted }]}>MULTISIG SIGNING</Text>
      </View>
    </>
  )
}
