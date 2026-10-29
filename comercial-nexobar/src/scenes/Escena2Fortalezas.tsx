import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Aparecer, Escena, useEntrada } from '../components/Animacion';
import { IconoMesas, IconoOffline, IconoRayo } from '../components/Iconos';
import { COLOR, FUENTE, ZONA_SEGURA } from '../theme';

// 8–18 s: el giro. Un círculo esmeralda/cian se abre sobre el caos y aparecen las tres fortalezas.
export const Escena2Fortalezas: React.FC<{ duracion: number }> = ({ duracion }) => {
  const frame = useCurrentFrame();
  const apertura = interpolate(frame, [0, 26], [0, 150], { extrapolateRight: 'clamp', easing: t => 1 - Math.pow(1 - t, 3) });
  const deriva = frame / 30;

  return (
    <Escena duracion={duracion} fundido={8} style={{ backgroundColor: COLOR.fondo, fontFamily: FUENTE.ui, color: COLOR.texto }}>
      <AbsoluteFill style={{ clipPath: `circle(${apertura}% at 50% 45%)`, background: 'linear-gradient(165deg, #04241f 0%, #053b3a 45%, #062f44 100%)' }}>
        {/* Luces que se desplazan lentamente */}
        <AbsoluteFill style={{ background: `radial-gradient(45% 30% at ${30 + Math.sin(deriva) * 12}% ${25 + Math.cos(deriva) * 6}%, rgba(16,185,129,0.45), transparent 70%)` }} />
        <AbsoluteFill style={{ background: `radial-gradient(45% 30% at ${72 + Math.cos(deriva * 0.8) * 10}% ${78 + Math.sin(deriva) * 5}%, rgba(6,182,212,0.4), transparent 70%)` }} />

        <AbsoluteFill style={{ padding: `${ZONA_SEGURA.arriba}px ${ZONA_SEGURA.lados}px ${ZONA_SEGURA.abajo}px`, gap: 34 }}>
          <Aparecer desde={18}>
            <p style={{ margin: 0, fontSize: 40, fontWeight: 700, letterSpacing: '0.14em', color: '#6EE7B7', textAlign: 'center' }}>CON NEXOBAR</p>
            <h2 style={{ margin: '10px 0 0', fontFamily: FUENTE.display, fontSize: 92, fontWeight: 800, lineHeight: 1.05, textAlign: 'center' }}>
              Tu bar sigue <span style={gradienteTexto}>vendiendo</span>
            </h2>
          </Aparecer>

          <Tarjeta desde={55} icono={<IconoOffline size={66} color="#04241f" grosor={2.4} />} titulo="100% Offline-First" detalle="Vende, cobra y cierra caja sin internet.">
            <Estado frame={frame} desde={85} />
          </Tarjeta>
          <Tarjeta desde={115} icono={<IconoMesas size={66} color="#04241f" grosor={2.4} />} titulo="Mesas en tiempo real" detalle="Libres y ocupadas, de un vistazo.">
            <MiniMesas frame={frame} desde={140} />
          </Tarjeta>
          <Tarjeta desde={175} icono={<IconoRayo size={66} color="#04241f" grosor={2.4} />} titulo="Cero retrasos en comanda" detalle="Del mesero a la barra en un toque.">
            <BarraComanda frame={frame} desde={200} />
          </Tarjeta>
        </AbsoluteFill>
      </AbsoluteFill>
    </Escena>
  );
};

const gradienteTexto: React.CSSProperties = {
  background: `linear-gradient(90deg, ${COLOR.esmeralda}, ${COLOR.cian})`, WebkitBackgroundClip: 'text', backgroundClip: 'text', color: 'transparent'
};

