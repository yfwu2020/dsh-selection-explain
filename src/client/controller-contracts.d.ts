/** Typed ports at controller boundaries. Runtime wiring stays lazy to avoid stale state. */
export type ClientView = ReturnType<typeof import('./view.js').createClientView>
export type ClientState = ReturnType<typeof import('./state.js').createClientState> & {
  contextState?: import('../chat-context.js').ContextState | null
  shotScope?: string
  shotFrame?: boolean
  shotTitle?: string
  uploadingAttachments?: boolean
}
export interface ClientHost {
  /** Host services have version-dependent shapes and are narrowed by their consumers. */
  get(name: string): any
  [service: string]: any
}

export interface SettingsEnv {
  preferences: ReturnType<typeof import('./constants.js').createPreferences>
  state: ClientState
  modelCatalog: ReturnType<typeof import('./models.js').createModelsController>['modelCatalog']
  paintModelPill: ReturnType<typeof import('./models.js').createModelsController>['paintModelPill']
  panelSessionId: string
  currentSessionId: ReturnType<typeof import('./panel.js').createPanelController>['currentSessionId']
  loadModelCatalog: ReturnType<typeof import('./models.js').createModelsController>['loadModelCatalog']
  settingsSheet: ClientView['settingsSheet']
  modelMenu: ClientView['modelMenu']
  renderModelMenu: ReturnType<typeof import('./models.js').createModelsController>['renderModelMenu']
  catalogItemOf: ReturnType<typeof import('./models.js').createModelsController>['catalogItemOf']
  settingsNote: ClientView['settingsNote']
  settingsNoteText: ClientView['settingsNoteText']
  bridgeOn: ReturnType<typeof import('./preview.js').createPreviewController>['bridgeOn']
  scheduleBridgeScan: ReturnType<typeof import('./preview.js').createPreviewController>['scheduleBridgeScan']
  settingsRail: ClientView['settingsRail']
  settingsBody: ClientView['settingsBody']
  pillHidden: boolean
  pill: ClientView['pill']
  placePill: ReturnType<typeof import('./pill.js').createPillController>['placePill']
  pillIdleId: number
  schedulePillIdle: ReturnType<typeof import('./pill.js').createPillController>['schedulePillIdle']
  panelOpen: boolean
  panel: ClientView['panel']
  settingsScrim: ClientView['settingsScrim']
  settingsButton: ClientView['settingsButton']
}

export interface SelectionEnv {
  preferences: ReturnType<typeof import('./constants.js').createPreferences>
  later: (fn: any, ms: any) => number
  layer: ClientView['layer']
  panel: ClientView['panel']
  pill: ClientView['pill']
  body: ClientView['body']
  state: ClientState
  translationSection: ClientView['translationSection']
  detailSection: ClientView['detailSection']
  hideQuoteButton: ReturnType<typeof import('./voice-card.js').createVoiceCardController>['hideQuoteButton']
  turnIndexOfNode: ReturnType<typeof import('./quotes.js').createQuotesController>['turnIndexOfNode']
  panelOpen: boolean
  button: ClientView['button']
  currentSurfaceTheme: ReturnType<typeof import('./history.js').createHistoryController>['currentSurfaceTheme']
  startMicWatch: ReturnType<typeof import('./voice-card.js').createVoiceCardController>['startMicWatch']
  vcardState: ReturnType<typeof import('./voice-card.js').createVoiceCardController>['vcardState']
  stopMicWatch: ReturnType<typeof import('./voice-card.js').createVoiceCardController>['stopMicWatch']
  quoteButton: ClientView['quoteButton']
}

