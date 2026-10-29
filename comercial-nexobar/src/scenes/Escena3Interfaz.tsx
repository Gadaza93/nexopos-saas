import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Aparecer, Escena, useContador, useEntrada } from '../components/Animacion';
import { IconoCheck, IconoNube } from '../components/Iconos';
import { COLOR, FUENTE, pesos, ZONA_SEGURA } from '../theme';

// 18–25 s: la interfaz en acción. Cobro rápido → arqueo exacto → vuelve la red y todo se sincroniza solo.
const ITEMS = [
  { nombre: 'Cerveza nacional ×4', valor: 28000 },
  { nombre: 'Picada mixta', valor: 42000 },
  { nombre: 'Limonada de coco ×2', valor: 16000 }
];
const TOTAL = ITEMS.reduce((s, i) => s + i.valor, 0); // 86.000
const CAJA = 1240000;
const F = { cobro: 62, arqueo: 78, arqueoListo: 128, red: 140, sincronizado: 176 }; // momentos clave (frames de la escena)

export const Escena3Interfaz: React.FC<{ duracion: number }> = ({ duracion }) => {
  const frame = useCurrentFrame();
  // Un titular por fase; cada uno entra subiendo y sale con fundido cuando llega el siguiente
  const titulares = [
    { texto: 'Cobra en segundos', desde: 0, hasta: F.arqueo },
    { texto: 'Arqueo de caja exacto', desde: F.arqueo, hasta: F.red },
    { texto: 'Vuelve la red: se sincroniza solo', desde: F.red, hasta: undefined }
  ];

  return (
    <Escena duracion={duracion} fundido={10} style={{ background: 'linear-gradient(180deg, #071a1a 0%, #0a0a0c 60%)', fontFamily: FUENTE.ui, color: COLOR.texto }}>
      <AbsoluteFill style={{ padding: `${ZONA_SEGURA.arriba}px ${ZONA_SEGURA.lados}px ${ZONA_SEGURA.abajo}px`, gap: 36 }}>
        <div style={{ position: 'relative', height: 176, flex: 'none' }}>
          {titulares.map(t => (
            <Aparecer key={t.texto} desde={t.desde} hasta={t.hasta} distancia={30} style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
              <h2 style={{ margin: 0, fontFamily: FUENTE.display, fontSize: 80, fontWeight: 800, lineHeight: 1.05, textAlign: 'center' }}>{t.texto}</h2>
            </Aparecer>
          ))}
        </div>

        <Aparecer desde={0} distancia={120}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 24, padding: 32, borderRadius: 44, background: COLOR.superficie, border: `2px solid ${COLOR.linea}`, boxShadow: '0 40px 90px rgba(0,0,0,0.55)' }}>
            <Cabecera frame={frame} />
            <PanelCobro frame={frame} />
            <PanelArqueo frame={frame} />
            <PanelSync frame={frame} />
          </div>
        </Aparecer>
      </AbsoluteFill>
    </Escena>
  );
};

const panel: React.CSSProperties = { padding: '24px 28px', borderRadius: 26, background: COLOR.superficie2, border: `2px solid ${COLOR.linea}` };
const etiqueta: React.CSSProperties = { fontSize: 28, fontWeight: 700, letterSpacing: '0.1em', color: COLOR.apagado, textTransform: 'uppercase' };

// Barra superior del POS con el indicador de sincronización
const Cabecera: React.FC<{ frame: number }> = ({ frame }) => {
  const estado = frame < F.red ? { texto: 'Sin conexión · 3 pendientes', color: COLOR.ambar }
    : frame < F.sincronizado ? { texto: 'Sincronizando…', color: COLOR.cian }
      : { texto: 'Sincronizado', color: COLOR.esmeralda };
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ width: 58, height: 58, borderRadius: 16, background: COLOR.grafito, border: `2px solid rgba(255,140,50,0.4)`, display: 'grid', placeItems: 'center', color: COLOR.naranja, fontFamily: FUENTE.display, fontSize: 34, fontWeight: 800 }}>N</div>
        <span style={{ fontSize: 38, fontWeight: 800 }}>Mesa 5</span>
      </div>
      <span style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 20px', borderRadius: 999, fontSize: 28, fontWeight: 700, color: estado.color, border: `2px solid ${estado.color}`, background: 'rgba(0,0,0,0.25)' }}>
        <span style={{ width: 16, height: 16, borderRadius: 99, background: estado.color, opacity: frame < F.sincronizado ? 0.5 + Math.abs(Math.sin(frame / 5)) * 0.5 : 1 }} />
        {estado.texto}
      </span>
    </div>
  );
};

