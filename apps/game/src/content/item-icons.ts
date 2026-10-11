/**
 * Painted icons of authored items that have no retail icon (retail-style 32x32 tiles, apps/game/public/item-icons/,
 * served at /item-icons/). They win over ItemDef.icon (a cloned row's borrowed retail icon, or null) everywhere the
 * client resolves an item icon: the HUD catalog (inventory, shops, tooltips, hotbar) and the content catalog.
 * The private branch registers its own items with registerItemIcons().
 */
import type { ItemDef } from '@sro/shared'

const ICONS: Record<string, string> = {
  ITEM_WINTER_GIFT_BOX: '/item-icons/winter_gift.png',
  ITEM_WINTER_GINGER_TEA: '/item-icons/winter_tea.png',
}

/** Adds icons (code -> URL); later entries win. */
export function registerItemIcons(map: Readonly<Record<string, string>>): void {
  Object.assign(ICONS, map)
}

/** The painted icon of an authored item, or null. */
export function authoredItemIcon(code: string): string | null {
  return ICONS[code] ?? null
}

/** Sets the painted icon on every listed item (in place). Returns how many were set. */
export function applyItemIcons(items: Map<string, ItemDef>): number {
  let n = 0
  for (const [code, url] of Object.entries(ICONS)) {
    const def = items.get(code)
    if (!def) continue
    def.icon = url
    n++
  }
  return n
}
