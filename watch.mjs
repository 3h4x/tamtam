import fs from 'fs'; import pg from 'pg';
const url=fs.readFileSync('.env.local','utf8').match(/DATABASE_URL\s*=\s*"?([^"\n]+)"?/)[1];
const rid='tamtam-release-1780374246975000';
const deadline=Date.now()+600000; // 10 min cap
let last='';
while(Date.now()<deadline){
  const c=new pg.Client({connectionString:url}); await c.connect();
  const rows=await c.query("select id,kind,finished_at,exit_code,verdict from public.jobs where id=$1 or release_id=$1 order by started_at",[rid]);
  const rel=rows.rows.find(r=>r.kind==='release');
  const sig=rows.rows.map(r=>`${r.kind}:${r.finished_at?('done'+r.exit_code):'run'}${r.verdict?('/'+r.verdict):''}`).join(' ');
  await c.end();
  if(sig!==last){ console.log(new Date().toISOString().slice(11,19), sig); last=sig; }
  if(rel && rel.finished_at){ console.log('RELEASE FINALIZED exit='+rel.exit_code); break; }
  await new Promise(r=>setTimeout(r,8000));
}
