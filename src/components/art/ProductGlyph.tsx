import Svg, { Circle, Line, Path, Rect } from 'react-native-svg';

import type { GlyphKind } from '../../lib/catalog';
import { colors } from '../../lib/theme';

type Props = { kind: GlyphKind; size?: number };

const INK = colors.text;
const SW = 2.2;
const GOLD = '#F7D154';

export function ProductGlyph({ kind, size = 34 }: Props) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      fill="none"
      stroke={INK}
      strokeWidth={SW}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {kind === 'diamond' && (
        <>
          <Path d="M24 8 38 20 24 40 10 20Z" fill={colors.lime} />
          <Path d="M10 20h28M18 20l6-12 6 12M18 20l6 20 6-20" />
        </>
      )}
      {kind === 'coin' && (
        <>
          <Circle cx="24" cy="24" r="15" fill={GOLD} />
          <Circle cx="24" cy="24" r="8.5" />
          <Path d="M24 20v8M21 24h6" />
        </>
      )}
      {kind === 'signal' && (
        <>
          <Path d="M9 19q15-13 30 0M14.5 26q9.5-8 19 0M20 33q4-3.5 8 0" />
          <Circle cx="24" cy="39" r="2.6" fill={colors.lime} />
        </>
      )}
      {kind === 'gift' && (
        <>
          <Rect x="10" y="21" width="28" height="18" rx="3" fill={colors.mint} />
          <Rect x="8" y="14" width="32" height="7" rx="2" fill={colors.bg} />
          <Path d="M24 14v25M24 14c-6-8-13-3-8 0M24 14c6-8 13-3 8 0" />
        </>
      )}
      {kind === 'play' && (
        <>
          <Rect x="7" y="12" width="34" height="24" rx="7" fill={colors.bg} />
          <Path d="M21 19v10l9-5Z" fill={colors.lime} />
        </>
      )}
      {kind === 'crosshair' && (
        <>
          <Circle cx="24" cy="24" r="13" fill={colors.bg} />
          <Path d="M24 7v9M24 32v9M7 24h9M32 24h9" />
          <Circle cx="24" cy="24" r="2.6" fill={INK} />
        </>
      )}
      {kind === 'controller' && (
        <>
          <Rect x="6" y="15" width="36" height="20" rx="10" fill={colors.bg} />
          <Line x1="15" y1="22" x2="15" y2="28" />
          <Line x1="12" y1="25" x2="18" y2="25" />
          <Circle cx="31" cy="23" r="2" fill={colors.lime} />
          <Circle cx="36" cy="27" r="2" fill={colors.mint} />
        </>
      )}
    </Svg>
  );
}
