import { LinearGradient } from 'expo-linear-gradient';
import { forwardRef, useId, useImperativeHandle, useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Circle, Defs, G, LinearGradient as SvgLinearGradient, Path, RadialGradient, Stop, Text as SvgText } from 'react-native-svg';
import Animated, {
  Easing,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from 'react-native-reanimated';

import { colors, fonts, gradients, shadow, wheel as W } from '../../lib/theme';
import { fitFontSize, oddsPercent, rotationToAngle, sliceLayout, splitLabel, standoutIndex } from '../../lib/wheelLogic';

export type PrizeWheelHandle = {
  /** Spins to the prize ALREADY DECIDED server-side by spin_wheel() before this is ever called. This only plays the
   * animation; it never picks the outcome. It lands on the slice whose id is `prizeId`, falling back to the
   * server's `index` if that prize isn't on this wheel (an admin edited the prizes after the wheel was loaded).
   * `onDone` fires once the wheel has settled AND the winning slice's brief highlight has finished -- not the instant
   * the rotation itself stops -- so a caller showing a result modal from `onDone` never cuts the landing short. */
  spinTo: (target: { prizeId: string; index: number }, onDone?: () => void) => void;
};

/** In the server's order (created_at, id). `weight` sizes the slice, `discountBirr` only breaks standout ties. */
export type WheelSlice = { id: string; label: string; weight: number; discountBirr: number };

type Props = { slices: WheelSlice[]; size?: number; /** The existing spin-trigger text, shown on the hub. */ hubLabel: string };

const RIM_GOLD = '#FFD65A';
const SPIN_MS = 4200;
const EXTRA_SPINS = 6;
// The final stop isn't a hard cut: the wheel overshoots the target by a few degrees, then springs back --
// a small physical "settle", not just an ease-out that stops dead.
const OVERSHOOT_DEG = 7;
const SETTLE_SPRING = { damping: 12, stiffness: 180, mass: 0.9 };
// After settling, the winning slice -- always resting at the top, under the pointer -- gets a brief glow before the
// caller's onDone (and therefore the result modal) fires; the same timeline pulses a glow around the whole rim.
const HIGHLIGHT_IN_MS = 150;
const HIGHLIGHT_HOLD_MS = 250;
const HIGHLIGHT_OUT_MS = 220;

/** Slices at least this wide get the reference's two-line label across the wedge; thinner ones get one line running
 * along the radius, the only way a label fits a narrow wedge. */
const WIDE_SLICE_DEG = 40;

const polar = (c: number, r: number, angleDeg: number) => {
  // -90 so 0deg is the top (12 o'clock); increasing angle moves clockwise, matching rotationToAngle's convention
  // and the clockwise-positive `rotate()` the wheel spins with.
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  return { x: c + r * Math.cos(rad), y: c + r * Math.sin(rad) };
};

const wedgePath = (c: number, r: number, startDeg: number, sweepDeg: number) => {
  const a = polar(c, r, startDeg);
  const b = polar(c, r, startDeg + sweepDeg);
  return `M ${c} ${c} L ${a.x} ${a.y} A ${r} ${r} 0 ${sweepDeg > 180 ? 1 : 0} 1 ${b.x} ${b.y} Z`;
};

/** A teardrop pin, point down, in a 40x50 box. */
const PIN_PATH = 'M20 49 C14 38 2 31 2 19.5 A18 18 0 1 1 38 19.5 C38 31 26 38 20 49 Z';

function useSvgId(prefix: string) {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
}

/** One slice's label, drawn as if the slice pointed straight up; the caller's group rotates it into place. */
function SliceLabel({ c, faceR, hubR, sweep, label, ink }: { c: number; faceR: number; hubR: number; sweep: number; label: string; ink: string }) {
  const family = fonts.extrabold;
  if (sweep >= WIDE_SLICE_DEG) {
    const lines = splitLabel(label);
    const rho = faceR * 0.68;
    // Width of the wedge at that radius, with margin; very wide wedges are capped so text stays compact near the top.
    const chord = 2 * rho * Math.sin((Math.min(sweep, 150) * Math.PI) / 360) * 0.78;
    const big = fitFontSize(lines[0], chord, faceR * 0.2, 11);
    const baseY = c - rho + big * 0.35;
    if (lines.length === 1) {
      return <SvgText x={c} y={baseY} fill={ink} fontFamily={family} fontSize={big} textAnchor="middle">{lines[0]}</SvgText>;
    }
    const small = Math.min(big * 0.56, fitFontSize(lines[1], chord * 0.8, faceR * 0.12, 9));
    return (
      <G>
        <SvgText x={c} y={baseY} fill={ink} fontFamily={family} fontSize={big} textAnchor="middle">{lines[0]}</SvgText>
        <SvgText x={c} y={baseY + small * 1.3} fill={ink} fontFamily={family} fontSize={small} textAnchor="middle">
          {lines[1]}
        </SvgText>
      </G>
    );
  }
  // Thin slice: one line along the radius, reading outward from the hub.
  const inner = hubR * 1.18;
  const outer = faceR * 0.94;
  const rho = (inner + outer) / 2;
  const thickness = 2 * rho * Math.sin((sweep * Math.PI) / 360) * 0.86;
  const size = Math.max(8, Math.min(fitFontSize(label, outer - inner, faceR * 0.14, 8), thickness * 1.05));
  return (
    <G transform={`translate(${c} ${c - rho}) rotate(-90)`}>
      <SvgText x={0} y={size * 0.35} fill={ink} fontFamily={family} fontSize={size} textAnchor="middle">
        {label}
      </SvgText>
    </G>
  );
}

/**
 * A custom-built SVG wheel whose slices are sized by each prize's real weight (see sliceLayout/MIN_SLICE_DEG for the
 * one documented exception), rotated via Reanimated to a final angle computed from the server's winner. Everything
 * decorative -- ambient rays, rim, pegs, hub, pin -- is layered around that geometry; the fairness-critical path
 * (server picks, client only animates to it) is unchanged. Not yet seen on a device.
 */
export const PrizeWheel = forwardRef<PrizeWheelHandle, Props>(function PrizeWheel({ slices, size = 280, hubLabel }, ref) {
  const rotation = useSharedValue(0);
  const highlight = useSharedValue(0);
  const c = size / 2;
  const faceR = c * 0.87;
  const hubR = c * 0.27;
  const arcs = useMemo(() => sliceLayout(slices.map((s) => s.weight)), [slices]);
  const standout = useMemo(() => standoutIndex(slices), [slices]);
  const rimId = useSvgId('rim');
  const rareId = useSvgId('rare');
  const rayId = useSvgId('ray');
  const ambientId = useSvgId('amb');
  const shadowId = useSvgId('shd');

  useImperativeHandle(
    ref,
    () => ({
      spinTo({ prizeId, index }, onDone) {
        const byId = slices.findIndex((s) => s.id === prizeId);
        const i = byId >= 0 ? byId : Math.min(Math.max(index, 0), arcs.length - 1);
        const arc = arcs[i];
        if (!arc) return;
        const target = rotationToAngle({ centerDeg: arc.center, currentRotation: rotation.value, extraSpins: EXTRA_SPINS });
        rotation.value = withSequence(
          withTiming(target + OVERSHOOT_DEG, { duration: SPIN_MS, easing: Easing.out(Easing.cubic) }),
          withSpring(target, SETTLE_SPRING, (finished) => {
            if (!finished) return;
            highlight.value = withSequence(
              withTiming(1, { duration: HIGHLIGHT_IN_MS }),
              withDelay(
                HIGHLIGHT_HOLD_MS,
                withTiming(0, { duration: HIGHLIGHT_OUT_MS }, (doneFading) => {
                  if (doneFading && onDone) runOnJS(onDone)();
                })
              )
            );
          })
        );
      },
    }),
    [rotation, highlight, slices, arcs]
  );

  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${rotation.value}deg` }] }));
  const glowStyle = useAnimatedStyle(() => ({ opacity: highlight.value, transform: [{ scale: 0.85 + highlight.value * 0.25 }] }));
  const rimGlowStyle = useAnimatedStyle(() => ({ opacity: highlight.value * 0.85, transform: [{ scale: 0.94 + highlight.value * 0.09 }] }));

  // Screen readers get the real odds -- the drawing may floor a tiny slice, the words never do.
  const totalWeight = slices.reduce((a, s) => a + s.weight, 0);
  const a11y = slices.map((s) => `${s.label} ${oddsPercent(s.weight, totalWeight) ?? 0}%`).join(', ');

  // The halo reaches 1.45x the wheel: wide enough to read as light around it, small enough to fade out before the
  // edge of a phone-width column, so there is never a visible edge to it.
  const ambient = size * 1.45;
  const ac = ambient / 2;
  const edge = size / 2 / ac; // where the rim sits, as a fraction of the halo's radius
  const pinW = size * 0.13;

  return (
    <View style={[styles.wrap, { width: size, height: size }]} accessible accessibilityLabel={a11y}>
      {/* Ambient light straight on the page, no backdrop: an amber halo starting at the rim, plus faint amber rays,
          fixed (they never spin), both fading to nothing. Amber rather than white because the page is light. */}
      <Svg pointerEvents="none" width={ambient} height={ambient} style={[styles.ambient, { left: -(ambient - size) / 2, top: -(ambient - size) / 2 }]}>
        <Defs>
          <RadialGradient id={ambientId} cx={ac} cy={ac} r={ac} gradientUnits="userSpaceOnUse">
            <Stop offset={edge * 0.9} stopColor={W.ambient} stopOpacity={0.42} />
            <Stop offset="1" stopColor={W.ambient} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={shadowId} cx={ac} cy={ac + size * 0.045} r={ac} gradientUnits="userSpaceOnUse">
            <Stop offset={edge * 0.96} stopColor="#8A4F14" stopOpacity={0.3} />
            <Stop offset={edge * 1.14} stopColor="#8A4F14" stopOpacity={0} />
          </RadialGradient>
          <RadialGradient id={rayId} cx={ac} cy={ac} r={ac} gradientUnits="userSpaceOnUse">
            <Stop offset={edge} stopColor={W.ambient} stopOpacity={0.28} />
            <Stop offset="1" stopColor={W.ambient} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx={ac} cy={ac} r={ac} fill={`url(#${ambientId})`} />
        {Array.from({ length: 12 }, (_, i) => (
          <Path key={i} d={wedgePath(ac, ac, i * 30 - 4, 8)} fill={`url(#${rayId})`} />
        ))}
        {/* A soft drop shadow, a little below the disc: on a light page this, not a dark box, is what lifts the
            wheel. Drawn here, not as a native shadow, because Android's `elevation` would reorder the wheel's
            layers (an elevated view draws above un-elevated siblings) and hide the shine and the winner glow. */}
        <Circle cx={ac} cy={ac + size * 0.045} r={ac} fill={`url(#${shadowId})`} />
      </Svg>

      <Animated.View pointerEvents="none" style={[styles.rimGlow, { width: size + 22, height: size + 22, borderRadius: (size + 22) / 2 }, rimGlowStyle]} />

      <Animated.View style={[{ width: size, height: size }, animatedStyle]}>
        <Svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          <Defs>
            <SvgLinearGradient id={rimId} x1="0" y1="0" x2="1" y2="1">
              {W.rim.map((col, i) => (
                <Stop key={col} offset={i / (W.rim.length - 1)} stopColor={col} />
              ))}
            </SvgLinearGradient>
            <SvgLinearGradient id={rareId} x1="0" y1="0" x2="1" y2="1">
              <Stop offset="0" stopColor={gradients.cta[0]} />
              <Stop offset="1" stopColor={gradients.cta[1]} />
            </SvgLinearGradient>
          </Defs>

          {/* Rim: a warm amber band with a thin darker line where it meets the face. */}
          <Circle cx={c} cy={c} r={c} fill={`url(#${rimId})`} />
          <Circle cx={c} cy={c} r={faceR + 2.5} fill={W.rimLine} />

          {slices.length === 1 ? (
            <Circle cx={c} cy={c} r={faceR} fill={W.face} />
          ) : (
            arcs.map((arc, i) => {
              const fill =
                i === standout
                  ? `url(#${rareId})`
                  : slices.length % 2 === 1 && i === slices.length - 1
                    ? W.faceMid
                    : i % 2 === 0
                      ? W.face
                      : W.faceAlt;
              return <Path key={slices[i].id} d={wedgePath(c, faceR, arc.start, arc.sweep)} fill={fill} stroke={W.seam} strokeWidth={1} />;
            })
          )}

          {arcs.map((arc, i) => (
            <G key={slices[i].id} transform={`rotate(${arc.center} ${c} ${c})`}>
              <SliceLabel c={c} faceR={faceR} hubR={hubR} sweep={arc.sweep} label={slices[i].label} ink={i === standout ? colors.text : W.ink} />
            </G>
          ))}

          {/* Pegs on the rim, one at every slice boundary. */}
          {slices.length > 1 &&
            arcs.map((arc) => {
              const p = polar(c, (c + faceR) / 2 + 0.5, arc.start);
              return (
                <G key={`peg-${arc.start}`}>
                  <Circle cx={p.x} cy={p.y} r={c * 0.055} fill="#FFFFFF" />
                  <Circle cx={p.x} cy={p.y} r={c * 0.038} fill={colors.lime} />
                  <Circle cx={p.x - c * 0.012} cy={p.y - c * 0.012} r={c * 0.012} fill="#FFFFFF" opacity={0.85} />
                </G>
              );
            })}
        </Svg>
      </Animated.View>

      {/* Fixed glassy shine over the face -- light on the wheel, not painted on it, so it never rotates. */}
      <LinearGradient
        pointerEvents="none"
        colors={['rgba(255,255,255,0.32)', 'rgba(255,255,255,0.04)', 'rgba(255,255,255,0)']}
        start={{ x: 0.18, y: 0.08 }}
        end={{ x: 0.7, y: 0.8 }}
        style={[styles.overlay, { width: faceR * 2, height: faceR * 2, borderRadius: faceR }]}
      />

      {/* The hub: fixed, so its text always reads upright while the wheel turns around it. */}
      <View pointerEvents="none" style={[styles.hubRing, { width: hubR * 2 + 8, height: hubR * 2 + 8, borderRadius: hubR + 4 }]}>
        <LinearGradient colors={W.hub} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={[styles.hub, { width: hubR * 2, height: hubR * 2, borderRadius: hubR }]}>
          <Text style={[styles.hubText, { fontSize: hubR * 0.42 }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.6}>
            {hubLabel}
          </Text>
        </LinearGradient>
      </View>

      {/* The winning-slice glow sits right under the pin, because the winner always comes to rest there. */}
      <Animated.View pointerEvents="none" style={[styles.glow, { width: size * 0.42, height: size * 0.42, borderRadius: size * 0.21 }, glowStyle]} />

      <View pointerEvents="none" style={[styles.pin, { width: pinW, height: pinW * 1.25, top: -pinW * 0.55 }]}>
        <Svg width={pinW} height={pinW * 1.25} viewBox="0 0 40 50">
          <Path d={PIN_PATH} fill={W.hub[1]} stroke={W.hubRing} strokeWidth={2.5} />
          <Circle cx={20} cy={19.5} r={6.5} fill={W.hubRing} opacity={0.9} />
        </Svg>
      </View>
    </View>
  );
});

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', justifyContent: 'center' },
  ambient: { position: 'absolute' },
  glow: { position: 'absolute', top: -6, backgroundColor: '#FFE9A8', zIndex: 3 },
  rimGlow: { position: 'absolute', backgroundColor: 'transparent', borderWidth: 10, borderColor: RIM_GOLD, zIndex: 0 },
  overlay: { position: 'absolute' },
  hubRing: { position: 'absolute', alignItems: 'center', justifyContent: 'center', backgroundColor: W.hubRing, ...shadow.lift },
  hub: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  hubText: { fontFamily: fonts.extrabold, color: '#FFFFFF', letterSpacing: 0.5, textTransform: 'uppercase' },
  pin: { position: 'absolute', alignSelf: 'center', zIndex: 4, ...shadow.soft },
});
