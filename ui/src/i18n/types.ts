/**
 * i18n Type Definitions — Shared translation key structure
 */

export interface TranslationKeys {
  // Navigation
  'nav.chat': string
  'nav.portfolio': string
  'nav.events': string
  'nav.heartbeat': string
  'nav.data_sources': string
  'nav.connectors': string
  'nav.tools': string
  'nav.trading': string
  'nav.atlas': string
  'nav.ai_provider': string
  'nav.settings': string
  'nav.dev': string

  // Atlas Research
  'atlas.title': string
  'atlas.description_active': string
  'atlas.description_disabled': string
  'atlas.departments': string
  'atlas.scorecard': string
  'atlas.no_departments': string
  'atlas.no_agents': string
  'atlas.run_analysis': string
  'atlas.running': string
  'atlas.timeframes': string
  'atlas.last_run': string
  'atlas.never': string
  'atlas.on': string
  'atlas.off': string
  'atlas.agent': string
  'atlas.layer': string
  'atlas.weight': string
  'atlas.sharpe': string
  'atlas.win_rate': string
  'atlas.signals': string
  'atlas.avg_conviction': string
  'atlas.conviction': string
  'atlas.thesis': string
  'atlas.risks': string
  'atlas.positions': string
  'atlas.knowledge_updates': string
  'atlas.final_report': string
  'atlas.layer_complete': string
  'atlas.agreement': string
  'atlas.team_roster': string
  'atlas.macro_layer': string
  'atlas.sector_layer': string
  'atlas.strategy_layer': string
  'atlas.decision_layer': string
  'atlas.data_sources_label': string
  'atlas.knowledge_label': string

  // Common
  'common.loading': string
  'common.error': string
  'common.save': string
  'common.cancel': string
  'common.delete': string
  'common.edit': string
  'common.create': string
  'common.search': string
  'common.enabled': string
  'common.disabled': string
  'common.status': string
  'common.connected': string
  'common.disconnected': string
}

export type Locale = 'en' | 'zh'
export type TranslationKey = keyof TranslationKeys
