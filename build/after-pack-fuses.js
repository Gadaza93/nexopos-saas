/* NexoPos · gancho afterPack de electron-builder: aplica los «fuses» de Electron al ejecutable ya empaquetado,
   antes de crear el instalador. Los fuses son interruptores grabados en NexoPos.exe que no se pueden cambiar en
   tiempo de ejecución: aquí se apagan las vías para ejecutar o inyectar código desde fuera de la app.
   - RunAsNode: con ELECTRON_RUN_AS_NODE=1 el .exe dejaría de ser la app y correría scripts de Node arbitrarios.
   - NODE_OPTIONS / --inspect: permitirían cargar código o adjuntar un depurador al proceso principal.
   - Solo app.asar + verificación de su integridad: una app.asar manipulada (o una carpeta app/ al lado) no arranca.
   No se toca GrantFileProtocolExtraPrivileges: la app carga index.html desde file://.
   Se ejecuta solo al compilar (npm run dist); @electron/fuses es dependencia de desarrollo, no va en el instalador. */
const path = require('path');
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses');

exports.default = async function afterPackFuses(context) {
  if (context.electronPlatformName !== 'win32') return;
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  await flipFuses(exe, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true
  });
  console.log(`  • fuses aplicados a ${path.basename(exe)}: RunAsNode, NODE_OPTIONS e --inspect desactivados; solo app.asar con integridad verificada`);
};
