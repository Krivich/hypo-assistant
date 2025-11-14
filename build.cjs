// build.cjs
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');

// Единая конфигурация — одна точка правды
const buildOptions = {
    loader: {
        ".html": "text",
        ".css": "text"
    },
    entryPoints: ['src/main.ts'],
    bundle: true,
    outfile: 'dist/HypoAssistant.js',
    format: 'iife',
    globalName: 'HypoAssistant',
    minify: false,
    target: 'es2022',
    platform: 'browser'
};

function copyOutputs() {
    const srcFile = 'dist/HypoAssistant.js';
    if (!fs.existsSync(srcFile)) return;
    const destinations = ['docs', 'hypo-extension'];
    for (const dir of destinations) {
        try {
            fs.copyFileSync(srcFile, path.join(dir, 'HypoAssistant.js'));
            console.log(`✅ Copied to ${dir}/HypoAssistant.js`);
        } catch (err) {
            console.warn(`⚠️  Skip copy to ${dir}: ${err.message}`);
        }
    }
}

function buildSync() {
    esbuild.buildSync(buildOptions);
    copyOutputs();
}

if (isWatch) {
    console.log('👀 Watch mode. Rebuilding on change...\n');
    esbuild.context(buildOptions).then(ctx => {
        ctx.watch();
        // Первая сборка
        buildSync();
    }).catch(console.error);
} else {
    buildSync();
}