export interface VoiceCardEnv {
  ensureLayer: () => void
  shotRefAsync: ReturnType<typeof import('./shot.js').createShotController>['takeRefAsync']
  shotFailed: ReturnType<typeof import('./shot.js').createShotController>['failed']
  shotNotice: ReturnType<typeof import('./shot.js').createShotController>['notice']
  clearShotMarkers: ReturnType<typeof import('./shot.js').createShotController>['clearMarkers']
  layer: ClientView['layer']
  later: (fn: any, ms: any) => number
  panelOpen: boolean
  state: ClientState
  isTypingTarget: ReturnType<typeof import('./panel.js').createPanelController>['isTypingTarget']
  button: ClientView['button']
  hideButton: ReturnType<typeof import('./selection.js').createSelectionController>['hideButton']
  settingsLive: ReturnType<typeof import('./settings.js').createSettingsController>['settingsLive']
  rangeSelection: ReturnType<typeof import('./panel.js').createPanelController>['rangeSelection']
  openPanelWith: ReturnType<typeof import('./panel.js').createPanelController>['openPanelWith']
  clearDocSelection: ReturnType<typeof import('./panel.js').createPanelController>['clearDocSelection']
  frameTouchedAt: ReturnType<typeof import('./preview.js').createPreviewController>['frameTouchedAt']
  timerScope: { readonly size: number; later(fn: any, ms: any): number; interval(fn: any, ms: any): number; clear(id: any): void; dispose(): void; }
  voice: ReturnType<typeof import('./voice.js').createVoiceController>['voice']
  addQuote: ReturnType<typeof import('./quotes.js').createQuotesController>['addQuote']
  quoteContextFor: ReturnType<typeof import('./quotes.js').createQuotesController>['quoteContextFor']
  composerVisible: ReturnType<typeof import('./panel.js').createPanelController>['composerVisible']
  focusAskBox: ReturnType<typeof import('./panel.js').createPanelController>['focusAskBox']
  quoteButton: ClientView['quoteButton']
  setQuotePop: ReturnType<typeof import('./selection.js').createSelectionController>['setQuotePop']
}

export interface QuotesEnv {
  foldForHistory: ReturnType<typeof import('./history.js').createHistoryController>['foldForHistory']
  state: ClientState
  setStatus: ReturnType<typeof import('./panel.js').createPanelController>['setStatus']
  refreshAskState: ReturnType<typeof import('./conversation.js').createConversationController>['refreshAskState']
  askRow: ClientView['askRow']
  composerVisible: ReturnType<typeof import('./panel.js').createPanelController>['composerVisible']
  focusAskBox: ReturnType<typeof import('./panel.js').createPanelController>['focusAskBox']
  quotesBox: ClientView['quotesBox']
  body: ClientView['body']
  panel: ClientView['panel']
  rangeSelection: ReturnType<typeof import('./panel.js').createPanelController>['rangeSelection']
  currentSessionId: ReturnType<typeof import('./panel.js').createPanelController>['currentSessionId']
  timerScope: { readonly size: number; later(fn: any, ms: any): number; interval(fn: any, ms: any): number; clear(id: any): void; dispose(): void; }
}

export interface PreviewEnv {
  panel: ClientView['panel']
  state: ClientState
  vcardState: ReturnType<typeof import('./voice-card.js').createVoiceCardController>['vcardState']
  hideButton: ReturnType<typeof import('./selection.js').createSelectionController>['hideButton']
  later: (fn: any, ms: any) => number
}

export interface LightboxEnv {
  layer: ClientView['layer']
}

