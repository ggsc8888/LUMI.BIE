// Bundles the one browser dependency (direct uploads to the private Blob store) so the page
// loads nothing from a third-party CDN at runtime.
import { build } from 'esbuild';

await build({
  stdin: { contents: "export { put } from '@vercel/blob/client';", resolveDir: process.cwd() },
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  outfile: 'public/vendor/blob-client.js', logLevel: 'warning',
});
console.log('built public/vendor/blob-client.js');
