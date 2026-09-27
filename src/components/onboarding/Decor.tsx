import { useId } from 'react';
import { View } from 'react-native';
import { Circle, Defs, Ellipse, Path, RadialGradient, Stop, Svg } from 'react-native-svg';

import { colors } from '../../lib/theme';

/** Gradient ids are document-global on web, so each instance needs its own; React's ids contain characters
 * (colons, guillemets) that break `url(#...)`, hence the scrub. */
function useSvgId(prefix: string) {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
}

/** Four-point twinkle. */
export function Sparkle({ size, color = '#FFFFFF', opacity = 0.95 }: { size: number; color?: string; opacity?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      <Path
        d="M12 0 C12.9 7 17 11.1 24 12 C17 12.9 12.9 17 12 24 C11.1 17 7 12.9 0 12 C7 11.1 11.1 7 12 0 Z"
        fill={color}
        opacity={opacity}
      />
    </Svg>
  );
}

export function Dot({ size, color = '#FFFFFF', opacity = 0.8 }: { size: number; color?: string; opacity?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 10 10">
      <Circle cx={5} cy={5} r={5} fill={color} opacity={opacity} />
    </Svg>
  );
}

/** Soft radial light behind a hero object: what makes a flat stage read as lit. */
export function Glow({ size, color = '#FFFFFF', intensity = 0.8 }: { size: number; color?: string; intensity?: number }) {
  const id = useSvgId('glow');
  return (
    <Svg width={size} height={size} viewBox="0 0 100 100">
      <Defs>
        <RadialGradient id={id} cx="50" cy="50" r="50" gradientUnits="userSpaceOnUse">
          <Stop offset="0" stopColor={color} stopOpacity={intensity} />
          <Stop offset="1" stopColor={color} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Circle cx={50} cy={50} r={50} fill={`url(#${id})`} />
    </Svg>
  );
}

/** A blurred contact shadow under a floating object. Native shadows can't follow a PNG's alpha on Android, so the
 * "3D object resting in light" look comes from this ellipse instead. */
export function GroundShadow({ width, opacity = 0.22 }: { width: number; opacity?: number }) {
  const id = useSvgId('ground');
  const height = width * 0.28;
  return (
    <Svg width={width} height={height} viewBox="0 0 100 28">
      <Defs>
        {/* Bounding-box units stretch the circular gradient to the ellipse's own shape, so it fades to nothing at
            every edge (a userSpace circle leaves a hard band at the top and bottom). */}
        <RadialGradient id={id} cx="50%" cy="50%" r="50%" gradientUnits="objectBoundingBox">
          <Stop offset="0" stopColor={colors.text} stopOpacity={opacity} />
          <Stop offset="1" stopColor={colors.text} stopOpacity={0} />
        </RadialGradient>
      </Defs>
      <Ellipse cx={50} cy={14} rx={50} ry={14} fill={`url(#${id})`} />
    </Svg>
  );
}

/** x, y are the particle's centre and size its width, all as fractions of the illustration box's side. */
export type Particle = { x: number; y: number; size: number; kind: 'spark' | 'dot'; opacity?: number };

export function Particles({ items, side }: { items: readonly Particle[]; side: number }) {
  return (
    <>
      {items.map((p, i) => {
        const px = p.size * side;
        return (
          <View
            key={i}
            pointerEvents="none"
            style={{ position: 'absolute', left: p.x * side - px / 2, top: p.y * side - px / 2, zIndex: 20 }}
          >
            {p.kind === 'spark' ? <Sparkle size={px} opacity={p.opacity} /> : <Dot size={px} opacity={p.opacity} />}
          </View>
        );
      })}
    </>
  );
}
