import { AbsoluteFill, Img, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { Aparecer, Escena, useEntrada } from '../components/Animacion';
import { COLOR, FUENTE, ZONA_SEGURA } from '../theme';

// 25–30 s: cierre de marca. Logo, eslogan y llamado a la acción; queda en pantalla hasta el último frame.
export const Escena4Cierre: React.FC<{ duracion: number }> = ({ duracion }) => {
  const frame = useCurrentFrame();
  const logo = useEntrada(4, { damping: 11, stiffness: 120, mass: 0.9 });
  const brillo = (Math.sin(frame / 8) + 1) / 2;
  const ondaCta = ((frame - 70) % 40) / 40; // anillo que se expande cada 1,3 s desde que aparece el botón

  return (
    <Escena duracion={duracion} fundido={10} salida={false} style={{ backgroundColor: COLOR.fondo, fontFamily: FUENTE.ui, color: COLOR.texto }}>
      <AbsoluteFill style={{ background: `radial-gradient(60% 40% at 50% 38%, rgba(255,140,50,${0.18 + brillo * 0.1}), transparent 70%)` }} />
      <AbsoluteFill style={{ padding: `${ZONA_SEGURA.arriba}px ${ZONA_SEGURA.lados}px ${ZONA_SEGURA.abajo}px`, alignItems: 'center', justifyContent: 'center', gap: 56, textAlign: 'center' }}>
        <div style={{
          width: 300, height: 300, borderRadius: 76, overflow: 'hidden', background: COLOR.grafito,
          border: '4px solid rgba(255,140,50,0.55)', boxShadow: `0 0 ${60 + brillo * 50}px rgba(255,140,50,0.35), 0 30px 80px rgba(0,0,0,0.6)`,
          opacity: logo, transform: `scale(${0.55 + logo * 0.45}) rotate(${(1 - logo) * -12}deg)`
        }}>
          <Img src={staticFile('logo.jpg')} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>

        <Aparecer desde={14}>
          <div style={{ fontFamily: FUENTE.display, fontSize: 132, fontWeight: 800, letterSpacing: '0.01em', lineHeight: 1 }}>
            Nexo<span style={{ color: COLOR.naranja }}>Bar</span>
          </div>
          <div style={{ marginTop: 14, fontSize: 36, fontWeight: 600, letterSpacing: '0.18em', color: COLOR.apagado }}>POS PARA BARES</div>
        </Aparecer>

        <Aparecer desde={34}>
          <p style={{ margin: 0, fontFamily: FUENTE.display, fontSize: 74, fontWeight: 700, lineHeight: 1.12 }}>
            Tu bar no se detiene,<br /><span style={{ color: COLOR.naranja }}>tu sistema tampoco.</span>
          </p>
        </Aparecer>

        <Aparecer desde={62} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 22 }}>
          <div style={{ position: 'relative' }}>
            {frame >= 70 && <span style={{ position: 'absolute', inset: 0, borderRadius: 999, border: `4px solid ${COLOR.naranja}`, transform: `scale(${1 + ondaCta * 0.25})`, opacity: 1 - ondaCta }} />}
            <div style={{ position: 'relative', padding: '30px 64px', borderRadius: 999, background: COLOR.naranja, color: COLOR.grafito, fontSize: 52, fontWeight: 800, boxShadow: '0 18px 50px rgba(255,140,50,0.45)' }}>
              Prueba la demo
            </div>
          </div>
          <div style={{ fontSize: 46, fontWeight: 700, color: COLOR.texto, opacity: interpolate(frame, [72, 84], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) }}>
            en <span style={{ color: COLOR.naranja }}>nexobar.netxpremium.com</span>
          </div>
        </Aparecer>
      </AbsoluteFill>
    </Escena>
  );
};