const PanelCobro: React.FC<{ frame: number }> = ({ frame }) => {
  const total = useContador(TOTAL, 18, 50);
  const presion = interpolate(frame, [F.cobro - 4, F.cobro, F.cobro + 6], [1, 0.94, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const onda = interpolate(frame, [F.cobro, F.cobro + 18], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const pagado = frame >= F.cobro + 4;
  return (
    <div style={{ ...panel, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <span style={etiqueta}>Cobro rápido</span>
      {ITEMS.map((item, i) => (
        <Aparecer key={item.nombre} desde={6 + i * 6} distancia={24}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 34 }}><span>{item.nombre}</span><b>{pesos(item.valor)}</b></div>
        </Aparecer>
      ))}
      <div style={{ position: 'relative', marginTop: 8, height: 96, borderRadius: 22, overflow: 'hidden', transform: `scale(${presion})`,
        background: pagado ? COLOR.esmeralda : COLOR.naranja, color: COLOR.grafito, display: 'grid', placeItems: 'center', fontSize: 42, fontWeight: 800 }}>
        <span style={{ position: 'absolute', width: 900, height: 900, borderRadius: '50%', background: 'rgba(255,255,255,0.35)', transform: `scale(${onda})`, opacity: 1 - onda }} />
        <span style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: 14 }}>
          {pagado ? <><IconoCheck size={46} color={COLOR.grafito} grosor={3} /> Pagado · Efectivo</> : <>Cobrar {pesos(total)}</>}
        </span>
      </div>
    </div>
  );
};

const PanelArqueo: React.FC<{ frame: number }> = ({ frame }) => {
  const entrada = useEntrada(F.arqueo - 6);
  const contado = useContador(CAJA, F.arqueo + 4, F.arqueoListo - 6);
  const exacto = frame >= F.arqueoListo;
  return (
    <div style={{ ...panel, opacity: entrada, transform: `translateY(${(1 - entrada) * 40}px)`, display: 'flex', flexDirection: 'column', gap: 12,
      borderColor: exacto ? 'rgba(16,185,129,0.6)' : COLOR.linea }}>
      <span style={etiqueta}>Arqueo de caja</span>
      <Fila izquierda="Esperado en caja" derecha={pesos(CAJA)} />
      <Fila izquierda="Contado" derecha={pesos(contado)} />
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 38, fontWeight: 800, color: exacto ? COLOR.esmeralda : COLOR.apagado }}>
        <span>Diferencia</span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10 }}>{exacto && <IconoCheck size={40} color={COLOR.esmeralda} grosor={3} />}{exacto ? '$0 · Cuadrada' : '…'}</span>
      </div>
    </div>
  );
};
const Fila: React.FC<{ izquierda: string; derecha: string }> = ({ izquierda, derecha }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 34 }}><span style={{ color: COLOR.apagado }}>{izquierda}</span><b style={{ fontVariantNumeric: 'tabular-nums' }}>{derecha}</b></div>
);

const PanelSync: React.FC<{ frame: number }> = ({ frame }) => {
  const entrada = useEntrada(F.red - 6);
  const avance = interpolate(frame, [F.red, F.sincronizado], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const listo = frame >= F.sincronizado;
  const flotar = Math.sin(frame / 6) * 6;
  return (
    <div style={{ ...panel, opacity: entrada, transform: `translateY(${(1 - entrada) * 40}px)`, display: 'flex', alignItems: 'center', gap: 26,
      borderColor: listo ? 'rgba(16,185,129,0.6)' : 'rgba(6,182,212,0.45)' }}>
      <div style={{ transform: `translateY(${listo ? 0 : flotar}px)` }}><IconoNube size={92} color={listo ? COLOR.esmeralda : COLOR.cian} grosor={2.2} /></div>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <span style={{ fontSize: 34, fontWeight: 700 }}>{listo ? 'Todo respaldado en la nube' : `Subiendo ${Math.round(avance * 38)} de 38 ventas…`}</span>
        <div style={{ height: 14, borderRadius: 99, background: 'rgba(255,255,255,0.1)', overflow: 'hidden' }}>
          <div style={{ width: `${avance * 100}%`, height: '100%', background: listo ? COLOR.esmeralda : `linear-gradient(90deg, ${COLOR.cian}, ${COLOR.esmeralda})` }} />
        </div>
      </div>
    </div>
  );
};
