/**
 * Overall Pass ("animate the banners with the winds"): the retail and town cloth that sways without a converter run.
 * The converter's cloth pass (convert world/town/cloth.ts) writes `models[].cloth` into the manifest; these rules are
 * folded in at material conversion (materials.ts) for every model whose manifest entry does not already name the
 * material, so today's exports pick them up. Each entry was checked on its glb (texture + UVs, 2026-10-11):
 * - `cj_jang_gaobj01` `cj_jang_gate09`: the town pillars' two dragon banners (one primitive, v 0 at the top, 6.75 m);
 * - `town/props/banner` `town_banner_cloth`: the 長安 pole flags along the walls and gates (v 0 at the crossbar);
 * - `c_jin_wall` `C_jin_wall_flag`: the town wall's flags (many in one primitive, each streaming from its pole at u 0).
 * Left out: the ferry's flags (an atlas strip: u 0–0.07, no per-flag pin), `cj_jang_gate03` (rigid gilt dragons).
 */
import type { WorldModelCloth } from '../../../convert/src/world/manifest.ts'

export interface RetailClothRule {
  /** The model source's base name (lower case, no directories, `#variant` or extension), e.g. 'cj_jang_gaobj01'. */
  model: string
  cloth: WorldModelCloth
}

/** For `banner` / `flag`, `pinY` is the UV pin and `height` the cloth's length (m). */
export const RETAIL_CLOTH: readonly RetailClothRule[] = [
  { model: 'cj_jang_gaobj01', cloth: { material: 'cj_jang_gate09', kind: 'banner', pinY: 0, height: 6.75 } },
  { model: 'banner', cloth: { material: 'town_banner_cloth', kind: 'banner', pinY: 0, height: 2.4 } },
  { model: 'c_jin_wall', cloth: { material: 'C_jin_wall_flag', kind: 'flag', pinY: 0, height: 3 } },
]

/** A model source's base name: lower case, no directories, no `#variant` / `@variant`, no extension. */
export function clothModelKey(source: string): string {
  return source.replace(/\\/g, '/').toLowerCase().replace(/^.*\//, '').replace(/[#@].*$/, '').replace(/\.(bsr|glb)$/, '')
}

/** The manifest's cloth entries of a model with the retail rules it lacks appended (unchanged when none apply). */
export function withRetailCloth(source: string | undefined, cloth: readonly WorldModelCloth[] | undefined, rules: readonly RetailClothRule[] = RETAIL_CLOTH): readonly WorldModelCloth[] | undefined {
  if (!source) return cloth
  const key = clothModelKey(source)
  const add = rules.filter(r => r.model === key && !cloth?.some(c => c.material.toLowerCase() === r.cloth.material.toLowerCase()))
  return add.length ? [...(cloth ?? []), ...add.map(r => r.cloth)] : cloth
}
