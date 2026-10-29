import { Composition } from 'remotion';
import { Comercial } from './Comercial';
import { DURACION_TOTAL, FPS } from './theme';

// 1080x1920 (9:16) · 30 fps · 900 frames = 30 s
export const RemotionRoot: React.FC = () => (
  <Composition
    id="ComercialNexoBar"
    component={Comercial}
    durationInFrames={DURACION_TOTAL}
    fps={FPS}
    width={1080}
    height={1920}
  />
);