export interface PanelEnv {
  timerScope: { readonly size: number; later(fn: any, ms: any): number; interval(fn: any, ms: any): number; clear(id: any): void; dispose(): void; }
  panelSessionId: string
  ctx: ClientHost
  cache: { readonly size: number; readonly textBytes: number; keys(): MapIterator<any>; get(key: any): any; set(key: any, value: any): any; clear(): void; dispose(): void; }
  state: ClientState
  translationSection: ClientView['translationSection']
  expandButton: ClientView['expandButton']
  hideButton: ReturnType<typeof import('./selection.js').createSelectionController>['hideButton']
  quote: ClientView['quote']
  clearQuotes: ReturnType<typeof import('./quotes.js').createQuotesController>['clearQuotes']
  clearAttachments: ReturnType<typeof import('./attach.js').createAttachController>['clear']
  renderTurns: ReturnType<typeof import('./history.js').createHistoryController>['renderTurns']
  clearRenderedTurns: ReturnType<typeof import('./history.js').createHistoryController>['clearRenderedTurns']
  clearWaiting: ReturnType<typeof import('./conversation.js').createConversationController>['clearWaiting']
  sendAsk: ReturnType<typeof import('./conversation.js').createConversationController>['sendAsk']
  restoreFromHistory: ReturnType<typeof import('./history.js').createHistoryController>['restoreFromHistory']
  runRequest: ReturnType<typeof import('./conversation.js').createConversationController>['runRequest']
  vcardHandoff: ReturnType<typeof import('./voice-card.js').createVoiceCardController>['vcardHandoff']
  panel: ClientView['panel']
  historyList: HTMLDivElement
  placeHistoryList: ReturnType<typeof import('./history.js').createHistoryController>['placeHistoryList']
  panelOpen: boolean
  autoGrowAskBox: ReturnType<typeof import('./conversation.js').createConversationController>['autoGrowAskBox']
  askFocusPending: boolean
  hideQuoteButton: ReturnType<typeof import('./voice-card.js').createVoiceCardController>['hideQuoteButton']
  paintPill: ReturnType<typeof import('./pill.js').createPillController>['paintPill']
  refreshFollowRoute: ReturnType<typeof import('./settings.js').createSettingsController>['refreshFollowRoute']
  syncRouteWatch: ReturnType<typeof import('./settings.js').createSettingsController>['syncRouteWatch']
  warmModelCatalog: ReturnType<typeof import('./models.js').createModelsController>['warmModelCatalog']
  prefersReducedMotion: ReturnType<typeof import('./voice-card.js').createVoiceCardController>['prefersReducedMotion']
  panelGrowTimer: ReturnType<typeof import('./voice-card.js').createVoiceCardController>['panelGrowTimer']
  panelGrowHandler: ReturnType<typeof import('./voice-card.js').createVoiceCardController>['panelGrowHandler']
  later: (fn: any, ms: any) => number
  closeModelMenu: ReturnType<typeof import('./models.js').createModelsController>['closeModelMenu']
  closeSettings: ReturnType<typeof import('./settings.js').createSettingsController>['closeSettings']
  closeLightbox: ReturnType<typeof import('./lightbox.js').createLightboxController>['close']
  hideHistoryList: ReturnType<typeof import('./history.js').createHistoryController>['hideHistoryList']
  cancelVoice: ReturnType<typeof import('./voice.js').createVoiceController>['cancelVoice']
  visibleRaw: ReturnType<typeof import('./history.js').createHistoryController>['visibleRaw']
  showWaiting: ReturnType<typeof import('./conversation.js').createConversationController>['showWaiting']
  retryButton: ClientView['retryButton']
  detailSection: ClientView['detailSection']
  currentSurfaceTheme: ReturnType<typeof import('./history.js').createHistoryController>['currentSurfaceTheme']
  layer: ClientView['layer']
  askRow: ClientView['askRow']
  closeButton: ClientView['closeButton']
  refreshAskState: ReturnType<typeof import('./conversation.js').createConversationController>['refreshAskState']
  focusBail: string
  askBox: ClientView['askBox']
  insidePanelContent: ReturnType<typeof import('./selection.js').createSelectionController>['insidePanelContent']
}

export interface PillEnv {
  interaction: { pillPollDelay: number; pillHidden: boolean; pillDock: string; pillFreeRight: any; pillBall: boolean; pillHover: boolean; pillDrag: any; pillDragMoved: boolean; pillIdleId: number; pillSnapUntil: number; pillAnchorWidth: number; pillPlacerId: number; pillHost: any; pillWatched: any; pillObserver: any; }
  preferences: ReturnType<typeof import('./constants.js').createPreferences>
  state: ClientState
  pillName: ClientView['pillName']
  pillMeta: ClientView['pillMeta']
  pill: ClientView['pill']
  panelOpen: boolean
  pillCaret: ClientView['pillCaret']
  pillStar: ClientView['pillStar']
  later: (fn: any, ms: any) => number
  closePanel: ReturnType<typeof import('./panel.js').createPanelController>['closePanel']
  showPanel: ReturnType<typeof import('./panel.js').createPanelController>['showPanel']
  paint: ReturnType<typeof import('./panel.js').createPanelController>['paint']
  renderTurns: ReturnType<typeof import('./history.js').createHistoryController>['renderTurns']
  setStatus: ReturnType<typeof import('./panel.js').createPanelController>['setStatus']
  loadHistoryEntry: ReturnType<typeof import('./history.js').createHistoryController>['loadHistoryEntry']
}

