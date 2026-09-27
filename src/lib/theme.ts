export const colors = {
  // Surfaces
  bg: '#FFFFFF',
  bgTint: '#F4FAEC',
  surface: '#F7F9F4',
  surfaceAlt: '#FFFFFF',
  border: '#E6E8E3',
  borderStrong: '#D3D8CC',

  // Text
  text: '#141A12',
  textMuted: '#6B7469',
  textFaint: '#9AA394',

  // Brand
  lime: '#A3E635',
  limeDeep: '#7CB518',
  limeSoft: '#E4F7C7',
  limeMist: '#DDF5B4', // back wave / splash arch
  mint: '#7DE8B0',
  limeInk: '#4D7A0A', // lime dark enough for text on white (AA)
  limeDark: '#2E5F0E', // icons and figures on light-lime surfaces

  // Buttons
  primary: '#141A12',
  primaryText: '#FFFFFF',

  // Feedback
  danger: '#D23F3F',
  dangerBg: '#FDF2F2',
  dangerBorder: '#F5C9C9',
  success: '#2FA86A',

  // Header (shop top bar + wallet menu) -- exact hexes from the approved mockup. Close to, but deliberately
  // distinct from, the general lime/text tokens above: the mockup asked for this header to match precisely, not
  // "inspired by" the app's usual palette, so these get their own named tokens instead of reusing an off-by-a-shade
  // neighbor (e.g. `lime` for the logo dot, `limeDark` for the wallet pill).
  headerBorder: '#ECECE6',
  headerAccentDot: '#8BC34A',
  walletGreen: '#3D5A1E',
  walletGreenBg: '#F1F7E8',
  walletGreenBorder: '#DFECCB',
};

export const gradients = {
  cta: ['#B6F04A', '#7DE8B0'] as const,
  ctaPressed: ['#A3E635', '#5FDCA0'] as const,
  tint: ['#F4FAEC', '#FFFFFF'] as const,
  // A Vault gift-card's fallback face when the product has no sourced brand mark (vaultBrands.ts): a plain, dark,
  // premium card rather than anything lime-branded, so an unbranded card never looks like a mistake or a placeholder.
  vaultNeutral: ['#2B2F27', '#1A1D17'] as const,
  // Splash onboarding: the brand lime turned across three analogous hues (warm lime, green -> teal, blue -> violet).
  // Each slide has a pale full-screen backdrop and a more saturated "arch" stage; both stay light enough for the
  // dark ink headline and for the lime Sign up button that sits on top of the backdrop.
  onboardWarmBg: ['#F7FCE8', '#EAF8C6', '#FFF0C9'] as const,
  onboardWarmArch: ['#E6F9B4', '#FFE19A', '#FFC98A'] as const,
  onboardTealBg: ['#EEFBF4', '#D3F5E6', '#CDEFF1'] as const,
  onboardTealArch: ['#B9F0D6', '#86DCCB', '#6CC3D6'] as const,
  onboardVioletBg: ['#F0F4FF', '#DDE6FD', '#E6DDFB'] as const,
  onboardVioletArch: ['#C9D7FF', '#A9B4F6', '#B39CEB'] as const,
};

/**
 * The prize wheel's carnival look: a cream/tan face on a warm amber rim with warm-brown labels. These are the only
 * warm tones in the app, deliberately confined to the wheel. The rare-prize wedge, the pegs and the stage reuse
 * existing tokens instead (gradients.cta lime -> mint, colors.lime, gradients.vaultNeutral), so the one thing that
 * stands out on the wheel is in the brand's own colour.
 */
export const wheel = {
  face: '#FFF8EC',
  faceAlt: '#FBEAD0',
  faceMid: '#F7E1C1', // only for the last slice of an odd count, so two same-colour slices never touch
  seam: '#E9CB9C',
  rim: ['#F6CD8A', '#E3A04F', '#C97F34'] as const,
  rimLine: '#B06A26',
  ink: '#6E4322',
  hub: ['#3B4034', '#141A12'] as const,
  hubRing: '#F4D9A8',
  ambient: '#FFC770',
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 44,
};

export const radius = {
  sm: 10,
  md: 14,
  lg: 20,
  xl: 28,
  pill: 999,
};

export const fonts = {
  regular: 'PlusJakartaSans_400Regular',
  medium: 'PlusJakartaSans_500Medium',
  semibold: 'PlusJakartaSans_600SemiBold',
  bold: 'PlusJakartaSans_700Bold',
  extrabold: 'PlusJakartaSans_800ExtraBold',
};

export const shadow = {
  soft: {
    shadowColor: '#2A3320',
    shadowOpacity: 0.08,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 4,
  },
  lift: {
    shadowColor: '#2A3320',
    shadowOpacity: 0.14,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
};