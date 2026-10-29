import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

// Progreso 0→1 con rebote suave a partir de un frame (relativo a la escena)
export const useEntrada = (desde: number, config = { damping: 14, stiffness: 120, mass: 0.8 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - desde, fps, config });
};

// Texto o bloque que entra subiendo y con fundido; opcionalmente sale en `hasta`
export const Aparecer: React.FC<{
  desde: number;
  hasta?: number;
  distancia?: number;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ desde, hasta, distancia = 60, style, children }) => {
  const frame = useCurrentFrame();
  const entrada = useEntrada(desde);
  const salida = hasta === undefined ? 1 : interpolate(frame, [hasta - 10, hasta], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ opacity: Math.min(entrada, salida), transform: `translateY(${(1 - entrada) * distancia}px) scale(${0.96 + entrada * 0.04})`, ...style }}>
      {children}
    </div>
  );
};

// Contenedor de escena: fundido de entrada y salida para que los cortes no sean bruscos (la última escena no sale)
export const Escena: React.FC<{ duracion: number; fundido?: number; salida?: boolean; style?: React.CSSProperties; children: React.ReactNode }> = ({ duracion, fundido = 12, salida = true, style, children }) => {
  const frame = useCurrentFrame();
  const opacidad = interpolate(frame, [0, fundido, duracion - fundido, duracion], [0, 1, 1, salida ? 0 : 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return <AbsoluteFill style={{ opacity: opacidad, ...style }}>{children}</AbsoluteFill>;
};

// Cuenta de 0 al valor final entre dos frames (para totales y arqueo)
export const useContador = (valor: number, desde: number, hasta: number) => {
  const frame = useCurrentFrame();
  return interpolate(frame, [desde, hasta], [0, valor], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: t => 1 - Math.pow(1 - t, 3) });
};
