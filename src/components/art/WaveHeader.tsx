import { View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { colors } from '../../lib/theme';

type Props = {
  /** Height of the wave artwork, below the status bar. */
  height?: number;
};

/**
 * Two-layer wavy header. The top layer is flat lime, so the status bar area
 * is filled with the same color and the waves start right beneath it.
 */
export function WaveHeader({ height = 150 }: Props) {
  const insets = useSafeAreaInsets();

  return (
    <View style={{ pointerEvents: 'none' }}>
      <View style={{ height: insets.top, backgroundColor: colors.lime }} />
      <Svg
        width="100%"
        height={height}
        viewBox="0 0 400 150"
        preserveAspectRatio="none"
      >
        <Path
          d="M0 0H400V112C345 146 290 140 232 118C170 94 84 84 0 128Z"
          fill={colors.limeMist}
        />
        <Path
          d="M0 0H400V78C350 110 300 104 248 84C190 62 96 56 0 98Z"
          fill={colors.lime}
        />
      </Svg>
    </View>
  );
}
