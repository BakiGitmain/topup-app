import { gradients } from '../../lib/theme';
import type { GradientStops } from './ArchStage';
import { CardStackIllustration } from './CardStackIllustration';
import { FloatingIllustration, type FloatingComposition } from './FloatingIllustration';

export type OnboardingSlideSpec = {
  key: string;
  titleKey: 'splash.s1.title' | 'splash.s2.title' | 'splash.s3.title';
  subKey: 'splash.s1.sub' | 'splash.s2.sub' | 'splash.s3.sub';
  backdrop: GradientStops;
  arch: GradientStops;
  illustration: (side: number, reduced: boolean) => React.ReactNode;
};

// 3D renders: assets/onboarding/SOURCES.md (3dicons, CC0).
const SPEED: FloatingComposition = {
  items: [
    { key: 'clock', source: require('../../../assets/onboarding/clock.png'), x: 0.27, y: 0.62, size: 0.4, rotate: -12, z: 1 },
    { key: 'flash', source: require('../../../assets/onboarding/flash.png'), x: 0.56, y: 0.48, size: 0.66, rotate: 6, z: 2, float: true },
    { key: 'star', source: require('../../../assets/onboarding/star.png'), x: 0.84, y: 0.22, size: 0.22, rotate: 16, z: 3 },
  ],
  particles: [
    { x: 0.14, y: 0.24, size: 0.08, kind: 'spark' },
    { x: 0.9, y: 0.58, size: 0.06, kind: 'spark' },
    { x: 0.66, y: 0.08, size: 0.035, kind: 'dot', opacity: 0.75 },
    { x: 0.1, y: 0.84, size: 0.03, kind: 'dot', opacity: 0.6 },
    { x: 0.82, y: 0.86, size: 0.025, kind: 'dot', opacity: 0.6 },
  ],
  glow: { x: 0.54, y: 0.48, size: 0.95 },
  ground: { x: 0.52, y: 0.86, width: 0.66 },
};

const SAVINGS: FloatingComposition = {
  items: [
    { key: 'coin', source: require('../../../assets/onboarding/coin.png'), x: 0.24, y: 0.68, size: 0.36, rotate: -14, z: 1 },
    { key: 'dollar', source: require('../../../assets/onboarding/coin-dollar.png'), x: 0.5, y: 0.52, size: 0.6, z: 2, float: true },
    { key: 'percent', badge: 'percent', x: 0.8, y: 0.26, size: 0.3, rotate: 12, z: 3 },
  ],
  particles: [
    { x: 0.16, y: 0.2, size: 0.08, kind: 'spark' },
    { x: 0.9, y: 0.62, size: 0.06, kind: 'spark' },
    { x: 0.52, y: 0.08, size: 0.035, kind: 'dot', opacity: 0.75 },
    { x: 0.08, y: 0.46, size: 0.03, kind: 'dot', opacity: 0.6 },
    { x: 0.76, y: 0.9, size: 0.025, kind: 'dot', opacity: 0.6 },
  ],
  glow: { x: 0.5, y: 0.5, size: 0.95 },
  ground: { x: 0.46, y: 0.86, width: 0.68 },
};

export const ONBOARDING_SLIDES: readonly OnboardingSlideSpec[] = [
  {
    key: 'games',
    titleKey: 'splash.s1.title',
    subKey: 'splash.s1.sub',
    backdrop: gradients.onboardWarmBg,
    arch: gradients.onboardWarmArch,
    illustration: (side) => <CardStackIllustration side={side} />,
  },
  {
    key: 'speed',
    titleKey: 'splash.s2.title',
    subKey: 'splash.s2.sub',
    backdrop: gradients.onboardTealBg,
    arch: gradients.onboardTealArch,
    illustration: (side, reduced) => <FloatingIllustration side={side} composition={SPEED} reduced={reduced} />,
  },
  {
    key: 'savings',
    titleKey: 'splash.s3.title',
    subKey: 'splash.s3.sub',
    backdrop: gradients.onboardVioletBg,
    arch: gradients.onboardVioletArch,
    illustration: (side, reduced) => <FloatingIllustration side={side} composition={SAVINGS} reduced={reduced} />,
  },
];
