// "now", "3m", "7h", "2d": short enough for a session row, which is one line wide.
export function ageShort (iso, now = Date.now()) {
  if (!iso) return ''
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(s)) return ''
  if (s < 45) return 'now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`
  return `${Math.floor(s / (86400 * 30))}mo`
}