export interface HistoryEnv {
  panelSessionId: any
  applyShotTitle: ReturnType<typeof import('./panel.js').createPanelController>['applyShotTitle']
  sentTextOf: ReturnType<typeof import('./quotes.js').createQuotesController>['sentTextOf']
  panel: ClientView['panel']
  previewImage: ReturnType<typeof import('./lightbox.js').createLightboxController>['open']
  state: ClientState
  exportTurns: ReturnType<typeof import('./quotes.js').createQuotesController>['exportTurns']
  clearQuotes: ReturnType<typeof import('./quotes.js').createQuotesController>['clearQuotes']
  buildPayload: ReturnType<typeof import('./panel.js').createPanelController>['buildPayload']
  askFocusAfterTurn: ReturnType<typeof import('./panel.js').createPanelController>['askFocusAfterTurn']
  quote: ClientView['quote']
  applySectionTitle: ReturnType<typeof import('./panel.js').createPanelController>['applySectionTitle']
  paint: ReturnType<typeof import('./panel.js').createPanelController>['paint']
  paintPill: ReturnType<typeof import('./pill.js').createPillController>['paintPill']
  timerScope: { readonly size: number; later(fn: any, ms: any): number; interval(fn: any, ms: any): number; clear(id: any): void; dispose(): void; }
  panelOpen: boolean
  historyList: HTMLDivElement
  historyButton: ClientView['historyButton']
  panelLayoutRect: ReturnType<typeof import('./panel.js').createPanelController>['panelLayoutRect']
  setStatus: ReturnType<typeof import('./panel.js').createPanelController>['setStatus']
  showPanel: ReturnType<typeof import('./panel.js').createPanelController>['showPanel']
  rectOfPill: ReturnType<typeof import('./pill.js').createPillController>['rectOfPill']
  refreshFollowRoute: ReturnType<typeof import('./settings.js').createSettingsController>['refreshFollowRoute']
  syncRouteWatch: ReturnType<typeof import('./settings.js').createSettingsController>['syncRouteWatch']
  warmModelCatalog: ReturnType<typeof import('./models.js').createModelsController>['warmModelCatalog']
  progressText: ReturnType<typeof import('./panel.js').createPanelController>['progressText']
  body: ClientView['body']
  chatLog: ClientView['chatLog']
  panelInteracting: ReturnType<typeof import('./panel.js').createPanelController>['panelInteracting']
  clampPanelPosition: ReturnType<typeof import('./panel.js').createPanelController>['clampPanelPosition']
  clearWaiting: ReturnType<typeof import('./conversation.js').createConversationController>['clearWaiting']
  showWaiting: ReturnType<typeof import('./conversation.js').createConversationController>['showWaiting']
  quoteLabelOf: ReturnType<typeof import('./quotes.js').createQuotesController>['quoteLabelOf']
  quoteBrief: ReturnType<typeof import('./quotes.js').createQuotesController>['quoteBrief']
  addQuote: ReturnType<typeof import('./quotes.js').createQuotesController>['addQuote']
  turnLabelOf: ReturnType<typeof import('./selection.js').createSelectionController>['turnLabelOf']
}

