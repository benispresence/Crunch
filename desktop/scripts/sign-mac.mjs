import { execFileSync } from 'node:child_process';
import path from 'node:path';

// electron-builder 25 does not support identity: "-". Sign the complete
// bundle after packing, before the ZIP is produced, including nested code.
export default async function signMac(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
}
