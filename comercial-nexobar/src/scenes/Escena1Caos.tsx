import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Aparecer, Escena, useEntrada } from '../components/Animacion';
import { IconoAlerta, IconoWifiOff } from '../components/Iconos';
import { COLOR, FUENTE, ZONA_SEGURA } from '../theme';

// 0–8 s: se cae el internet en plena hora pico. Alertas rojas pulsantes y mesas en espera.
const MESAS = [
  { nombre: 'Mesa 3', espera: 14 },
  { nombre: 'Mesa 7', espera: 9 },
  { nombre: 'Barra 2', espera: 21 }
];
const AVISOS = ['Pedido no enviado a cocina', 'Error de conexión: reintente', 'Cobro rechazado: sin red'];

export const Escena1Caos: React.FC<{ duracion: number }> = ({ duracion }) => {
  const frame = useCurrentFrame();
  const pulso = (Math.sin(frame / 4.5) + 1) / 2; // 0–1, ~1,4 latidos por segundo
  // Sacudida al aparecer cada aviso (frames 135, 160, 185), amortiguada
  const golpes = [135, 160, 185].map(f => Math.max(0, 1 - Math.abs(frame - f) / 10));
  const sacudida = Math.sin(frame * 2.7) * 14 * Math.max(...golpes);

  return (
    <Escena duracion={duracion} style={{ backgroundColor: COLOR.fondo, fontFamily: FUENTE.ui, color: COLOR.texto }}>
      {/* Viñeta roja que late */}
      <AbsoluteFill style={{ background: `radial-gradient(70% 55% at 50% 45%, rgba(239,68,68,${0.1 + pulso * 0.16}), transparent 70%)` }} />
      <AbsoluteFill style={{ boxShadow: `inset 0 0 ${140 + pulso * 120}px rgba(239,68,68,${0.25 + pulso * 0.35})` }} />

      <AbsoluteFill style={{ padding: `${ZONA_SEGURA.arriba}px ${ZONA_SEGURA.lados}px ${ZONA_SEGURA.abajo}px`, transform: `translateX(${sacudida}px)` }}>
        {/* Indicador «Sin conexión» */}
        <Aparecer desde={0} style={{ alignSelf: 'center' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 18, padding: '18px 34px', borderRadius: 999,
            background: COLOR.rojoSuave, border: `3px solid rgba(239,68,68,${0.5 + pulso * 0.5})`, color: COLOR.rojo,
            fontSize: 40, fontWeight: 800, letterSpacing: '0.08em', boxShadow: `0 0 ${20 + pulso * 40}px rgba(239,68,68,${0.35 + pulso * 0.3})`
          }}>
            <IconoWifiOff size={52} color={COLOR.rojo} grosor={2.4} />
            SIN CONEXIÓN
          </div>
        </Aparecer>

        {/* Frase 1 → frase 2 */}
        <div style={{ position: 'relative', marginTop: 90, height: 470 }}>
          <Aparecer desde={14} hasta={122} style={{ position: 'absolute', inset: 0 }}>
            <h1 style={titular}>¿Se cayó el <span style={{ color: COLOR.rojo }}>internet</span> en plena hora pico?</h1>
          </Aparecer>
          <Aparecer desde={124} style={{ position: 'absolute', inset: 0 }}>
            <h1 style={titular}>Mesas esperando,<br /><span style={{ color: COLOR.rojo }}>pedidos perdidos</span></h1>
          </Aparecer>
        </div>

        {/* Mesas en espera con contador en rojo (salen cuando llegan los avisos de error) */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 22, marginTop: 30 }}>
          {MESAS.map((mesa, i) => <TarjetaMesa key={mesa.nombre} {...mesa} desde={40 + i * 18} pulso={pulso} frame={frame} />)}
        </div>

        {/* Avisos de error que se apilan */}
        <div style={{ position: 'absolute', left: ZONA_SEGURA.lados, right: ZONA_SEGURA.lados, bottom: ZONA_SEGURA.abajo, display: 'flex', flexDirection: 'column', gap: 16 }}>
          {AVISOS.map((texto, i) => <Aviso key={texto} texto={texto} desde={130 + i * 25} />)}
        </div>
      </AbsoluteFill>
    </Escena>
  );
};

const titular: React.CSSProperties = {
  margin: 0, fontFamily: FUENTE.display, fontSize: 104, lineHeight: 1.08, fontWeight: 800, textAlign: 'center', letterSpacing: '-0.01em',
  textShadow: '0 6px 40px rgba(0,0,0,0.6)'
};

const TarjetaMesa: React.FC<{ nombre: string; espera: number; desde: number; pulso: number; frame: number }> = ({ nombre, espera, desde, pulso, frame }) => {
  const minutos = espera + Math.floor(Math.max(0, frame - desde) / 45); // la espera sigue subiendo
  return (
    <Aparecer desde={desde} hasta={128} distancia={40}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '26px 34px', borderRadius: 26,
        background: COLOR.superficie, border: `2px solid rgba(239,68,68,${0.35 + pulso * 0.4})`, borderLeft: `12px solid ${COLOR.rojo}`
      }}>
        <span style={{ fontSize: 46, fontWeight: 700 }}>{nombre}</span>
        <span style={{ fontSize: 38, fontWeight: 700, color: COLOR.rojo }}>esperando {minutos} min</span>
      </div>
    </Aparecer>
  );
};

const Aviso: React.FC<{ texto: string; desde: number }> = ({ texto, desde }) => {
  const frame = useCurrentFrame();
  const entrada = useEntrada(desde, { damping: 12, stiffness: 180, mass: 0.6 });
  const parpadeo = interpolate(Math.sin((frame - desde) / 3), [-1, 1], [0.75, 1]);
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 18, padding: '22px 28px', borderRadius: 20, opacity: entrada * parpadeo,
      transform: `translateX(${(1 - entrada) * 700}px)`, background: 'rgba(239,68,68,0.14)', border: `2px solid ${COLOR.rojo}`, color: '#FECACA', fontSize: 36, fontWeight: 600
    }}>
      <IconoAlerta size={44} color={COLOR.rojo} grosor={2.4} />
      {texto}
    </div>
  );
};
