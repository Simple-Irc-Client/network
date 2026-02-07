import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['./src/main.ts'],
  bundle: true,
  platform: 'node',
  outfile: 'irc-network.js',
  define: {
    'process.env.ENCRYPTION_KEY': JSON.stringify(process.env.ENCRYPTION_KEY || ''),
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV || 'production'),
  },
});