const Tarjeta: React.FC<{ desde: number; icono: React.ReactNode; titulo: string; detalle: string; children: React.ReactNode }> = ({ desde, icono, titulo, detalle, children }) => {
  const entrada = useEntrada(desde, { damping: 13, stiffness: 110, mass: 0.9 });
  return (
    <div style={{
      opacity: entrada, transform: `translateX(${(1 - entrada) * -220}px) rotate(${(1 - entrada) * -4}deg)`,
      display: 'flex', flexDirection: 'column', gap: 20, padding: '30px 34px', borderRadius: 34,
      background: 'rgba(10,10,12,0.55)', border: '2px solid rgba(110,231,183,0.35)', boxShadow: '0 24px 60px rgba(0,0,0,0.35)'
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 26 }}>
        <div style={{ flex: 'none', width: 104, height: 104, borderRadius: 28, display: 'grid', placeItems: 'center', background: `linear-gradient(135deg, ${COLOR.esmeralda}, ${COLOR.cian})` }}>{icono}</div>
        <div>
          <div style={{ fontSize: 54, fontWeight: 800, lineHeight: 1.1 }}>{titulo}</div>
          <div style={{ fontSize: 34, color: '#A7F3D0', marginTop: 6 }}>{detalle}</div>
        </div>
      </div>
      {children}
    </div>
  );
};

// Tarjeta 1: la venta se guarda aunque no haya red
const Estado: React.FC<{ frame: number; desde: number }> = ({ frame, desde }) => {
  const guardada = frame >= desde + 25;
  return (
    <div style={{ display: 'flex', gap: 14, fontSize: 30, fontWeight: 700 }}>
      <span style={{ ...chip, color: COLOR.ambar, borderColor: 'rgba(245,158,11,0.5)', opacity: frame >= desde ? 1 : 0 }}>● Sin internet</span>
      <span style={{ ...chip, color: COLOR.esmeralda, borderColor: 'rgba(16,185,129,0.6)', opacity: guardada ? 1 : 0, transform: `scale(${guardada ? 1 : 0.8})` }}>✓ Venta guardada en el equipo</span>
    </div>
  );
};
const chip: React.CSSProperties = { padding: '10px 18px', borderRadius: 999, border: '2px solid', background: 'rgba(0,0,0,0.25)' };

// Tarjeta 2: las mesas cambian de estado en vivo
const MiniMesas: React.FC<{ frame: number; desde: number }> = ({ frame, desde }) => {
  const ocupadas = [1, 3, 4, 6].filter((m, i) => frame >= desde + i * 12);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 14 }}>
      {[1, 2, 3, 4, 5, 6].map(m => {
        const ocupada = ocupadas.includes(m);
        return (
          <div key={m} style={{
            height: 74, borderRadius: 16, display: 'grid', placeItems: 'center', fontSize: 30, fontWeight: 800,
            background: ocupada ? 'rgba(239,68,68,0.2)' : 'rgba(16,185,129,0.18)', border: `2px solid ${ocupada ? COLOR.rojo : COLOR.esmeralda}`,
            color: ocupada ? '#FCA5A5' : '#6EE7B7'
          }}>{m}</div>
        );
      })}
    </div>
  );
};

// Tarjeta 3: la comanda llega a la barra en cuanto se toca «Enviar»
const BarraComanda: React.FC<{ frame: number; desde: number }> = ({ frame, desde }) => {
  const avance = interpolate(frame, [desde, desde + 18], [0, 100], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 20, fontSize: 30, fontWeight: 700 }}>
      <span>Mesero</span>
      <div style={{ flex: 1, height: 16, borderRadius: 999, background: 'rgba(255,255,255,0.12)', overflow: 'hidden' }}>
        <div style={{ width: `${avance}%`, height: '100%', background: `linear-gradient(90deg, ${COLOR.esmeralda}, ${COLOR.cian})` }} />
      </div>
      <span style={{ color: avance >= 100 ? '#67E8F9' : COLOR.texto }}>{avance >= 100 ? 'Barra ✓' : 'Barra'}</span>
    </div>
  );
};
