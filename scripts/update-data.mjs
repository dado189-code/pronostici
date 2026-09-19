import {readFileSync,existsSync} from 'node:fs';
// Daily refresh is idempotent. Explicit manual runs can refresh intraday.
const previous=existsSync('data/release.json')?JSON.parse(readFileSync('data/release.json','utf8')):null;
if(process.argv.includes('--refresh')||['workflow_dispatch','schedule'].includes(process.env.GITHUB_EVENT_NAME)||previous?.dataPipelineVersion!==1)process.env.FORCE_REFRESH='1';
await import('./release.mjs');
await import('./check-release.mjs');
