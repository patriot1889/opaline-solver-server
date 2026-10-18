import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import https from 'node:https';
const temp = await mkdtemp(join(tmpdir(),'opaline-docker-'));
const secret = randomBytes(32).toString('hex');
const root = fileURLToPath(new URL('../', import.meta.url));
const project = `opaline-smoke-${randomBytes(4).toString('hex')}`;
let output = '';
const file = join(temp,'compose.yaml');
function compose(...args) {
  try { return execFileSync('docker', ['compose','--project-name',project,'-f',file,...args], { encoding:'utf8', stdio:['ignore','pipe','pipe'], timeout:300000 }); }
  catch (error) { output += error.stdout ?? ''; output += error.stderr ?? ''; throw new Error(`docker compose ${args[0]} failed`); }
}
function request(path, body) {
  return new Promise((resolve,reject) => {
    const req = https.request({ hostname:'localhost', port:18443, path, method:'POST', rejectUnauthorized:false, headers:{'content-type':'application/json'} }, res => {
      let text=''; res.on('data',c=>{text+=c}); res.on('end',()=>resolve({status:res.statusCode,text}));
    });
    req.on('error',reject);req.setTimeout(20000,()=>req.destroy(new Error('timeout')));req.end(JSON.stringify(body));
  });
}
try {
  let config = await readFile(new URL('../Caddyfile',import.meta.url),'utf8');
  config = config.replace('{','{\n admin off\n skip_install_trust\n auto_https disable_redirects');
  await writeFile(join(temp,'Caddyfile'), config);
  await writeFile(file, `services:
  solver:
    build: ${JSON.stringify(root)}
    environment:
      SOLVER_SECRET: ${secret}
      WARMUP: "false"
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: [no-new-privileges:true]
  caddy:
    image: caddy:2.11.2-alpine
    environment:
      SOLVER_DOMAIN: localhost:18443
      SOLVER_SECRET: ${secret}
    ports: ["127.0.0.1:18443:18443"]
    volumes:
      - ${JSON.stringify(join(temp,'Caddyfile')+':/etc/caddy/Caddyfile:ro')}
    depends_on: [solver]
`);
  compose('up','--build','--detach','--wait','--wait-timeout','90');
  let ready=false;
  for(let i=0;i<80;i++) { try {if((await request('/wrong/sts',{})).status===404){ready=true;break}}catch{} await new Promise(r=>setTimeout(r,100)); }
  assert.ok(ready,'HTTPS listener did not start');
  const jsUrl='/s/player/0229cd64/tv-player-ias-tcl.vflset/tv-player-ias-tcl.js';
  for (const [path,body,field] of [
    ['sts',{jsUrl},'sts'], ['solve',{jsUrl,n:['opalinewarmup12345678']},'solved'],
    ['get_pot',{content_binding:'opalinewarmup12345678',client:'TVHTML5'},'poToken']
  ]) { const response=await request(`/${secret}/${path}`,body);assert.equal(response.status,200,`${path}: ${response.text}`);assert.ok(JSON.parse(response.text)[field]); }
  for(const path of ['/health/live','/health/ready',`/${secret}/health/live`,'/invalid/solve']) assert.equal((await request(path,{})).status,404);
  compose('stop','solver');
  assert.equal((await request(`/${secret}/sts`,{jsUrl})).status,502);
  output += compose('logs','--no-color');
  assert.ok(!output.includes(secret),'Secret found in container logs');
  assert.ok(!output.includes('opalinewarmup12345678'),'Binding/challenge found in container logs');
  console.log('Docker HTTPS smoke passed (includes live YouTube probes; excludes signed-in media delivery).');
} catch(error) {
  console.error(error.message.replaceAll(secret,'[redacted]'));
  if(output)console.error(output.replaceAll(secret,'[redacted]'));
  process.exitCode=1;
} finally {
  try {compose('down','--volumes','--remove-orphans');} catch {}
  await rm(temp,{recursive:true,force:true});
}
