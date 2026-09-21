import Svg, {
  Circle,
  Defs,
  G,
  LinearGradient,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';

import { colors } from '../../lib/theme';

type Props = { size?: number };

export function HeroTopUp({ size = 260 }: Props) {
  const stroke = colors.text;
  const sw = 3;

  return (
    <Svg width={size} height={size} viewBox="0 0 240 240" fill="none">
      <Defs>
        <LinearGradient id="boltFill" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#B6F04A" />
          <Stop offset="1" stopColor="#7DE8B0" />
        </LinearGradient>
      </Defs>

      {/* Soft backdrop */}
      <Circle cx="120" cy="118" r="98" fill={colors.limeSoft} />
      <Circle
        cx="120"
        cy="118"
        r="98"
        stroke={colors.lime}
        strokeWidth="1.5"
        opacity={0.5}
      />

      {/* Phone body */}
      <Rect
        x="79"
        y="40"
        width="82"
        height="156"
        rx="18"
        fill={colors.bg}
        stroke={stroke}
        strokeWidth={sw}
      />
      {/* Screen */}
      <Rect
        x="88"
        y="54"
        width="64"
        height="128"
        rx="10"
        fill={colors.surface}
        stroke={stroke}
        strokeWidth="2"
      />
      {/* Notch */}
      <Rect x="107" y="45" width="26" height="6" rx="3" fill={stroke} />

      {/* Lightning bolt = instant delivery */}
      <Path
        d="M126 74 L100 118 L117 118 L112 162 L142 112 L124 112 Z"
        fill="url(#boltFill)"
        stroke={stroke}
        strokeWidth="2.5"
        strokeLinejoin="round"
      />

      {/* Coin left */}
      <G>
        <Circle
          cx="52"
          cy="156"
          r="20"
          fill={colors.lime}
          stroke={stroke}
          strokeWidth={sw}
        />
        <Circle
          cx="52"
          cy="156"
          r="10"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
        />
      </G>

      {/* Coin right */}
      <G>
        <Circle
          cx="190"
          cy="128"
          r="15"
          fill={colors.mint}
          stroke={stroke}
          strokeWidth={sw}
        />
        <Circle
          cx="190"
          cy="128"
          r="7"
          fill="none"
          stroke={stroke}
          strokeWidth="2"
        />
      </G>

      {/* Sparkles */}
      <Path
        d="M62 64 C62 74 66 78 76 78 C66 78 62 82 62 92 C62 82 58 78 48 78 C58 78 62 74 62 64 Z"
        fill={colors.lime}
        stroke={stroke}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <Path
        d="M180 62 C180 69 183 72 190 72 C183 72 180 75 180 82 C180 75 177 72 170 72 C177 72 180 69 180 62 Z"
        fill={colors.mint}
        stroke={stroke}
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <Path
        d="M148 186 C148 192 150 194 156 194 C150 194 148 196 148 202 C148 196 146 194 140 194 C146 194 148 192 148 186 Z"
        fill={colors.lime}
        stroke={stroke}
        strokeWidth="2"
        strokeLinejoin="round"
      />

      {/* Ground line */}
      <Path
        d="M46 206 L194 206"
        stroke={stroke}
        strokeWidth="2.5"
        strokeLinecap="round"
        opacity={0.25}
      />
    </Svg>
  );
}