import { useRef } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import type { Pen, State } from './client'
import { Action, Icon, type Palette } from './ui'
import { styles } from './styles'

export default function Detail({
  pen,
  state,
  colors,
  onRequest,
  onSign,
  onReview,
  onCommit,
  onCopyResponse,
  onOutput
}: {
  pen: Pen
  state: State
  colors: Palette
  onRequest: () => void
  onSign: () => void
  onReview: () => void
  onCommit: () => void
  onCopyResponse: (requestId: string) => void
  onOutput: (text: string, title: string) => void
}) {
  const scroll = useRef<ScrollView>(null)
  const atBottom = useRef(true)
  const request = pen.request
  const count = request?.signatures.length || 0
  const quorum = request?.quorum || pen.quorum
  const reached = !!request && count >= quorum
  const signed = request?.signatures.includes(state.profile!.publicKey)
  const creator = request?.creator === state.profile!.publicKey
  return (
    <>
      <View
        style={[styles.requestCard, { backgroundColor: colors.card, borderColor: colors.line }]}
      >
        <View style={styles.between}>
          <Text style={[styles.eyebrow, { color: colors.muted }]}>CURRENT REQUEST</Text>
          <View style={[styles.pill, { backgroundColor: colors.soft }]}>
            <View
              style={[styles.tinyDot, { backgroundColor: request ? colors.success : colors.muted }]}
            />
            <Text style={[styles.pillText, { color: colors.success }]}>
              {reached ? 'Ready to commit' : request ? 'Collecting signatures' : 'Idle'}
            </Text>
          </View>
        </View>
        {request ? (
          <Text selectable style={[styles.sourceKey, { color: colors.ink }]}>
            {request.srcKey}
          </Text>
        ) : (
          <Text style={[styles.noRequest, { color: colors.ink }]}>No open request</Text>
        )}
        <View style={[styles.quorumRow, { borderTopColor: colors.line }]}>
          <View style={styles.signatureDots}>
            {Array.from({ length: Math.min(quorum || 3, 7) }, (_, index) => (
              <View
                key={index}
                style={[
                  styles.signatureDot,
                  { backgroundColor: index < count ? colors.accent : colors.soft }
                ]}
              >
                {index < count && <Icon name='checkmark' color={colors.accentInk} size={15} />}
              </View>
            ))}
          </View>
          <Text style={[styles.small, { color: colors.muted }]}>
            <Text style={{ color: colors.ink, fontWeight: '600' }}>
              {count}/{quorum || '—'}
            </Text>{' '}
            signatures
          </Text>
        </View>
        {pen.quorumMismatch && (
          <Text style={[styles.quorumNote, { color: colors.muted, marginTop: 12 }]}>
            Drive quorum is {pen.quorum} (entered {pen.configuredQuorum}).
          </Text>
        )}
      </View>
      <View style={styles.activityHeading}>
        <Text style={[styles.eyebrow, { color: colors.muted }]}>ACTIVITY</Text>
        <Pressable accessibilityLabel='Create a new request' onPress={onRequest} hitSlop={8}>
          <Icon name='add' color={colors.muted} size={19} />
        </Pressable>
      </View>
      <ScrollView
        ref={scroll}
        contentContainerStyle={styles.activities}
        onContentSizeChange={() => {
          if (atBottom.current) scroll.current?.scrollToEnd({ animated: false })
        }}
        onScroll={({ nativeEvent }) => {
          atBottom.current =
            nativeEvent.contentOffset.y + nativeEvent.layoutMeasurement.height >=
            nativeEvent.contentSize.height - 60
        }}
        scrollEventThrottle={100}
      >
        {pen.activity.length ? (
          pen.activity.map((entry) => {
            const mine = entry.author === state.profile!.publicKey
            return (
              <View key={entry.id} style={[styles.activityRow, mine && styles.activityMine]}>
                <View style={[styles.activityIcon, { backgroundColor: colors.soft }]}>
                  <Icon
                    name={
                      entry.type.includes('commit')
                        ? 'checkmark-done-outline'
                        : entry.type.includes('sign') || entry.type.includes('response')
                          ? 'pencil-outline'
                          : 'document-text-outline'
                    }
                    color={colors.success}
                    size={16}
                  />
                </View>
                <View
                  style={[
                    styles.bubble,
                    { backgroundColor: mine ? colors.soft : colors.card, borderColor: colors.line }
                  ]}
                >
                  <View style={styles.between}>
                    <Text
                      numberOfLines={1}
                      style={[styles.activityAuthor, { color: colors.muted }]}
                    >
                      {mine ? 'You' : entry.author ? `${entry.author.slice(0, 8)}…` : 'Pear Pen'}
                    </Text>
                    <Text style={[styles.time, { color: colors.muted }]}>
                      {new Date(entry.at).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit'
                      })}
                    </Text>
                  </View>
                  <Text selectable style={[styles.activityText, { color: colors.ink }]}>
                    {entry.text}
                  </Text>
                  {entry.sharedBy && entry.sharedBy !== entry.author && (
                    <Text style={[styles.time, { color: colors.muted }]}>
                      Shared by{' '}
                      {entry.sharedBy === state.profile!.publicKey
                        ? 'you'
                        : `${entry.sharedBy.slice(0, 8)}…`}
                    </Text>
                  )}
                  {(entry.response || entry.request) && (
                    <View style={styles.activityCopies}>
                      {(
                        [
                          ['response', entry.response],
                          ['request', entry.request]
                        ] as const
                      ).map(
                        ([kind, payload]) =>
                          payload && (
                            <Pressable
                              key={kind}
                              accessibilityRole='button'
                              hitSlop={6}
                              onPress={() =>
                                onOutput(
                                  payload,
                                  kind === 'response' ? 'Signature response' : 'Signing request'
                                )
                              }
                              style={styles.activityCopy}
                            >
                              <Icon name='copy-outline' color={colors.success} size={14} />
                              <Text style={[styles.activityCopyText, { color: colors.success }]}>
                                {kind === 'response' ? 'Copy response' : 'Copy request'}
                              </Text>
                            </Pressable>
                          )
                      )}
                    </View>
                  )}
                </View>
              </View>
            )
          })
        ) : (
          <View style={styles.quiet}>
            <Icon name='leaf-outline' color={colors.muted} size={22} />
            <Text style={[styles.body, styles.centerText, { color: colors.muted }]}>
              No activity yet.
            </Text>
          </View>
        )}
      </ScrollView>
      <View style={[styles.detailFooter, { borderTopColor: colors.line }]}>
        {reached ? (
          <View style={styles.buttonPair}>
            <View style={styles.grow}>
              <Action title='Review' onPress={onReview} colors={colors} secondary={creator} />
            </View>
            {creator && (
              <View style={styles.grow}>
                <Action title='Commit' onPress={onCommit} colors={colors} />
              </View>
            )}
          </View>
        ) : (
          <Action
            title={!request ? 'New request' : signed ? 'Copy response' : 'Sign request'}
            onPress={!request ? onRequest : signed ? () => onCopyResponse(request.id) : onSign}
            colors={colors}
          />
        )}
        <Text style={[styles.detailNote, { color: colors.muted }]}>
          {request ? 'Signatures sync with connected peers.' : 'Create a request to begin.'}
        </Text>
      </View>
    </>
  )
}