export interface ConversationEnv {
  state: ClientState
  askBox: ClientView['askBox']
  keepInsideViewport: ReturnType<typeof import('./panel.js').createPanelController>['keepInsideViewport']
  askSend: ClientView['askSend']
  setStatus: ReturnType<typeof import('./panel.js').createPanelController>['setStatus']
  voice: ReturnType<typeof import('./voice.js').createVoiceController>['voice']
  cancelVoice: ReturnType<typeof import('./voice.js').createVoiceController>['cancelVoice']
  renderQuotes: ReturnType<typeof import('./quotes.js').createQuotesController>['renderQuotes']
  resolveQuoteContexts: ReturnType<typeof import('./quotes.js').createQuotesController>['resolveQuoteContexts']
  composeQuestion: ReturnType<typeof import('./quotes.js').createQuotesController>['composeQuestion']
  attachEnsureUploaded: ReturnType<typeof import('./attach.js').createAttachController>['ensureUploaded']
  attachmentsPayload: ReturnType<typeof import('./attach.js').createAttachController>['payload']
  attachmentsBusy: ReturnType<typeof import('./attach.js').createAttachController>['busy']
  attachmentsDescribe: ReturnType<typeof import('./attach.js').createAttachController>['describe']
  clearAttachments: ReturnType<typeof import('./attach.js').createAttachController>['clear']
  seedHistoryFromExplanation: ReturnType<typeof import('./history.js').createHistoryController>['seedHistoryFromExplanation']
  syncPanelStage: ReturnType<typeof import('./panel.js').createPanelController>['syncPanelStage']
  syncExpandCta: ReturnType<typeof import('./panel.js').createPanelController>['syncExpandCta']
  ensureChatFollow: ReturnType<typeof import('./history.js').createHistoryController>['ensureChatFollow']
  renderTurns: ReturnType<typeof import('./history.js').createHistoryController>['renderTurns']
  paintPill: ReturnType<typeof import('./pill.js').createPillController>['paintPill']
  timerScope: { readonly size: number; later(fn: any, ms: any): number; interval(fn: any, ms: any): number; clear(id: any): void; dispose(): void; }
  clearTransientNotice: ReturnType<typeof import('./history.js').createHistoryController>['clearTransientNotice']
  chatLog: ClientView['chatLog']
  saveHistory: ReturnType<typeof import('./history.js').createHistoryController>['saveHistory']
  askFocusAfterTurn: ReturnType<typeof import('./panel.js').createPanelController>['askFocusAfterTurn']
  panelOrCurrentSessionId: ReturnType<typeof import('./panel.js').createPanelController>['panelOrCurrentSessionId']
  currentSurfaceTheme: ReturnType<typeof import('./history.js').createHistoryController>['currentSurfaceTheme']
  applyToolEvent: ReturnType<typeof import('./history.js').createHistoryController>['applyToolEvent']
  rememberBadTier: ReturnType<typeof import('./models.js').createModelsController>['rememberBadTier']
  paintModelPill: ReturnType<typeof import('./models.js').createModelsController>['paintModelPill']
  turnsRenderPending: boolean
  lastTurnsRenderAt: number
  STREAM_RENDER_MS: number
  later: (fn: any, ms: any) => number
  waitList: any[]
  paint: ReturnType<typeof import('./panel.js').createPanelController>['paint']
  progressText: ReturnType<typeof import('./panel.js').createPanelController>['progressText']
  visibleRaw: ReturnType<typeof import('./history.js').createHistoryController>['visibleRaw']
  cache: { readonly size: number; readonly textBytes: number; keys(): MapIterator<any>; get(key: any): any; set(key: any, value: any): any; clear(): void; dispose(): void; }
  rafPending: boolean
  ensurePanelInsideViewportNow: ReturnType<typeof import('./history.js').createHistoryController>['ensurePanelInsideViewportNow']
  promoteButton: ClientView['promoteButton']
  exportTurns: ReturnType<typeof import('./quotes.js').createQuotesController>['exportTurns']
  closePanel: ReturnType<typeof import('./panel.js').createPanelController>['closePanel']
  ctx: ClientHost
  buildPayload: ReturnType<typeof import('./panel.js').createPanelController>['buildPayload']
}

export interface AttachEnv {
  state: ClientState
  panel: ClientView['panel']
  attachBox: ClientView['attachBox']
  attachNote: ClientView['attachNote']
  attachInput: ClientView['attachInput']
  previewImage: ReturnType<typeof import('./lightbox.js').createLightboxController>['open']
  setStatus: ReturnType<typeof import('./panel.js').createPanelController>['setStatus']
  refreshAskState: ReturnType<typeof import('./conversation.js').createConversationController>['refreshAskState']
}

export interface ShotEnv {
  document: Document
  window: Window & typeof globalThis
  layer: ClientView['layer']
  state: ClientState
  panelOpen: boolean
  addFiles: ReturnType<typeof import('./attach.js').createAttachController>['addFiles']
  focusAskBox: ReturnType<typeof import('./panel.js').createPanelController>['focusAskBox']
  openVCard: ReturnType<typeof import('./voice-card.js').createVoiceCardController>['openVCard']
  vcardOpen: () => boolean
  vcardElement: () => any
  closeVCard: ReturnType<typeof import('./voice-card.js').createVoiceCardController>['closeVCard']
  ensureLayer: () => void
}

