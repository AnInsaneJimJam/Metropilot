// Recorded Monad mainnet fixtures; failure injection and durable recovery use a real, disposable PostgreSQL DB.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { after, before, describe, test } from 'node:test';
import pg from 'pg';
import { MARKETS, checkedObservation, validateSwapLog } from '@monad-hack/connectors';
import type { Market } from '@monad-hack/connectors';
import { MarketIngestion } from './market-ingestion.ts';
import type { MarketSource, MarketLog } from './market-ingestion.ts';
import { migrate } from './db/migrate.ts';
import { seedPaper } from './db/seed.ts';
const read = (file: string) => JSON.parse(readFileSync(new URL(file, import.meta.url),'utf8'));
const fixtures = MARKETS.map(m=>read(`../../../packages/contracts/fixtures/priceObservation/valid/${m.protocol}.json`));
const rawLogs = read('../../../packages/connectors/src/fixtures/curve-logs.json');
const head = BigInt(fixtures[0].block.number);
const hash = (n: bigint): string => n === head ? fixtures[0].block.hash : rawLogs.find((l: {blockNumber:string})=>BigInt(l.blockNumber)===n)?.blockHash ?? '0x'+n.toString(16).padStart(64,'0');
function source(): MarketSource {
  return {
    finalized: async()=>({number:head,hash:hash(head)}), block:async(n)=>({number:n,hash:hash(n)}), verify:async()=>{},
    logs: async(m,from,to)=>m.protocol==='uniswap-v3'?[]:rawLogs.filter((l:{blockNumber:string})=>BigInt(l.blockNumber)>=from&&BigInt(l.blockNumber)<=to).map((l: Record<string,unknown>)=>({...l,blockNumber:BigInt(l['blockNumber'] as string)})),
    observe:async(m,n)=>{
      const f=structuredClone(fixtures[MARKETS.findIndex(x=>x.feedRef===m.feedRef)]);
      f.block={...f.block,number:String(n),hash:hash(n)};
      f.sourceEventKey=`143:${m.pool}:${hash(n)}:${m.method}`;
      return checkedObservation(f);
    },
  };
}
const skip=!process.env['DATABASE_URL'];
if(skip&&process.env['REQUIRE_DB']==='1')throw new Error('REQUIRE_DB=1 needs DATABASE_URL');
describe('finalized market ingestion / PostgreSQL',{skip},()=>{
  let pool:pg.Pool, admin:pg.Client;
  const disconnected: Promise<void>[] = [];
  const name='market_'+randomBytes(6).toString('hex');
  before(async()=>{
    admin=new pg.Client({connectionString:process.env['DATABASE_URL']});await admin.connect();await admin.query(`create database ${name}`);
    const url=new URL(process.env['DATABASE_URL']!);url.pathname='/'+name;
    pool=new pg.Pool({connectionString:url.toString()});
    // pg-pool end() resolves before idle sockets close. Wait for their end events before DROP FORCE.
    pool.on('connect', client => disconnected.push(new Promise(resolve => client.once('end', resolve))));
    const c=await pool.connect();try{await migrate(c);await seedPaper(c);}finally{c.release();}
  });
  after(async()=>{await pool?.end();await Promise.all(disconnected);await admin?.query(`drop database if exists ${name} with (force)`);await admin?.end();});
  const reset=async()=>pool.query('truncate market_cursors, finalized_market_observations, finalized_market_logs');
  test('recorded Curve swap ABI, quiet heartbeat, immutable provenance, restart and duplicate replay',async()=>{
    await reset();
    validateSwapLog(MARKETS[1],rawLogs[0]);
    const accepted:string[]=[];
    const worker=new MarketIngestion(pool,source(),async(o)=>{accepted.push(o.sourceEventKey);return [];}, MARKETS);
    await worker.tick();
    assert.equal((await pool.query('select * from market_cursors')).rowCount,2);
    assert.equal((await pool.query('select * from finalized_market_logs')).rowCount,rawLogs.length);
    assert.ok(accepted.length>=3); // Uniswap quiet heartbeat; Curve swap block and heartbeat
    const count=accepted.length;
    await new MarketIngestion(pool,source(),async()=>{throw new Error('must not redeliver advanced cursor');}, MARKETS).tick();
    assert.equal(accepted.length,count);
    await assert.rejects(pool.query("update finalized_market_observations set document='{}'"));
  });
  test('crash after persistence replays fan-out before advancing the subscription cursor',async()=>{
    await reset();
    const m=MARKETS[0],s=source(),h=await s.finalized();
    await assert.rejects(new MarketIngestion(pool,s,async()=>{throw new Error('crash');}).process(m,h),/crash/);
    assert.equal((await pool.query('select * from market_cursors')).rowCount,0);
    assert.equal((await pool.query('select * from finalized_market_observations')).rowCount,1);
    let replay=0;await new MarketIngestion(pool,s,async()=>{replay++;return [];}).process(m,h);
    assert.equal(replay,1);assert.equal((await pool.query('select * from finalized_market_observations')).rowCount,1);
  });
  test('removed, noncanonical and out-of-range logs never reach triggers',async()=>{
    for(const patch of [{removed:true},{blockHash:'0x'+'aa'.repeat(32)},{blockNumber:head+1n}]){
      await reset();const s=source();const original=s.logs;
      s.logs=async(m,f,t)=>(await original(m,f,t)).map(l=>({...l,...patch}));
      let count=0;
      await assert.rejects(new MarketIngestion(pool,s,async()=>{count++;return [];}).process(MARKETS[1],await s.finalized()));
      assert.equal(count,0);assert.equal((await pool.query('select * from market_cursors')).rowCount,0);
    }
  });
  test('fresh heads continue while a historical oracle read stalls and fails, without moving its cursor', async(t)=>{
    await reset();t.mock.timers.enable({apis:['Date'],now:Date.now()});
    const market=MARKETS[1],s=source(),original=s.observe;
    let current=head;
    s.finalized=async()=>({number:current,hash:hash(current)});
    const start=BigInt(rawLogs[0].blockNumber)-100n;
    await pool.query('insert into market_cursors values ($1,$2,$3,now())',[market.feedRef,String(start),hash(start)]);
    let release!:()=>void,entered!:()=>void;
    const stalled=new Promise<void>(resolve=>{release=resolve;}), reading=new Promise<void>(resolve=>{entered=resolve;});
    s.observe=async(m,n)=>{
      if(n<head){entered();await stalled;throw new Error('RPC https://provider.invalid/?key=private-marker failed');}
      const now=new Date().toISOString();return checkedObservation({...await original(m,n),observedAt:now,receivedAt:now});
    };
    const accepted:bigint[]=[],reports:Record<string,unknown>[]=[];
    const worker=new MarketIngestion(pool,s,async(o)=>{accepted.push(BigInt(checkedObservation(o).block.number));return [];},[market],entry=>reports.push(entry));
    const recoveryFailed=assert.rejects(worker.tick(),/provider.invalid/);
    await reading;
    try {
      await worker.refresh();assert.deepEqual(accepted,[head]);
      t.mock.timers.tick(6000);current++;
      await worker.refresh();assert.deepEqual(accepted,[head,head+1n]);
      assert.equal((await pool.query('select block_number::text from market_cursors')).rows[0].block_number,String(start));
    } finally {release();await recoveryFailed;}
    assert.ok(reports.some(r=>r.event==='market.ingestion.failed'&&r.feedRef===market.feedRef&&r.phase==='recovery'&&r.code==='SOURCE_OR_STORAGE_FAILURE'));
    assert.ok(!JSON.stringify(reports).includes('private-marker'));
  });
  test('failure logs distinguish cursor changes, oversized batches and contradictory oracle results',async()=>{
    const market=MARKETS[0];
    for(const code of ['FINALIZED_CURSOR_CHANGED','LOG_BATCH_LIMIT','ORACLE_RESULT_CONFLICT']){
      await reset();const s=source(),reports:Record<string,unknown>[]=[];
      if(code==='FINALIZED_CURSOR_CHANGED'){
        await pool.query('insert into market_cursors values ($1,$2,$3,now())',[market.feedRef,String(head-100n),hash(head-100n)]);
        s.block=async(n)=>({number:n,hash:'0x'+'ab'.repeat(32)});
      } else if(code==='LOG_BATCH_LIMIT'){
        s.logs=async()=>Array.from({length:2049},()=>({...rawLogs[0],blockNumber:head}));
      } else {
        const observation=await s.observe(market,head);
        await pool.query('insert into finalized_market_observations values ($1,$2,$3)',[market.feedRef,observation.sourceEventKey,observation]);
        s.observe=async()=>({...observation,provenanceHash:'0x'+'ab'.repeat(32)});
      }
      const worker=new MarketIngestion(pool,s,async()=>[],[market],entry=>reports.push(entry));
      await assert.rejects(worker.tick(),(error:unknown)=>(error as {code:string}).code===code);
      assert.deepEqual(reports.filter(r=>r.event==='market.ingestion.failed'),[{event:'market.ingestion.failed',phase:'recovery',feedRef:market.feedRef,code}]);
    }
  });
  test('bounded reconnect backfill and changed finalized cursor fail closed',async()=>{
    await reset();const s=source();let to:bigint|undefined;
    s.logs=async(_m,_f,t)=>{to=t;return [];};
    const start=head-1000n;await pool.query('insert into market_cursors values ($1,$2,$3,now())',[MARKETS[0].feedRef,String(start),hash(start)]);
    const worker=new MarketIngestion(pool,s,async()=>[],[MARKETS[0]]);await worker.process(MARKETS[0],await s.finalized());await worker.refresh();assert.equal(to,start+100n);
    assert.equal((await pool.query('select block_number::text from market_cursors where feed_ref=$1',[MARKETS[0].feedRef])).rows[0].block_number,String(start+100n));
    assert.equal((await pool.query("select 1 from finalized_market_observations where feed_ref=$1 and document->'block'->>'number'=$2",[MARKETS[0].feedRef,String(head)])).rowCount,1);
    s.block=async(n)=>({number:n,hash:'0x'+'aa'.repeat(32)});
    await assert.rejects(worker.process(MARKETS[0],await s.finalized()),/cursor hash changed/);
  });
});
