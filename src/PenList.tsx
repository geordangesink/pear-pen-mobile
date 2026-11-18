import { Pressable, ScrollView, Text, View } from 'react-native'
import type { Pen, State } from './client'
import { Icon, type Palette } from './ui'
import { styles } from './styles'

export default function PenList({
  state,
  colors,
  onOpen,
  onAdd
}: {
  state: State
  colors: Palette
  onOpen: (pen: Pen) => void
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
            <Pressable
              accessibilityRole='button'
              key={pen.id}
              onPress={() => onOpen(pen)}
              style={({ pressed }) => [
                styles.penRow,
                { opacity: pressed ? 0.6 : 1, borderBottomColor: colors.line }
              ]}
            >
              <View style={[styles.penAvatar, { backgroundColor: colors.soft }]}>
                <Icon name='pencil-outline' color={colors.success} size={25} />
              </View>
              <View style={styles.penInfo}>
                <View style={styles.row}>
                  <Text numberOfLines={1} style={[styles.penTitle, { color: colors.ink }]}>
                    {pen.name}
                  </Text>
                  {pen.request && (
                    <View style={[styles.dot, { backgroundColor: colors.success }]} />
                  )}
                </View>
                <Text numberOfLines={1} style={[styles.small, { color: colors.muted }]}>
                  {pen.request
                    ? `${pen.request.signatures.length}/${pen.request.quorum || pen.quorum} signatures · Request open`
                    : pen.activity.at(-1)?.text || 'No open request'}
                </Text>
                {pen.quorumMismatch && state.settings.mode === 'manual' && (
                  <Text style={[styles.quorumNote, { color: colors.muted }]}>
                    Drive quorum is {pen.quorum} (entered {pen.configuredQuorum}).
                  </Text>
                )}
              </View>
              <Icon name='chevron-forward' color={colors.muted} size={17} />
            </Pressable>
          ))
        ) : (
          <View style={styles.empty}>
            <View style={[styles.emptyMark, { backgroundColor: colors.soft }]}>
              <Icon name='pencil-outline' color={colors.success} size={34} />
            </View>
            <Text style={[styles.emptyTitle, { color: colors.ink }]}>No pens yet</Text>
            <Text style={[styles.body, styles.centerText, { color: colors.muted }]}>
              Add a multisig drive to start signing.
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