export interface ModelsEnv {
  state: ClientState
  modelPillName: ClientView['modelPillName']
  modelPillTier: ClientView['modelPillTier']
  modelPill: ClientView['modelPill']
  paintEffortMapHint: ReturnType<typeof import('./settings.js').createSettingsController>['paintEffortMapHint']
  panelSessionId: string
  currentSessionId: ReturnType<typeof import('./panel.js').createPanelController>['currentSessionId']
  panelOrCurrentSessionId: ReturnType<typeof import('./panel.js').createPanelController>['panelOrCurrentSessionId']
  modelMenu: ClientView['modelMenu']
  chooseSharedModel: ReturnType<typeof import('./settings.js').createSettingsController>['chooseSharedModel']
  setStatus: ReturnType<typeof import('./panel.js').createPanelController>['setStatus']
  chatSlot: ReturnType<typeof import('./settings.js').createSettingsController>['chatSlot']
  SLOT_ORDER: ReturnType<typeof import('./settings.js').createSettingsController>['SLOT_ORDER']
  SLOT_LABEL: ReturnType<typeof import('./settings.js').createSettingsController>['SLOT_LABEL']
  setChatSlot: ReturnType<typeof import('./settings.js').createSettingsController>['setChatSlot']
  webMode: ClientView['webMode']
  cellMd: ClientView['cellMd']
  cellWeb: ClientView['cellWeb']
}

export interface VoiceEnv {
  voiceActivityText: ClientView['voiceActivityText']
  voiceActivity: ClientView['voiceActivity']
  voiceDot: ClientView['voiceDot']
  voiceActionSlot: ClientView['voiceActionSlot']
  captureRow: ClientView['captureRow']
  askTools: ClientView['askTools']
  webMode: ClientView['webMode']
  askSpacer: ClientView['askSpacer']
  modelPill: ClientView['modelPill']
  micButton: ClientView['micButton']
  waveSvg: ClientView['waveSvg']
  voiceStop: ClientView['voiceStop']
  voiceCancel: ClientView['voiceCancel']
  waveBars: ClientView['waveBars']
  focusAskBox: ReturnType<typeof import('./panel.js').createPanelController>['focusAskBox']
  askBox: ClientView['askBox']
  refreshAskState: ReturnType<typeof import('./conversation.js').createConversationController>['refreshAskState']
}


export interface ClientEventsEnv {
  previewController: ReturnType<typeof import('./preview.js').createPreviewController>
  state: ClientState
  selectionController: ReturnType<typeof import('./selection.js').createSelectionController>
  voiceCardController: ReturnType<typeof import('./voice-card.js').createVoiceCardController>
  preferences: ReturnType<typeof import('./constants.js').createPreferences>
  runtime: ReturnType<typeof import('./state.js').createPanelRuntime>
  button: HTMLButtonElement
  quoteButton: HTMLButtonElement
  selectPressedAt: number
  selectPressing: () => boolean
  modelMenu: HTMLDivElement
  modelPill: HTMLButtonElement
  modelsController: ReturnType<typeof import('./models.js').createModelsController>
  historyList: HTMLDivElement
  historyButton: HTMLButtonElement
  pill: HTMLDivElement
  historyController: ReturnType<typeof import('./history.js').createHistoryController>
  panel: HTMLDivElement
  panelController: ReturnType<typeof import('./panel.js').createPanelController>
  quotesController: ReturnType<typeof import('./quotes.js').createQuotesController>
  cellMd: HTMLButtonElement
  cellWeb: HTMLButtonElement
  prefSeg: HTMLSpanElement
  pillController: ReturnType<typeof import('./pill.js').createPillController>
  pillState: ReturnType<typeof import('./state.js').createPillState>
  conversationController: ReturnType<typeof import('./conversation.js').createConversationController>
  PILL_POLL_MIN: number
  captureRow: HTMLDivElement
  settingsController: ReturnType<typeof import('./settings.js').createSettingsController>
  voiceController: ReturnType<typeof import('./voice.js').createVoiceController>
  settingsButton: HTMLButtonElement
  settingsBack: HTMLButtonElement
  settingsClose: HTMLButtonElement
  settingsReset: HTMLButtonElement
  settingsSheet: HTMLDivElement
  settingsScrim: HTMLDivElement
  promoteButton: HTMLButtonElement
  retryButton: HTMLButtonElement
  expandButton: HTMLButtonElement
  askBox: HTMLTextAreaElement
  askSend: HTMLButtonElement
  attachInput: HTMLInputElement
  attachController: ReturnType<typeof import('./attach.js').createAttachController>
  addButton: HTMLButtonElement
  micButton: HTMLButtonElement
  voiceCancel: HTMLButtonElement
  voiceStop: HTMLButtonElement
  body: HTMLDivElement
  closeButton: HTMLButtonElement
  head: HTMLDivElement
}

