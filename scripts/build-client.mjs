import esbuild from 'esbuild';
import path from 'node:path';

const root = process.cwd();

await esbuild.build({
  entryPoints: [path.join(root, 'src/client/firebaseUsers.ts')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2020'],
  minify: true,
  outfile: path.join(root, 'assets/js/firebase-users.js'),
});

console.log('Built assets/js/firebase-users.js');
