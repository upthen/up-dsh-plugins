/**
 * Language seat.
 *
 * The plugin registers a `reading` dictionary namespace through the Client locale
 * service (see 99-apply) for short shared labels, and resolves the active language
 * here so longer view copy can keep both languages next to the component that owns
 * it. This keeps every visible string translatable without a second dictionary
 * namespace per view.
 */

let ACTIVE_LANG = 'zh'
let translateFn = (key) => key

/** Resolve the active language id out of a locale snapshot. */
function languageOf(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return 'zh'
  const value = snapshot.locale || snapshot.active || snapshot.current || snapshot.id || snapshot.language
  return typeof value === 'string' && value.length > 0 ? value.toLowerCase() : 'zh'
}

/** Apply a locale snapshot to the plugin's active language. */
function setActiveLanguage(snapshot) {
  ACTIVE_LANG = languageOf(snapshot)
}

/** Pick the English string only for an English UI. */
function tr(zh, en) {
  return ACTIVE_LANG.startsWith('en') ? en : zh
}

/** Short shared label through the registered dictionary. */
function label(key) {
  try {
    return translateFn(key) || key
  } catch {
    return key
  }
}
