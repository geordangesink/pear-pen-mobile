import { useRef } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'
import { knownQuorum, type Pen, type SignatureVerification, type State } from './client'
import { Action, Icon, type Palette } from './ui'
import { styles } from './styles'

const shortKey = (key: string) => `${key.slice(0, 8)}…${key.slice(-6)}`

export default function Detail({
  pen,
  state,
  colors,
  onRequest,
  onSign,
  onVerify,
  verifyingId,
  onReview,
  onCommit,
  onCopyResponse,
  onSubmitResponse,
  onOutput
}: {
  pen: Pen
  state: State
  colors: Palette
  onRequest: () => void
  onSign: () => void
  onVerify: (entryId: string, signature: SignatureVerification) => void
  verifyingId: string | null
  onReview: () => void
  onCommit: () => void
  onCopyResponse: (requestId: string) => void
  onSubmitResponse: () => void
  onOutput: (text: string, title: string) => void
}) {
  const scroll = useRef<ScrollView>(null)
  const atBottom = useRef(true)
  const request = pen.request
  const count = request?.signatures.length || 0
  const quorum = knownQuorum(pen)
  const reached = !!request && quorum > 0 && count >= quorum
  const signed = request?.signatures.includes(state.profile!.publicKey)
  const creator = request?.creator === state.profile!.publicKey

  function activityAction(
    title: string,
    icon: 'copy-outline' | 'checkmark-circle-outline',
    onPress: () => void,
    disabled = false
  ) {
    return (
      <Pressable
        accessibilityRole='button'
        disabled={disabled}
        hitSlop={6}
        onPress={onPress}
        style={styles.activityCopy}
      >
        <Icon name={icon} color={colors.success} size={14} />
        <Text style={[styles.activityCopyText, { color: colors.success }]}>{title}</Text>
      </Pressable>
    )
  }

  function copyAction(kind: 'request' | 'response', payload?: string) {
    if (!payload) return null
    return activityAction(`Copy ${kind}`, 'copy-outline', () =>
      onOutput(payload, kind === 'response' ? 'Signature response' : 'Signing request')
    )
  }

  return (
    <>
      <View
        style={[styles.requestCard, { backgroundColor: colors.card, borderColor: colors.line }]}
      >
        <View style={styles.between}>
          <Text style={[styles.eyebrow, { color: colors.muted }]}>CURRENT REQUEST</Text>
          <View style={[styles.pill, { borderColor: colors.line }]}>
            <Text style={[styles.pillText, { color: request ? colors.success : colors.muted }]}>
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
        {copyAction('request', request?.request)}
        {quorum > 0 && (
          <View style={[styles.quorumRow, { borderTopColor: colors.line }]}>
            <View style={styles.signatureDots}>
              {Array.from({ length: Math.min(quorum, 7) }, (_, index) => (
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
                {count}/{quorum}
              </Text>{' '}
              signatures
            </Text>
          </View>
        )}
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
            const { response, request: originalRequest, author } = entry
            const mine = entry.author === state.profile!.publicKey
            const authorName = !entry.author
              ? 'Pear Pen'
              : mine
                ? state.profile!.name || entry.authorName || 'You'
                : entry.authorName || 'Signer'
            const sharedByName =
              entry.sharedBy === state.profile!.publicKey
                ? state.profile!.name || entry.sharedByName || 'You'
                : entry.sharedByName || 'Signer'
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
                    <View style={styles.grow}>
                      <Text
                        numberOfLines={1}
                        style={[styles.small, { color: colors.ink, fontWeight: '500' }]}
                      >
                        {authorName}
                      </Text>
                      {!!entry.author && (
                        <Text style={[styles.activityAuthor, { color: colors.muted }]}>
                          {shortKey(entry.author)}
                        </Text>
                      )}
                    </View>
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
                  {entry.localOnly && (
                    <Text style={[styles.activityAuthor, { color: colors.muted }]}>
                      Earlier · only on this device
                    </Text>
                  )}
                  {entry.sharedBy && entry.sharedBy !== entry.author && (
                    <Text style={[styles.activityAuthor, { color: colors.muted }]}>
                      Shared by {sharedByName} · {shortKey(entry.sharedBy)}
                    </Text>
                  )}
                  {(entry.response || entry.request) && (
                    <View style={styles.activityCopies}>
                      {copyAction('response', entry.response)}
                      {copyAction('request', entry.request)}
                      {response &&
                        originalRequest &&
                        author &&
                        activityAction(
                          verifyingId === entry.id ? 'Verifying…' : 'Verify',
                          'checkmark-circle-outline',
                          () =>
                            onVerify(entry.id, {
                              response,
                              request: originalRequest,
                              publicKey: author
                            }),
                          !!verifyingId
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
        ) : request && signed ? (
          <View>
            <Action
              title='Copy response'
              onPress={() => onCopyResponse(request.id)}
              colors={colors}
              secondary
            />
            <Action title='Submit peer’s response' onPress={onSubmitResponse} colors={colors} />
          </View>
        ) : (
          <Action
            title={request ? 'Sign request' : 'New request'}
            onPress={request ? onSign : onRequest}
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
