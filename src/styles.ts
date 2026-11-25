import { Platform, StyleSheet } from 'react-native'

export const styles = StyleSheet.create({
  page: { flex: 1 },
  center: { justifyContent: 'center', alignItems: 'center', padding: 30, gap: 25 },
  centerText: { textAlign: 'center' },
  grow: { flex: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  bootIcon: { width: 76, height: 76, borderRadius: 20 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 25,
    paddingTop: 15,
    paddingBottom: 31,
    gap: 12
  },
  brandIcon: { width: 43, height: 43, borderRadius: 12 },
  headerTitle: { flex: 1, gap: 3 },
  wordmark: { fontSize: 23, fontWeight: '600', letterSpacing: -0.8 },
  small: { fontSize: 12, lineHeight: 18 },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center'
  },
  listHeading: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 27,
    paddingBottom: 9
  },
  eyebrow: { fontSize: 10, fontWeight: '600', letterSpacing: 1.7 },
  list: { paddingHorizontal: 25, paddingBottom: 25 },
  penRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 21,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 14
  },
  penOpen: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 14 },
  penAvatar: {
    height: 52,
    width: 52,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center'
  },
  penInfo: { flex: 1, gap: 5 },
  penTitle: { fontSize: 17, fontWeight: '500', letterSpacing: -0.3, flexShrink: 1 },
  emptyScroll: { flexGrow: 1, justifyContent: 'center' },
  empty: { alignItems: 'center', gap: 13, marginTop: -35 },
  emptyMark: {
    width: 78,
    height: 78,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 9
  },
  emptyTitle: { fontSize: 23, fontWeight: '500', letterSpacing: -0.7 },
  body: { fontSize: 14, lineHeight: 23 },
  homeFooter: { paddingVertical: 22, alignItems: 'center', gap: 22 },
  addButton: {
    width: 65,
    height: 65,
    borderRadius: 33,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#5d763b',
    shadowOffset: { width: 0, height: 7 },
    shadowOpacity: 0.15,
    shadowRadius: 18,
    elevation: 4
  },
  footerNote: { fontSize: 8, letterSpacing: 1.6 },
  requestCard: {
    marginHorizontal: 23,
    padding: 21,
    borderRadius: 23,
    borderWidth: StyleSheet.hairlineWidth
  },
  pill: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 10,
    paddingVertical: 5
  },
  pillText: { fontSize: 9, fontWeight: '500' },
  sourceKey: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
    lineHeight: 21,
    marginTop: 21,
    marginBottom: 20
  },
  noRequest: { fontSize: 22, fontWeight: '400', letterSpacing: -0.6, marginVertical: 25 },
  quorumNote: { fontSize: 11, lineHeight: 17 },
  quorumRow: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  signatureDots: { flexDirection: 'row', gap: 5 },
  signatureDot: {
    width: 25,
    height: 25,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center'
  },
  activityHeading: {
    paddingHorizontal: 27,
    paddingTop: 28,
    paddingBottom: 15,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  activities: { paddingHorizontal: 23, paddingBottom: 25, gap: 16, flexGrow: 1 },
  activityRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, maxWidth: '94%' },
  activityMine: { alignSelf: 'flex-end' },
  activityIcon: {
    width: 29,
    height: 29,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center'
  },
  bubble: { flex: 1, borderWidth: StyleSheet.hairlineWidth, padding: 13, borderRadius: 16, gap: 7 },
  activityAuthor: { fontSize: 10, fontWeight: '500', flexShrink: 1 },
  time: { fontSize: 9 },
  activityText: { fontSize: 13, lineHeight: 20 },
  activityCopies: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 14 },
  activityCopy: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingVertical: 5
  },
  activityCopyText: { fontSize: 11, fontWeight: '500' },
  quiet: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 14, paddingVertical: 40 },
  detailFooter: {
    paddingHorizontal: 25,
    paddingTop: 17,
    paddingBottom: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 12
  },
  detailNote: { fontSize: 10, textAlign: 'center' },
  buttonPair: { flexDirection: 'row', gap: 10 },
  action: {
    minHeight: 54,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 22,
    marginTop: 8
  },
  actionText: { fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
  notice: { padding: 15, textAlign: 'center', fontSize: 12 },
  update: {
    margin: 15,
    marginTop: 0,
    padding: 13,
    borderRadius: 12,
    flexDirection: 'row',
    gap: 8,
    alignItems: 'center'
  },
  onboarding: { flexGrow: 1, padding: 30, paddingVertical: 40, justifyContent: 'center' },
  onboardingIcon: {
    width: 72,
    height: 72,
    borderRadius: 21,
    marginBottom: 20,
    alignSelf: 'center'
  },
  onboardingTitle: {
    fontSize: 32,
    fontWeight: '500',
    letterSpacing: -1,
    textAlign: 'center',
    marginBottom: 25
  },
  onboardingHint: { fontSize: 13, lineHeight: 19, marginVertical: 8 },
  importToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 7,
    paddingVertical: 20
  },
  exportLoading: { paddingVertical: 35 },
  field: { marginTop: 17, gap: 8 },
  fieldLabel: { fontSize: 9, fontWeight: '600', letterSpacing: 1.2 },
  input: {
    minHeight: 50,
    borderRadius: 13,
    paddingHorizontal: 15,
    paddingVertical: 13,
    fontSize: 14,
    borderWidth: StyleSheet.hairlineWidth
  },
  multiline: { minHeight: 84, maxHeight: 160, textAlignVertical: 'top' },
  mono: { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12 },
  labelRow: {
    marginTop: 22,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: -10
  },
  importText: { fontSize: 11, fontWeight: '500' },
  error: { fontSize: 12, lineHeight: 19, marginVertical: 14 },
  modalOverlay: { flex: 1, justifyContent: 'flex-end' },
  sheet: { maxHeight: '92%', borderTopLeftRadius: 30, borderTopRightRadius: 30, paddingBottom: 25 },
  sheetHandle: { width: 31, height: 4, borderRadius: 2, alignSelf: 'center', marginTop: 12 },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 25,
    paddingBottom: 15,
    gap: 10
  },
  sheetTitle: { fontSize: 26, fontWeight: '500', letterSpacing: -0.8, flex: 1 },
  closeButton: {
    height: 30,
    width: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 15
  },
  sheetContent: { paddingHorizontal: 25, paddingBottom: 20 },
  helpLink: { marginTop: 14, flexDirection: 'row', gap: 6, alignItems: 'center' },
  sectionLabel: {
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1.3,
    marginTop: 23,
    marginBottom: 13
  },
  nameRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingBottom: 19,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  settingsName: { fontSize: 22, fontWeight: '400', letterSpacing: -0.5 },
  segments: { flexDirection: 'row', padding: 4, borderRadius: 13, gap: 3 },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 11,
    borderRadius: 10,
    shadowColor: '#000',
    shadowRadius: 2,
    shadowOffset: { width: 0, height: 1 }
  },
  segmentText: { fontSize: 12, fontWeight: '500' },
  settingsHint: { fontSize: 12, lineHeight: 20, marginTop: 13 },
  settingsVersion: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    paddingVertical: 29
  },
  versionIcon: { width: 24, height: 24, borderRadius: 7 },
  actionsIntro: { marginBottom: 10 },
  manualAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 13,
    paddingVertical: 19,
    borderBottomWidth: StyleSheet.hairlineWidth
  },
  manualText: { flex: 1, fontSize: 16 },
  cancelGap: { marginTop: 20 },
  reviewKey: {
    padding: 16,
    borderRadius: 13,
    marginVertical: 18,
    fontSize: 12,
    lineHeight: 22,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace'
  },
  output: {
    marginVertical: 20,
    borderRadius: 15,
    padding: 17,
    borderWidth: StyleSheet.hairlineWidth
  },
  outputText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 11,
    lineHeight: 20
  },
  outputHint: { flexDirection: 'row', gap: 7, alignItems: 'center', marginTop: 20 },
  toast: {
    position: 'absolute',
    bottom: 36,
    alignSelf: 'center',
    borderRadius: 16,
    paddingHorizontal: 20,
    paddingVertical: 14,
    maxWidth: '88%',
    elevation: 10
  },
  toastText: { fontSize: 12, textAlign: 'center' }
})
