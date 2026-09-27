/**
 * Real brand marks for the Vault's card-style entries, keyed by the product's exact name. Each mark was taken from
 * the brand's own site (see assets/vault), the same sourcing rule already used for the Telebirr/CBE payment logos
 * (assets/payments): a real, current, official image, nothing redrawn or guessed. A product with no entry here gets
 * the plain dark fallback card (gradients.vaultNeutral, no logo) -- never a fake or placeholder mark.
 *
 * Add a brand only after sourcing its logo cleanly. Colors are sampled from the sourced mark itself, not typed from
 * memory, so the card's gradient actually matches the logo sitting on it.
 */
export type VaultBrand = {
  /** require()'d image source, square, transparent background where the source allows it. */
  logo: number;
  /** Two-stop gradient for the card face, sampled from the brand's own mark. */
  gradient: readonly [string, string];
};

// Roblox: the official app icon favicon from roblox.com (64x64, real, 2026-09-23). Dominant fill sampled directly
// from the image: #335FFF. The gradient darkens slightly toward the bottom for depth, not a second brand color --
// Roblox's own mark is single-tone.
const ROBLOX: VaultBrand = {
  logo: require('../../assets/vault/roblox.png'),
  gradient: ['#335FFF', '#1E3AA8'],
};

const VAULT_BRANDS: Readonly<Record<string, VaultBrand>> = {
  roblox: ROBLOX,
};

/** Case-insensitive: "Roblox", "ROBLOX" and "roblox" all match the same entry. Null = use the plain fallback card. */
export function vaultBrandOf(productName: string): VaultBrand | null {
  return VAULT_BRANDS[productName.trim().toLowerCase()] ?? null;
}
