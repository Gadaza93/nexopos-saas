import { AbsoluteFill, getStaticFiles, Html5Audio, Sequence, staticFile } from 'remotion';
import guion from '../scripts/guion.json';
import { Escena1Caos } from './scenes/Escena1Caos';
import { Escena2Fortalezas } from './scenes/Escena2Fortalezas';
import { Escena3Interfaz } from './scenes/Escena3Interfaz';
import { Escena4Cierre } from './scenes/Escena4Cierre';
import { COLOR, ESCENAS, FPS } from './theme';

// Locución por escena generada con `npm run voz` (scripts/generar-voz.mjs → public/voz/<id>.mp3).
// Cada bloque arranca en el frame `desde` + `inicio` del guion. Las escenas sin audio generado se omiten,
// así el video se puede renderizar aunque todavía no exista la voz.
const VOCES = guion.escenas.map(escena => ({ id: escena.id, archivo: `voz/${escena.id}.mp3`, frame: escena.desde + Math.round(escena.inicio * FPS) }));

// Composición principal: cuatro escenas consecutivas (cada una recibe frames relativos desde 0) y la voz en off
export const Comercial: React.FC = () => {
  const disponibles = new Set(getStaticFiles().map(archivo => archivo.name));
  return (
    <AbsoluteFill style={{ backgroundColor: COLOR.fondo }}>
      {VOCES.filter(voz => disponibles.has(voz.archivo)).map(voz => (
        <Sequence key={voz.id} from={voz.frame} name={`Voz · ${voz.id}`} layout="none">
          <Html5Audio src={staticFile(voz.archivo)} />
        </Sequence>
      ))}
      <Sequence from={ESCENAS.caos.desde} durationInFrames={ESCENAS.caos.duracion} name="1 · Caos sin internet">
        <Escena1Caos duracion={ESCENAS.caos.duracion} />
      </Sequence>
      <Sequence from={ESCENAS.fortalezas.desde} durationInFrames={ESCENAS.fortalezas.duracion} name="2 · Fortalezas">
        <Escena2Fortalezas duracion={ESCENAS.fortalezas.duracion} />
      </Sequence>
      <Sequence from={ESCENAS.interfaz.desde} durationInFrames={ESCENAS.interfaz.duracion} name="3 · Interfaz">
        <Escena3Interfaz duracion={ESCENAS.interfaz.duracion} />
      </Sequence>
      <Sequence from={ESCENAS.cierre.desde} durationInFrames={ESCENAS.cierre.duracion} name="4 · Cierre de marca">
        <Escena4Cierre duracion={ESCENAS.cierre.duracion} />
      </Sequence>
    </AbsoluteFill>
  );
};
