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
};

export const gradients = {
  cta: ['#B6F04A', '#7DE8B0'] as const,
  ctaPressed: ['#A3E635', '#5FDCA0'] as const,
  tint: ['#F4FAEC', '#FFFFFF'] as const,
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