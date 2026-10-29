// Iconos SVG en línea (sin dependencias). Trazos de 2 px escalados con `size`.
type P = { size?: number; color?: string; grosor?: number };
const base = (size: number, color: string, grosor: number) => ({
  width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: color, strokeWidth: grosor, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const
});

export const IconoWifiOff: React.FC<P> = ({ size = 64, color = 'currentColor', grosor = 2 }) => (
  <svg {...base(size, color, grosor)}>
    <path d="M2 2l20 20" /><path d="M8.5 16.5a5 5 0 0 1 7 0" /><path d="M2 8.8a15 15 0 0 1 4.2-2.6" /><path d="M10.7 5.1A15 15 0 0 1 22 8.8" />
    <path d="M5 12.6a10 10 0 0 1 5.2-2.7" /><path d="M16.9 11.5A10 10 0 0 1 19 12.6" /><circle cx="12" cy="20" r="0.6" fill={color} />
  </svg>
);
export const IconoAlerta: React.FC<P> = ({ size = 64, color = 'currentColor', grosor = 2 }) => (
  <svg {...base(size, color, grosor)}><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4" /><circle cx="12" cy="17" r="0.6" fill={color} /></svg>
);
export const IconoRayo: React.FC<P> = ({ size = 64, color = 'currentColor', grosor = 2 }) => (
  <svg {...base(size, color, grosor)}><path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" /></svg>
);
export const IconoMesas: React.FC<P> = ({ size = 64, color = 'currentColor', grosor = 2 }) => (
  <svg {...base(size, color, grosor)}><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></svg>
);
export const IconoOffline: React.FC<P> = ({ size = 64, color = 'currentColor', grosor = 2 }) => (
  <svg {...base(size, color, grosor)}><rect x="4" y="3" width="16" height="18" rx="2.5" /><path d="M8 8h8M8 12h8M8 16h5" /><path d="m15 16 1.5 1.5L19 15" /></svg>
);
export const IconoNube: React.FC<P> = ({ size = 64, color = 'currentColor', grosor = 2 }) => (
  <svg {...base(size, color, grosor)}><path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 9.2 4.5 4.5 0 0 0 6.5 19h11z" /><path d="m9 14 2 2 4-4" /></svg>
);
export const IconoCheck: React.FC<P> = ({ size = 64, color = 'currentColor', grosor = 2.5 }) => (
  <svg {...base(size, color, grosor)}><path d="M20 6 9 17l-5-5" /></svg>
);
