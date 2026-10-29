// Configuración de render: JPEG intermedio de alta calidad y MP4 H.264 compatible con TikTok, Reels y Shorts
import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('jpeg');
Config.setJpegQuality(95);
Config.setCodec('h264');
Config.setPixelFormat('yuv420p');
Config.setOverwriteOutput(true);