export interface ClientAssemblyEnv {
  preferences: ReturnType<typeof import('./constants.js').createPreferences>
  state: ClientState
  runtime: ReturnType<typeof import('./state.js').createPanelRuntime>
  settingsSheet: HTMLDivElement
  modelMenu: HTMLDivElement
  settingsNote: HTMLSpanElement
  settingsNoteText: HTMLSpanElement
  settingsRail: HTMLDivElement
  settingsBody: HTMLDivElement
  pillState: ReturnType<typeof import('./state.js').createPillState>
  pill: HTMLDivElement
  panel: HTMLDivElement
  settingsScrim: HTMLDivElement
  settingsButton: HTMLButtonElement
  later: (fn: any, ms: any) => number
  layer: HTMLDivElement
  body: HTMLDivElement
  translationSection: { root: HTMLDivElement; content: HTMLDivElement; hint: HTMLSpanElement; title: HTMLSpanElement; }
  detailSection: { root: HTMLDivElement; content: HTMLDivElement; hint: HTMLSpanElement; title: HTMLSpanElement; }
  button: HTMLButtonElement
  quoteButton: HTMLButtonElement
  ensureLayer: () => void
  timerScope: { readonly size: number; later(fn: any, ms: any): number; interval(fn: any, ms: any): number; clear(id: any): void; dispose(): void; }
  askRow: HTMLDivElement
  quotesBox: HTMLDivElement
  ctx: ClientHost
  cache: { readonly size: number; readonly textBytes: number; keys(): MapIterator<any>; get(key: any): any; set(key: any, value: any): any; clear(): void; dispose(): void; }
  expandButton: HTMLButtonElement
  quote: HTMLDivElement
  historyList: HTMLDivElement
  retryButton: HTMLButtonElement
  closeButton: HTMLButtonElement
  askBox: HTMLTextAreaElement
  pillName: HTMLSpanElement
  pillMeta: HTMLSpanElement
  pillCaret: HTMLSpanElement
  pillStar: SVGPathElement
  historyButton: HTMLButtonElement
  chatLog: HTMLDivElement
  askSend: HTMLButtonElement
  turnsRenderPending: boolean
  lastTurnsRenderAt: number
  STREAM_RENDER_MS: number
  waitList: any[]
  rafPending: boolean
  promoteButton: HTMLButtonElement
  attachBox: HTMLDivElement
  attachNote: HTMLParagraphElement
  attachInput: HTMLInputElement
  modelPillName: HTMLSpanElement
  modelPillTier: HTMLSpanElement
  modelPill: HTMLButtonElement
  webMode: HTMLSpanElement
  cellMd: HTMLButtonElement
  cellWeb: HTMLButtonElement
  voiceActivityText: HTMLSpanElement
  voiceActivity: HTMLSpanElement
  voiceDot: HTMLSpanElement
  voiceActionSlot: HTMLSpanElement
  captureRow: HTMLDivElement
  askTools: HTMLDivElement
  askSpacer: HTMLSpanElement
  micButton: HTMLButtonElement
  waveSvg: SVGSVGElement
  voiceStop: HTMLButtonElement
  voiceCancel: HTMLButtonElement
  waveBars: { node: SVGLineElement; level: number; }[]
}
