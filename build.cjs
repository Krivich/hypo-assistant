const esbuild = require('esbuild');

esbuild.buildSync({
    entryPoints: ['src/main.ts'],
    bundle: true,
    outfile: 'dist/HypoAssistant.js',
    format: 'iife',
    globalName: 'HypoAssistant',
    minify: false,
    target: 'es2022',
    platform: 'browser'
});