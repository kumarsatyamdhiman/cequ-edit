// Stand-in for `npm run build` in tests: copies page.html to dist/index.html. FAIL=1 fails; SLOW=1 never ends.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
if (process.env.SLOW) setInterval(() => {}, 1000);
else if (process.env.FAIL) { console.log('building…'); console.error('src/App.tsx(3,7): error TS2322: boom'); process.exit(2); }
else {
  console.log('vite building for production…');
  mkdirSync('dist/assets', { recursive: true });
  writeFileSync('dist/index.html', readFileSync('page.html', 'utf8'));
  writeFileSync('dist/assets/app.js', 'console.log(1)');
  writeFileSync('dist/built-in.txt', process.cwd());
  console.log('✓ built');
}
