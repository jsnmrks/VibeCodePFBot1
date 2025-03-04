// build.js
const esbuild = require('esbuild');
const path = require('path');

async function build() {
    try {
        const result = await esbuild.build({
            entryPoints: [
                'src/autoSniper.ts',
                'src/singleSniper.ts',
                'src/runAnalyzer.ts'
            ],
            bundle: true,
            platform: 'node',
            target: 'node16',
            outdir: 'dist',
            format: 'cjs',
            sourcemap: true,
            external: [
                '@solana/web3.js',
                '@solana/spl-token',
                '@solana-developers/helpers',
                'dotenv'
            ],
            logLevel: 'info',
            resolveExtensions: ['.ts', '.js'],
        });
        console.log('Build successful');
    } catch (error) {
        console.error('Build failed:', error);
        process.exit(1);
    }
}

build();
