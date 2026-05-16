import { useState, useEffect, useCallback, useRef, useMemo } from "react";

const API_BASE           = "https://web-production-cedf2.up.railway.app";
const SUPABASE_ENABLED = true;
const USER_ID = "nftking";  // change to any unique ID you want
const SCAN_INTERVAL      = 30000;
const PAGE_SIZE          = 25;
const MAKER_REWARD_DAILY = 0.0005; // 0.05%/day conservative maker reward estimate
const DEFAULT_CAPITAL    = 50;     // default farm capital in USD
const EXIT_THRESHOLD     = 0.07;   // 7 cent default exit alert

// ─── THEMES ──────────────────────────────────────────────────────────────────
const LIGHT = {
  paper:"#faf8f4", paper2:"#f4f1eb", paper3:"#ede9e0",
  ink:"#1a1a2e", inkMid:"#2d2d4a", inkLight:"#6b6b8a", inkFaint:"#a8a8c0",
  rule:"#d8d4c8",
  coral:"#e8472a", coralBg:"#fdf1ee",
  navy:"#0f2347", navyBg:"#eef2f8",
  green:"#1a6b3a", greenBg:"#eef7f2",
  amber:"#b85c00", amberBg:"#fef6ee",
  red:"#cc1111", redBg:"#fdf0f0",
  purple:"#6b3fa0", purpleBg:"#f4eeff",
};
const DARK = {
  paper:"#0d0f14", paper2:"#111318", paper3:"#161a22",
  ink:"#e8eef8", inkMid:"#c5d0e0", inkLight:"#7a8fa8", inkFaint:"#3a4a5e",
  rule:"#1e2a3a",
  coral:"#ff5a3d", coralBg:"#1f0e0a",
  navy:"#4488dd", navyBg:"#0a1525",
  green:"#33cc6e", greenBg:"#071a0f",
  amber:"#ffaa44", amberBg:"#1a0f00",
  red:"#ff4444", redBg:"#1a0505",
  purple:"#aa77ff", purpleBg:"#1a0f2a",
};

// ─── PRESETS ──────────────────────────────────────────────────────────────────
const VOL_PRESETS = [
  { label:"All", min:0, max:Infinity },
  { label:"< $1K", min:0, max:1000 },
  { label:"$1K – $10K", min:1000, max:10000 },
  { label:"$10K – $50K", min:10000, max:50000 },
  { label:"$50K – $250K", min:50000, max:250000 },
  { label:"$250K – $1M", min:250000, max:1000000 },
  { label:"> $1M", min:1000000, max:Infinity },
];
const LIQ_PRESETS = [
  { label:"All", min:0, max:Infinity },
  { label:"< $500", min:0, max:500 },
  { label:"$500 – $2K", min:500, max:2000 },
  { label:"$2K – $10K", min:2000, max:10000 },
  { label:"$10K – $50K", min:10000, max:50000 },
  { label:"$50K – $250K", min:50000, max:250000 },
  { label:"> $250K", min:250000, max:Infinity },
];
const CATS  = ["All","Crypto","Politics","Sports","Science","Business","Other"];
const SORTS = [["score","LP Score"],["farm","Farm Score"],["volume","Volume"],["liquidity","Liquidity"],["days","Days Left"]];

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function daysLeft(d) {
  if (!d) return 0;
  return Math.max(0, Math.round((new Date(d) - new Date()) / 86400000));
}
function urgencyColor(days, T) {
  if (days <= 7)  return T.red;
  if (days <= 30) return T.amber;
  return T.inkFaint;
}
function urgencyBg(days, T) {
  if (days <= 7)  return T.redBg;
  if (days <= 30) return T.amberBg;
  return "transparent";
}
function scoreColor(s, T) { return s>=75?T.green:s>=50?T.amber:T.coral; }
function scoreBg(s, T)    { return s>=75?T.greenBg:s>=50?T.amberBg:T.coralBg; }
function farmColor(s, T)  { return s>=75?T.purple:s>=50?T.navy:T.inkFaint; }
function farmBg(s, T)     { return s>=75?T.purpleBg:s>=50?T.navyBg:"transparent"; }
function fmtUSD(n) {
  if (!n || isNaN(n)) return "$0";
  if (n>=1_000_000) return `$${(n/1_000_000).toFixed(1)}M`;
  if (n>=1_000)     return `$${(n/1_000).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}
function pct(n) { return `${(n*100).toFixed(1)}%`; }

// ── LP Score (general, existing logic) ──

// ── FARM Score (new — optimised for maker reward farming with small capital) ──
// Weights:
//   Pool share (35%)  — how much of pool does DEFAULT_CAPITAL buy?
//   Stability (30%)   — how stable have odds been across scans?
//   Volume pattern (15%) — steady low vol preferred over spiky
//   Time horizon (20%) — longer = more reward accumulation
function calcFarmScore(market, priceHistory) {
  const { yes, liquidity, endDate, volume } = market;

  // 1. Pool share — ideal: $50 captures >5% of pool
  const poolShare = liquidity > 0 ? DEFAULT_CAPITAL / (liquidity + DEFAULT_CAPITAL) : 0;
  const poolScore = Math.min(1.0, poolShare * 8); // 12.5%+ share = full score

  // 2. Stability — stdev of yes prices across history
  const hist = (priceHistory || []).map(p => p.yes).filter(Boolean);
  let stabilityScore = 0.5; // neutral if no history yet
  if (hist.length >= 2) {
    const mean  = hist.reduce((a,b)=>a+b,0) / hist.length;
    const stdev = Math.sqrt(hist.reduce((a,b)=>a+(b-mean)**2,0) / hist.length);
    // stdev of 0 = perfect stability, stdev of 0.1+ = too volatile
    stabilityScore = Math.max(0, 1 - stdev * 20);
  }

  // 3. Volume pattern — want some volume (rewards exist) but not massive spikes
  //    sweet spot: $500–$50K daily. Too low = no rewards, too high = competition
  const volScore = volume < 100 ? 0.1
    : volume < 500   ? 0.4
    : volume < 5000  ? 0.8
    : volume < 50000 ? 1.0
    : volume < 250000? 0.6
    : 0.3;

  // 4. Time horizon — need enough time to accumulate rewards
  const days = daysLeft(endDate);
  const timeScore = days < 7  ? 0.0
    : days < 14  ? 0.2
    : days < 30  ? 0.5
    : days < 60  ? 0.8
    : 1.0;

  // 5. Balance bonus — must be near 50/50 for reward eligibility
  const balance = 1 - Math.abs(yes - 0.5) * 2;
  if (balance < 0.5) return 0; // disqualify lopsided markets entirely

  const raw = poolScore*0.35 + stabilityScore*0.30 + volScore*0.15 + timeScore*0.20;
  return Math.round(raw * 100);
}

function calcAPY(liquidity, balance) {
  if (!liquidity || liquidity === 0) return null;
  const b = balance !== undefined ? balance : 0.7;
  return (MAKER_REWARD_DAILY * b * 365 * 100).toFixed(1);
}

function calcPoolShare(capital, liquidity) {
  if (!liquidity) return 0;
  return ((capital / (liquidity + capital)) * 100).toFixed(2);
}

// ─── GROUP MARKETS ────────────────────────────────────────────────────────────
function groupMarkets(markets) {
  const groups = {};
  markets.forEach(m => {
    const parts = (m.slug || "").split("-");
    const key = parts.slice(0, Math.min(4, parts.length)).join("-");
    if (!groups[key]) groups[key] = [];
    groups[key].push(m);
  });
  const result = [], standalone = [];
  Object.values(groups).forEach(g => {
    if (g.length >= 3) result.push({ type:"group", markets:g, key:g[0].slug });
    else g.forEach(m => standalone.push({ type:"single", market:m, key:m.id }));
  });
  return [...standalone, ...result];
}

// ─── SPARKLINE ────────────────────────────────────────────────────────────────
function Sparkline({ data, color, width=60, height=20 }) {
  if (!data || data.length < 2) return <span style={{fontSize:9,color:"#aaa"}}>—</span>;
  const min=Math.min(...data), max=Math.max(...data), range=max-min||1;
  const pts = data.map((v,i)=>`${(i/(data.length-1))*width},${height-((v-min)/range)*height}`).join(" ");
  const last = pts.split(" ").pop().split(",");
  return (
    <svg width={width} height={height} style={{display:"block"}}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round"/>
      <circle cx={last[0]} cy={last[1]} r="2" fill={color}/>
    </svg>
  );
}

// ─── DROPDOWN FILTER ──────────────────────────────────────────────────────────
function FilterDropdown({ label, presets, selected, onSelect, T }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = e => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div className="dropdown-wrap" ref={ref}>
      <button className={`filter-btn ${selected!==0?"active":""} ${open?"open":""}`} onClick={()=>setOpen(v=>!v)}>
        {label}: <strong>{presets[selected].label}</strong> <span className="caret">▼</span>
      </button>
      {open && (
        <div className="dropdown-menu">
          {presets.map((p,i)=>(
            <button key={i} className={`dropdown-item ${selected===i?"selected":""}`}
              onClick={()=>{ onSelect(i); setOpen(false); }}>{p.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── LP POSITION SIMULATOR ───────────────────────────────────────────────────
function Simulator({ market, T }) {
  const [amount, setAmount] = useState(DEFAULT_CAPITAL);
  const [open,   setOpen]   = useState(false);
  const days     = daysLeft(market.endDate);
  const balance  = 1 - Math.abs(market.yes - 0.5) * 2;
  const share    = market.liquidity > 0 ? amount / (market.liquidity + amount) : 0;
  const dailyRew = amount * MAKER_REWARD_DAILY * balance;
  const totalRew = dailyRew * days;
  const ilLoss   = amount * Math.abs(market.yes - 0.5) * 1.4;
  const net      = totalRew - ilLoss;
  const netPct   = amount > 0 ? ((net / amount) * 100).toFixed(1) : 0;
  const positive = net >= 0;
  return (
    <div style={{marginTop:10}}>
      <button onClick={()=>setOpen(v=>!v)} style={{
        background:"transparent", border:`1px solid ${T.rule}`,
        color:T.inkLight, borderRadius:2, padding:"5px 12px",
        fontFamily:"'DM Mono',monospace", fontSize:9,
        letterSpacing:"0.1em", cursor:"pointer", textTransform:"uppercase",
        width:"100%", textAlign:"left", display:"flex", justifyContent:"space-between",
      }}>
        <span>💰 LP Position Simulator</span><span>{open?"▲":"▼"}</span>
      </button>
      {open && (
        <div style={{marginTop:8,padding:12,background:T.paper2,border:`1px solid ${T.rule}`,borderRadius:3,animation:"fadeUp .2s ease both"}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
            <span style={{fontSize:10,color:T.inkFaint,fontFamily:"'DM Mono',monospace"}}>Capital ($)</span>
            <input type="number" min={5} max={100000} step={5} value={amount}
              onChange={e=>setAmount(Math.max(5,+e.target.value))}
              style={{width:90,padding:"4px 8px",borderRadius:2,border:`1px solid ${T.rule}`,background:T.paper,color:T.ink,fontFamily:"'DM Mono',monospace",fontSize:11}}/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
            {[
              {label:"Pool Share",   value:`${(share*100).toFixed(2)}%`,              color:T.navy},
              {label:"Est. APY",     value:`~${calcAPY(market.liquidity, balance)}%`, color:T.green},
              {label:"Maker Reward", value:`+${fmtUSD(totalRew)}`,                    color:T.green},
              {label:"Max IL Risk",  value:`-${fmtUSD(ilLoss)}`,                      color:T.coral},
              {label:`Net (${days}d)`,value:`${positive?"+":""}${fmtUSD(net)}`,       color:positive?T.green:T.coral},
              {label:"Return %",    value:`${netPct}%`,                               color:positive?T.green:T.coral},
            ].map(r=>(
              <div key={r.label} style={{background:T.paper,border:`1px solid ${T.rule}`,borderRadius:2,padding:"7px 10px"}}>
                <div style={{fontSize:8,color:T.inkFaint,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:3}}>{r.label}</div>
                <div style={{fontFamily:"'Playfair Display',serif",fontSize:15,fontWeight:700,color:r.color}}>{r.value}</div>
              </div>
            ))}
          </div>
          <div style={{marginTop:8,fontSize:9,color:T.inkFaint,fontFamily:"'DM Mono',monospace",lineHeight:1.6}}>
            Based on {days}d left · {fmtUSD(market.liquidity)} pool · maker reward model
          </div>
        </div>
      )}
    </div>
  );
}

// ─── POSITION MONITOR ────────────────────────────────────────────────────────
function PositionMonitor({ positions, allMarkets, priceHistory, onRemove, onUpdateThreshold, T }) {
  if (positions.length === 0) return (
    <div style={{padding:20,textAlign:"center",color:T.inkFaint,fontFamily:"'DM Mono',monospace",fontSize:11,lineHeight:1.8}}>
      <div style={{fontSize:32,marginBottom:8,opacity:.3}}>◎</div>
      No active positions.<br/>Add markets from the scanner<br/>to monitor odds drift.
    </div>
  );
  return (
    <div>
      {positions.map(pos => {
        const market = allMarkets.find(m=>m.id===pos.id);
        if (!market) return null;
        const current  = market.yes;
        const drift    = Math.abs(current - pos.entryYes);
        const drifted  = drift >= pos.threshold;
        const hist     = (priceHistory[market.id]||[]).map(p=>p.yes);
        const days     = daysLeft(market.endDate);
        const balance  = 1 - Math.abs(current - 0.5) * 2;

        return (
          <div key={pos.id} style={{
            border:`1px solid ${drifted?T.red:T.rule}`,
            borderRadius:3, marginBottom:12, overflow:"hidden",
            background: drifted ? T.redBg : T.paper2,
            transition:"all .3s",
          }}>
            {/* header */}
            <div style={{padding:"10px 14px",borderBottom:`1px solid ${drifted?T.red+"44":T.rule}`}}>
              <div style={{fontSize:11,fontWeight:600,color:drifted?T.red:T.ink,fontFamily:"'DM Sans',sans-serif",marginBottom:6,lineHeight:1.4}}>
                {drifted && "⚠ EXIT ALERT — "}
                {market.question.length>60?market.question.slice(0,60)+"…":market.question}
              </div>
              <div style={{display:"flex",gap:10,fontSize:10,fontFamily:"'DM Mono',monospace",flexWrap:"wrap",alignItems:"center"}}>
                <span style={{color:T.green}}>Entry YES: {(pos.entryYes*100).toFixed(1)}¢</span>
                <span style={{color:drifted?T.red:T.ink}}>Now: {(current*100).toFixed(1)}¢</span>
                <span style={{color:drifted?T.red:T.amber,fontWeight:600}}>Drift: {(drift*100).toFixed(1)}¢</span>
                <span style={{color:T.inkFaint}}>{days}d left</span>
                <span style={{color:T.inkFaint}}>Bal: {(balance*100).toFixed(0)}%</span>
              </div>
            </div>

            {/* sparkline of odds since entry */}
            <div style={{padding:"8px 14px",display:"flex",alignItems:"center",gap:12,borderBottom:`1px solid ${T.rule}`}}>
              <span style={{fontSize:9,color:T.inkFaint,fontFamily:"'DM Mono',monospace",letterSpacing:"0.08em"}}>YES TREND</span>
              <Sparkline data={hist} color={drifted?T.red:T.navy} width={140} height={22}/>
              <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:9,color:T.inkFaint,fontFamily:"'DM Mono',monospace"}}>Alert at ±</span>
                <input
                  type="number" min={1} max={20} step={1}
                  value={Math.round(pos.threshold*100)}
                  onChange={e=>onUpdateThreshold(pos.id, +e.target.value/100)}
                  style={{width:44,padding:"2px 6px",borderRadius:2,border:`1px solid ${T.rule}`,background:T.paper,color:T.ink,fontFamily:"'DM Mono',monospace",fontSize:10,textAlign:"center"}}
                />
                <span style={{fontSize:9,color:T.inkFaint,fontFamily:"'DM Mono',monospace"}}>¢</span>
              </div>
            </div>

            {/* actions */}
            <div style={{padding:"8px 14px",display:"flex",gap:8,alignItems:"center"}}>
              <span style={{fontSize:9,color:T.inkFaint,fontFamily:"'DM Mono',monospace",flex:1}}>
                Capital: ${pos.capital} · Pool share: {calcPoolShare(pos.capital, market.liquidity)}%
              </span>
              <a href={`https://polymarket.com/event/${market.slug}`} target="_blank" rel="noopener noreferrer"
                style={{fontSize:9,color:T.navy,fontFamily:"'DM Mono',monospace",textDecoration:"none",border:`1px solid ${T.navy}44`,padding:"3px 8px",borderRadius:2}}>
                Open ↗
              </a>
              <button onClick={()=>onRemove(pos.id)} style={{
                fontSize:9,color:T.coral,fontFamily:"'DM Mono',monospace",
                background:"transparent",border:`1px solid ${T.coral}44`,
                padding:"3px 8px",borderRadius:2,cursor:"pointer",
              }}>Remove</button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─── CSS ──────────────────────────────────────────────────────────────────────
function makeCSS(T, isDark) { return `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;600;700;900&family=DM+Mono:wght@300;400;500&family=DM+Sans:wght@400;500;600&display=swap');
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  body{background:${T.paper};color:${T.ink};font-family:'DM Mono','Courier New',monospace;font-size:12px;line-height:1.5;transition:background .3s,color .3s}
  body::before{content:'';position:fixed;inset:0;z-index:0;pointer-events:none;opacity:${isDark?.04:.018};background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 512 512' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");background-size:200px}
  ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:${T.paper2}}::-webkit-scrollbar-thumb{background:${T.rule};border-radius:2px}
  .root{position:relative;z-index:1;min-height:100vh;display:flex;flex-direction:column}

  /* masthead */
  .masthead{border-bottom:3px double ${T.ink};padding:0 28px;background:${T.paper};transition:background .3s}
  .masthead-top{display:flex;align-items:flex-end;justify-content:space-between;padding:16px 0 10px;border-bottom:1px solid ${T.ink}}
  .masthead-title{font-family:'Playfair Display',Georgia,serif;font-size:34px;font-weight:900;letter-spacing:-.5px;color:${T.ink};line-height:1}
  .masthead-title span{color:${T.coral}}
  .masthead-tagline{font-size:9px;letter-spacing:.18em;color:${T.inkLight};text-transform:uppercase;margin-top:3px}
  .masthead-meta{text-align:right;font-size:10px;color:${T.inkLight};line-height:1.8}
  .masthead-meta strong{color:${T.ink}}
  .masthead-bottom{display:flex;align-items:center;gap:14px;padding:7px 0}
  .edition-tag{font-size:9px;letter-spacing:.15em;color:${T.inkLight};text-transform:uppercase}
  .masthead-actions{margin-left:auto;display:flex;align-items:center;gap:8px}

  .theme-toggle{display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:20px;border:1px solid ${T.rule};background:${T.paper2};cursor:pointer;font-size:10px;letter-spacing:.06em;color:${T.inkMid};transition:all .2s;font-family:'DM Mono',monospace}
  .theme-toggle:hover{border-color:${T.coral};color:${T.coral}}

  .btn{cursor:pointer;border:none;outline:none;font-family:'DM Mono',monospace;transition:all .12s}
  .btn:hover{opacity:.78}.btn:active{transform:scale(.98)}
  .btn-primary{background:${T.coral};color:#fff;font-size:10px;font-weight:500;letter-spacing:.1em;padding:6px 16px;border-radius:2px;text-transform:uppercase}
  .btn-outline{background:transparent;color:${T.inkMid};font-size:10px;letter-spacing:.08em;padding:5px 12px;border-radius:2px;border:1px solid ${T.rule};text-transform:uppercase}
  .btn-outline:hover{border-color:${T.inkMid}}
  .btn-outline.active{background:${T.ink};color:${T.paper};border-color:${T.ink}}
  .btn-pill{background:${T.paper2};color:${T.inkMid};font-size:10px;letter-spacing:.06em;padding:5px 12px;border-radius:20px;border:1px solid ${T.rule}}
  .btn-pill:hover{border-color:${T.coral};color:${T.coral}}
  .btn-pill.active{background:${T.coral};color:#fff;border-color:${T.coral}}

  /* mode tabs */
  .mode-tabs{display:flex;gap:0;border:1px solid ${T.rule};border-radius:3px;overflow:hidden}
  .mode-tab{padding:5px 14px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;background:${T.paper2};color:${T.inkMid};border:none;font-family:'DM Mono',monospace;transition:all .15s;border-right:1px solid ${T.rule}}
  .mode-tab:last-child{border-right:none}
  .mode-tab.active-lp{background:${T.navy};color:#fff}
  .mode-tab.active-farm{background:${T.purple};color:#fff}
  .mode-tab.active-monitor{background:${T.green};color:#fff}

  .alert-pill{display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:2px;border:1px solid ${T.rule};background:${T.paper2};cursor:pointer;font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;transition:all .15s;color:${T.inkLight}}
  .alert-pill.on{border-color:${T.green};background:${T.greenBg};color:${T.green}}
  .alert-dot{width:6px;height:6px;border-radius:50%;background:${T.rule}}
  .alert-dot.on{background:${T.green};animation:blink 1.5s infinite}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}

  .watchlist-btn{display:flex;align-items:center;gap:6px;padding:5px 12px;border-radius:2px;border:1px solid ${T.rule};background:${T.paper2};cursor:pointer;font-family:'DM Mono',monospace;font-size:10px;letter-spacing:.08em;text-transform:uppercase;transition:all .15s;color:${T.inkLight}}
  .watchlist-btn.on{border-color:${T.amber};background:${T.amberBg};color:${T.amber}}

  .body{display:flex;flex:1;overflow:hidden}

  /* stats strip */
  .stats-strip{display:grid;grid-template-columns:repeat(6,1fr);border-bottom:1px solid ${T.rule};background:${T.paper};transition:background .3s}
  .stat-cell{padding:10px 16px;border-right:1px solid ${T.rule}}
  .stat-cell:last-child{border-right:none}
  .stat-label{font-size:9px;color:${T.inkFaint};letter-spacing:.12em;text-transform:uppercase;margin-bottom:3px}
  .stat-value{font-family:'Playfair Display',serif;font-size:22px;font-weight:700;color:${T.ink};line-height:1}

  /* farm mode banner */
  .farm-banner{
    padding:8px 28px;
    background:${T.purpleBg};
    border-bottom:1px solid ${T.purple}44;
    font-size:10px;color:${T.purple};
    font-family:'DM Mono',monospace;
    display:flex;align-items:center;gap:12px;
    transition:background .3s;
  }
  .farm-banner strong{font-weight:600}

  .left{flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden}
  .toolbar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 24px;border-bottom:1px solid ${T.rule};background:${T.paper2};transition:background .3s}
  .toolbar-sep{flex:1}
  .sort-label{font-size:9px;color:${T.inkFaint};letter-spacing:.1em;text-transform:uppercase}
  .filter-label{font-size:9px;color:${T.inkFaint};letter-spacing:.1em;text-transform:uppercase}

  .filter-btn{display:flex;align-items:center;gap:5px;background:${T.paper2};color:${T.inkMid};font-size:10px;letter-spacing:.06em;padding:5px 12px;border-radius:20px;border:1px solid ${T.rule};cursor:pointer;font-family:'DM Mono',monospace;transition:all .15s}
  .filter-btn:hover{border-color:${T.coral};color:${T.coral}}
  .filter-btn.active{background:${T.navy};color:#fff;border-color:${T.navy}}
  .filter-btn .caret{font-size:8px;opacity:.6;transition:transform .2s}
  .filter-btn.open .caret{transform:rotate(180deg)}
  .dropdown-wrap{position:relative;display:inline-block}
  .dropdown-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:200;background:${T.paper};border:1px solid ${T.rule};border-radius:4px;min-width:160px;box-shadow:0 6px 24px ${isDark?"rgba(0,0,0,.5)":"rgba(26,26,46,.12)"};overflow:hidden;animation:dropIn .15s ease both}
  @keyframes dropIn{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}
  .dropdown-item{display:block;width:100%;padding:8px 14px;font-family:'DM Mono',monospace;font-size:11px;color:${T.inkMid};text-align:left;background:transparent;border:none;border-bottom:1px solid ${T.rule};cursor:pointer;transition:background .1s}
  .dropdown-item:last-child{border-bottom:none}
  .dropdown-item:hover{background:${T.paper2};color:${T.ink}}
  .dropdown-item.selected{background:${T.navyBg};color:${T.navy};font-weight:500}

  .threshold-bar{display:flex;align-items:center;gap:14px;padding:7px 24px;background:${T.greenBg};border-bottom:1px solid ${isDark?"#0d3020":"#c8e6d4"}}
  .threshold-bar label{font-size:10px;color:${T.green};letter-spacing:.08em;white-space:nowrap;text-transform:uppercase}
  input[type=range]{accent-color:${T.coral}}
  .threshold-val{font-family:'Playfair Display',serif;font-size:20px;font-weight:700;color:${T.green};min-width:32px}
  .alerts-log{padding:0 24px;background:${T.greenBg};border-bottom:1px solid ${isDark?"#0d3020":"#c8e6d4"}}
  .alert-entry{display:flex;align-items:center;gap:10px;padding:5px 0;border-bottom:1px solid ${isDark?"#0d3020":"#c8e6d4"};font-size:10px;color:${T.green}}
  .alert-entry:last-child{border-bottom:none}

  .mkt-list{flex:1;overflow-y:auto}

  /* group header */
  .group-hdr{display:flex;align-items:center;gap:10px;padding:9px 24px;background:${T.paper3};border-bottom:1px solid ${T.rule};cursor:pointer;transition:background .1s;border-left:3px solid ${T.navy}}
  .group-hdr:hover{background:${T.paper2}}
  .group-title{font-size:11px;font-weight:600;color:${T.ink};font-family:'DM Sans',sans-serif;flex:1}
  .group-count{font-size:9px;color:${T.inkFaint};letter-spacing:.08em}
  .group-caret{font-size:10px;color:${T.inkFaint};transition:transform .2s}
  .group-caret.open{transform:rotate(90deg)}

  /* market row */
  .mkt-row{display:flex;align-items:center;gap:12px;padding:11px 24px;border-bottom:1px solid ${T.rule};cursor:pointer;transition:background .1s;background:${T.paper}}
  .mkt-row:hover{background:${T.paper2}}
  .mkt-row.active{background:${T.navyBg};border-left:3px solid ${T.navy}}
  .mkt-row.watchlisted{border-left:3px solid ${T.amber}}
  .mkt-row.active.watchlisted{border-left:3px solid ${T.navy}}

  /* dual score badges */
  .badges{display:flex;flex-direction:column;gap:4px;flex-shrink:0;width:58px}
  .stamp{width:58px;height:44px;border-radius:3px;border:2px solid;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px}
  .stamp-num{font-family:'Playfair Display',serif;font-size:17px;font-weight:700;line-height:1}
  .stamp-lbl{font-size:6px;letter-spacing:.12em;font-weight:500;font-family:'DM Mono',monospace}
  .stamp-mini{width:58px;height:24px;border-radius:2px;border:1px solid;display:flex;align-items:center;justify-content:center;gap:4px}
  .stamp-mini-num{font-family:'Playfair Display',serif;font-size:13px;font-weight:700;line-height:1}
  .stamp-mini-lbl{font-size:6px;letter-spacing:.08em;font-family:'DM Mono',monospace}

  .mkt-main{flex:1;min-width:0}
  .mkt-q{font-family:'DM Sans',system-ui,sans-serif;font-size:11px;font-weight:500;color:${T.ink};line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px}
  .mkt-meta{display:flex;gap:10px;font-size:10px;color:${T.inkFaint};align-items:center;flex-wrap:wrap}
  .yes-p{color:${T.green};font-weight:500}
  .no-p{color:${T.coral};font-weight:500}
  .apy-badge{font-size:9px;color:${T.green};border:1px solid ${T.green}44;background:${T.greenBg};padding:1px 5px;border-radius:2px;font-weight:600}
  .farm-badge{font-size:9px;color:${T.purple};border:1px solid ${T.purple}44;background:${T.purpleBg};padding:1px 5px;border-radius:2px;font-weight:600}
  .vol-up{color:${T.green};font-weight:600}
  .vol-down{color:${T.coral};font-weight:600}
  .urgency-badge{display:inline-flex;align-items:center;gap:2px;font-size:9px;font-weight:600;letter-spacing:.04em;padding:2px 5px;border-radius:2px;border:1px solid;font-family:'DM Mono',monospace}

  .bal-col{width:64px;flex-shrink:0}
  .bal-label{font-size:9px;color:${T.inkFaint};text-align:right;margin-bottom:3px}
  .bal-track{height:3px;background:${T.rule};border-radius:1px}
  .bal-fill{height:100%;border-radius:1px;transition:width .4s}

  .spark-col{width:60px;flex-shrink:0;display:flex;flex-direction:column;align-items:flex-end;gap:2px}
  .spark-label{font-size:8px;color:${T.inkFaint};letter-spacing:.04em}

  .star-btn{background:transparent;border:none;cursor:pointer;font-size:14px;padding:2px 3px;line-height:1;transition:transform .15s;flex-shrink:0}
  .star-btn:hover{transform:scale(1.3)}
  .add-pos-btn{background:transparent;border:1px solid ${T.purple}44;color:${T.purple};cursor:pointer;font-size:9px;padding:2px 6px;border-radius:2px;font-family:'DM Mono',monospace;transition:all .15s;flex-shrink:0;letter-spacing:.04em}
  .add-pos-btn:hover{background:${T.purpleBg}}

  .cat-chip{flex-shrink:0;font-size:8px;letter-spacing:.08em;color:${T.inkFaint};border:1px solid ${T.rule};border-radius:20px;padding:2px 7px;text-transform:uppercase}
  .row-caret{color:${T.rule};font-size:14px;flex-shrink:0}
  .mkt-row.active .row-caret{color:${T.navy}}

  .pagination{display:flex;align-items:center;justify-content:space-between;padding:10px 24px;border-top:1px solid ${T.rule};background:${T.paper2}}
  .page-info{font-size:10px;color:${T.inkFaint}}
  .page-info strong{color:${T.ink}}
  .page-btns{display:flex;gap:5px;align-items:center}
  .page-btn{background:${T.paper};color:${T.inkMid};font-size:10px;padding:4px 10px;border-radius:2px;border:1px solid ${T.rule};cursor:pointer;font-family:'DM Mono',monospace;transition:all .12s}
  .page-btn:hover:not(:disabled){background:${T.ink};color:${T.paper};border-color:${T.ink}}
  .page-btn:disabled{opacity:.35;cursor:not-allowed}
  .page-btn.current{background:${T.coral};color:#fff;border-color:${T.coral}}

  .center-msg{display:flex;flex-direction:column;align-items:center;justify-content:center;height:200px;color:${T.inkFaint};gap:10px;font-size:11px}
  .spin{display:inline-block;animation:spin .9s linear infinite;font-size:20px}
  @keyframes spin{to{transform:rotate(360deg)}}

  /* right panel */
  .right{width:400px;flex-shrink:0;border-left:1px solid ${T.rule};background:${T.paper};display:flex;flex-direction:column;overflow:hidden;transition:background .3s}
  .right-hdr{padding:12px 18px;border-bottom:2px solid ${T.ink};display:flex;align-items:center;justify-content:space-between}
  .right-hdr-title{font-family:'Playfair Display',serif;font-size:16px;font-weight:700;color:${T.ink}}
  .right-hdr-sub{font-size:9px;color:${T.inkFaint};letter-spacing:.1em;text-transform:uppercase;margin-top:1px}
  .right-tabs{display:flex;border-bottom:1px solid ${T.rule};background:${T.paper2}}
  .right-tab{flex:1;padding:8px;font-size:10px;letter-spacing:.08em;text-transform:uppercase;cursor:pointer;background:transparent;color:${T.inkMid};border:none;font-family:'DM Mono',monospace;transition:all .15s;border-bottom:2px solid transparent}
  .right-tab.active{color:${T.coral};border-bottom-color:${T.coral};background:${T.paper}}
  .right-body{flex:1;overflow-y:auto;padding:14px 16px}

  .detail-card{border:1px solid ${T.rule};border-radius:3px;padding:12px;margin-bottom:12px;background:${T.paper2}}
  .detail-q{font-family:'DM Sans',sans-serif;font-size:12px;font-weight:600;color:${T.ink};line-height:1.5;margin-bottom:10px}
  .detail-metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-bottom:10px}
  .m-cell{background:${T.paper};border:1px solid ${T.rule};border-radius:2px;padding:6px 4px;text-align:center}
  .m-label{font-size:7px;color:${T.inkFaint};letter-spacing:.1em;text-transform:uppercase;margin-bottom:2px}
  .m-val{font-family:'Playfair Display',serif;font-size:14px;font-weight:700}
  .odds-track{height:5px;border-radius:3px;background:${T.coralBg};border:1px solid ${isDark?"#3a1008":"#f0c0b8"};overflow:hidden}
  .odds-yes{height:100%;background:${T.green};transition:width .5s}
  .odds-labels{display:flex;justify-content:space-between;margin-top:4px;font-size:9px}
  .extra-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-top:7px}
  .extra-cell{background:${T.paper};border:1px solid ${T.rule};border-radius:2px;padding:6px 5px;text-align:center}
  .extra-label{font-size:7px;color:${T.inkFaint};letter-spacing:.08em;text-transform:uppercase;margin-bottom:2px}
  .extra-val{font-size:13px;font-weight:700;font-family:'Playfair Display',serif}

  /* farm detail card */
  .farm-detail{border:1px solid ${T.purple}44;border-radius:3px;padding:12px;margin-bottom:12px;background:${T.purpleBg}}
  .farm-detail-title{font-family:'Playfair Display',serif;font-size:11px;font-weight:700;color:${T.purple};letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid ${T.purple}33}
  .farm-metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:5px}
  .farm-m{background:${T.paper};border:1px solid ${T.purple}22;border-radius:2px;padding:7px 5px;text-align:center}
  .farm-m-label{font-size:7px;color:${T.purple};letter-spacing:.1em;text-transform:uppercase;margin-bottom:2px;opacity:.7}
  .farm-m-val{font-family:'Playfair Display',serif;font-size:14px;font-weight:700;color:${T.purple}}

  .analysis-card{border:1px solid ${T.rule};border-radius:3px;padding:12px;margin-bottom:10px;min-height:150px;background:${T.paper}}
  .analysis-header{font-family:'Playfair Display',serif;font-size:10px;font-weight:600;color:${T.inkLight};letter-spacing:.06em;text-transform:uppercase;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid ${T.rule}}
  .analysis-text{font-family:'DM Sans',sans-serif;font-size:11px;color:${T.inkMid};line-height:1.85;white-space:pre-wrap}
  .typing-row{display:flex;gap:5px;padding:8px 0;align-items:center}
  .t-dot{width:5px;height:5px;border-radius:50%;background:${T.coral};animation:tdot 1.2s infinite}
  .t-dot:nth-child(2){animation-delay:.2s}.t-dot:nth-child(3){animation-delay:.4s}
  @keyframes tdot{0%,80%,100%{opacity:.2;transform:scale(.8)}40%{opacity:1;transform:scale(1.1)}}

  .action-row{display:flex;gap:7px;margin-top:4px}
  .btn-cta{flex:1;display:block;text-align:center;background:${T.navy};color:#fff;font-family:'DM Mono',monospace;font-size:9px;font-weight:500;letter-spacing:.1em;text-transform:uppercase;padding:9px;border-radius:2px;text-decoration:none;transition:opacity .12s}
  .btn-cta:hover{opacity:.82}
  .btn-cta-farm{flex:1;display:block;text-align:center;background:${T.purple};color:#fff;font-family:'DM Mono',monospace;font-size:9px;font-weight:500;letter-spacing:.08em;text-transform:uppercase;padding:9px;border-radius:2px;border:none;cursor:pointer;transition:opacity .12s}
  .btn-cta-farm:hover{opacity:.82}
  .btn-watch-cta{background:${T.paper2};color:${T.inkMid};font-family:'DM Mono',monospace;font-size:9px;padding:9px 12px;border-radius:2px;border:1px solid ${T.rule};cursor:pointer;transition:all .12s;letter-spacing:.06em;text-transform:uppercase}
  .btn-watch-cta.watching{background:${T.amberBg};color:${T.amber};border-color:${T.amber}}
  .btn-refresh{background:${T.paper2};color:${T.inkMid};font-size:13px;padding:8px 11px;border-radius:2px;border:1px solid ${T.rule};cursor:pointer}

  .empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:10px;color:${T.inkFaint};text-align:center}
  .empty-ornament{font-family:'Playfair Display',serif;font-size:44px;color:${T.rule};line-height:1}
  .empty-text{font-family:'DM Sans',sans-serif;font-size:12px;line-height:1.7;color:${T.inkFaint}}

  .api-warning{display:flex;align-items:center;gap:8px;padding:8px 20px;background:${T.amberBg};border-bottom:1px solid ${isDark?"#3a2000":"#fad7a0"};font-size:11px;color:${T.amber};font-family:'DM Mono',monospace}
  .api-warning a{color:${T.coral};text-decoration:underline}

  .fade{animation:fadeUp .3s ease both}
  @keyframes fadeUp{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}
`; }

// ─── MOCK ─────────────────────────────────────────────────────────────────────
const MOCK = [
  { id:"1", question:"Will Bitcoin exceed $100K by June 2026?", yes:0.52, no:0.48, volume:1240, liquidity:3400, endDate:"2026-06-30", category:"Crypto", slug:"btc-100k-june", score:72 },
  { id:"2", question:"Will ETH flip BTC in market cap by Q3 2026?", yes:0.18, no:0.82, volume:480, liquidity:920, endDate:"2026-09-30", category:"Crypto", slug:"eth-flip-btc", score:38 },
  { id:"3", question:"Will Solana hit $500 before July 2026?", yes:0.34, no:0.66, volume:310, liquidity:710, endDate:"2026-07-01", category:"Crypto", slug:"sol-500", score:55 },
  { id:"4", question:"Will the Fed cut rates in June 2026?", yes:0.61, no:0.39, volume:2100, liquidity:5600, endDate:"2026-06-15", category:"Business", slug:"fed-cut-june", score:47 },
  { id:"5", question:"Will Mantle TVL exceed $2B by August 2026?", yes:0.29, no:0.71, volume:95, liquidity:210, endDate:"2026-08-01", category:"Crypto", slug:"mantle-tvl-2b", score:80 },
  { id:"6", question:"Will a new L2 launch on Monad before Q4 2026?", yes:0.51, no:0.49, volume:320, liquidity:180, endDate:"2026-10-01", category:"Crypto", slug:"monad-l2-q4", score:78 },
];

// ─── APP ──────────────────────────────────────────────────────────────────────
export default function App() {
  const [isDark,         setIsDark]         = useState(false);
  const [mode,           setMode]           = useState("lp");      // "lp" | "farm" | "monitor"
  const [rightTab,       setRightTab]       = useState("analysis"); // "analysis" | "farm"
  const [allMarkets,     setAllMarkets]     = useState([]);
  const [prevVolumes,    setPrevVolumes]    = useState({});
  const [priceHistory,   setPriceHistory]   = useState({});        // id -> [{yes,no,ts}]
  const [scoreHistory,   setScoreHistory]   = useState({});        // id -> [score]
  const [loading,        setLoading]        = useState(false);
  const [backendOk,      setBackendOk]      = useState(null);
  const [category,       setCategory]       = useState("All");
  const [sortBy,         setSortBy]         = useState("score");
  const [volIdx,         setVolIdx]         = useState(0);
  const [liqIdx,         setLiqIdx]         = useState(0);
  const [showWatchlist,  setShowWatchlist]  = useState(false);
  const [watchlist,      setWatchlist]      = useState(() => {
    try { return JSON.parse(localStorage.getItem("lp_watchlist")||"[]"); } catch { return []; }
  });
  const [positions,      setPositions]      = useState(() => {
    try { return JSON.parse(localStorage.getItem("lp_positions")||"[]"); } catch { return []; }
  });
  const [collapsedGroups,setCollapsedGroups]= useState({});
  const [page,           setPage]           = useState(1);
  const [selected,       setSelected]       = useState(null);
  const [analysis,       setAnalysis]       = useState("");
  const [aLoading,       setALoading]       = useState(false);
  const [alertsOn,       setAlertsOn]       = useState(false);
  const [threshold,      setThreshold]      = useState(70);
  const [alerts,         setAlerts]         = useState([]);
  const [lastScan,       setLastScan]       = useState(null);
  const [scanN,          setScanN]          = useState(0);
  const timerRef = useRef(null);

  const T = isDark ? DARK : LIGHT;
  const noApiKey = CLAUDE_API_KEY === "your-api-key-here";

  // persist watchlist + positions
  useEffect(() => { localStorage.setItem("lp_watchlist",  JSON.stringify(watchlist));  }, [watchlist]);
  useEffect(() => { localStorage.setItem("lp_positions",  JSON.stringify(positions));  }, [positions]);

  const toggleWatch = (id, e) => {
    e?.stopPropagation();
    setWatchlist(w => w.includes(id) ? w.filter(x=>x!==id) : [...w, id]);
  };

  const addPosition = (market, e) => {
    e?.stopPropagation();
    if (positions.find(p=>p.id===market.id)) return;
    setPositions(p => [...p, {
      id:         market.id,
      entryYes:   market.yes,
      entryNo:    market.no,
      capital:    DEFAULT_CAPITAL,
      threshold:  EXIT_THRESHOLD,
      addedAt:    Date.now(),
    }]);
    setMode("monitor");
  };

  const removePosition   = id => setPositions(p => p.filter(x=>x.id!==id));
  const updateThreshold  = (id, val) => setPositions(p => p.map(x=>x.id===id?{...x,threshold:val}:x));

  // scan
  const scan = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE}/markets?limit=100&sort_by=score&active_only=true`);
      if (!res.ok) throw new Error();
      const data = await res.json();

      setPrevVolumes(prev => {
        const next = {};
        data.markets.forEach(m => { next[m.id] = m.volume; });
        return next;
      });
      setPriceHistory(prev => {
        const next = { ...prev };
        data.markets.forEach(m => {
          next[m.id] = [...(next[m.id]||[]), { yes:m.yes, no:m.no, ts:Date.now() }].slice(-12);
        });
        return next;
      });
      setScoreHistory(prev => {
        const next = { ...prev };
        data.markets.forEach(m => {
          next[m.id] = [...(next[m.id]||[]), m.score].slice(-8);
        });
        return next;
      });

      setAllMarkets(data.markets);
      setBackendOk(true);

      if (alertsOn) {
        const hits = data.markets.filter(m => m.score >= threshold);
        if (hits.length) {
          setAlerts(prev => [{
            id:Date.now(), time:new Date().toLocaleTimeString(),
            count:hits.length, top:hits[0].question,
          }, ...prev.slice(0,4)]);
        }
      }
    } catch {
      setBackendOk(false);
      setAllMarkets(MOCK);
    }
    setLastScan(new Date());
    setScanN(n => n+1);
    setLoading(false);
  }, [alertsOn, threshold]);

  useEffect(() => {
  if (SUPABASE_ENABLED) {
    fetch(`${API_BASE}/user/${USER_ID}/watchlist`)
      .then(r=>r.json())
      .then(d=>{ if(d.market_ids?.length) setWatchlist(d.market_ids); })
      .catch(()=>{});
    fetch(`${API_BASE}/user/${USER_ID}/positions`)
      .then(r=>r.json())
      .then(d=>{ if(d.positions?.length) setPositions(d.positions); })
      .catch(()=>{});
  }
  scan();
// eslint-disable-next-line react-hooks/exhaustive-deps
}, []);
  useEffect(() => {
    clearInterval(timerRef.current);
    if (alertsOn) timerRef.current = setInterval(scan, SCAN_INTERVAL);
    return () => clearInterval(timerRef.current);
  }, [alertsOn, scan]);
  useEffect(() => { setPage(1); }, [category, sortBy, volIdx, liqIdx, showWatchlist, mode]);

  // enrich markets with farm score
  const enriched = useMemo(() => allMarkets.map(m => ({
    ...m,
    farmScore: calcFarmScore(m, priceHistory[m.id]),
  })), [allMarkets, priceHistory]);

  // filter + sort
  const filtered = useMemo(() => {
    const vp = VOL_PRESETS[volIdx];
    const lp = LIQ_PRESETS[liqIdx];
    let m = enriched
      .filter(x => !showWatchlist || watchlist.includes(x.id))
      .filter(x => category === "All" || x.category === category)
      .filter(x => x.volume    >= vp.min && x.volume    < (vp.max===Infinity?1e15:vp.max))
      .filter(x => x.liquidity >= lp.min && x.liquidity < (lp.max===Infinity?1e15:lp.max));
    if (mode === "farm") {
      // farm mode: filter to balance near 50/50, pre-sort by farmScore
      m = m.filter(x => Math.abs(x.yes - 0.5) <= 0.15); // within 15¢ of midpoint
      m.sort((a,b) => b.farmScore - a.farmScore);
    } else {
      if (sortBy==="score")     m.sort((a,b)=>b.score-a.score);
      if (sortBy==="farm")      m.sort((a,b)=>b.farmScore-a.farmScore);
      if (sortBy==="volume")    m.sort((a,b)=>b.volume-a.volume);
      if (sortBy==="liquidity") m.sort((a,b)=>b.liquidity-a.liquidity);
      if (sortBy==="days")      m.sort((a,b)=>daysLeft(a.endDate)-daysLeft(b.endDate));
    }
    return m;
  }, [enriched, category, sortBy, volIdx, liqIdx, showWatchlist, watchlist, mode]);

  // group
  const grouped  = groupMarkets(filtered);
  const flatRows = [];
  grouped.forEach(g => {
    if (g.type==="single") {
      flatRows.push({...g, renderType:"single"});
    } else {
      flatRows.push({...g, renderType:"group-header"});
      if (!collapsedGroups[g.key]) {
        g.markets.forEach(m => flatRows.push({renderType:"group-item", market:m, groupKey:g.key}));
      }
    }
  });

  const totalPages = Math.max(1, Math.ceil(flatRows.length / PAGE_SIZE));
  const paginated  = flatRows.slice((page-1)*PAGE_SIZE, page*PAGE_SIZE);
  const pageNums   = (() => {
    const nums=[], start=Math.max(1,page-2), end=Math.min(totalPages,page+2);
    for(let i=start;i<=end;i++) nums.push(i);
    return nums;
  })();

  const prime     = enriched.filter(m=>m.score>=75).length;
  const farmGems  = enriched.filter(m=>m.farmScore>=75).length;
  const avgScr    = enriched.length ? Math.round(enriched.reduce((a,b)=>a+b.score,0)/enriched.length) : 0;
  const exitAlerts= positions.filter(pos => {
    const m = allMarkets.find(x=>x.id===pos.id);
    return m && Math.abs(m.yes - pos.entryYes) >= pos.threshold;
  }).length;
  const today     = new Date().toLocaleDateString("en-US",{weekday:"long",year:"numeric",month:"long",day:"numeric"});

  const analyze = async (market) => {
    setSelected(market);
    setAnalysis("");
    setALoading(true);
    if (noApiKey) {
      setAnalysis("⚠ Add your Claude API key at the top of App.js.\n\nReplace 'your-api-key-here' with your key from console.anthropic.com/settings/api-keys");
      setALoading(false);
      return;
    }
    try {
      const balance = 1 - Math.abs(market.yes - 0.5) * 2;
      const apy     = calcAPY(market.liquidity, balance);
      const ph      = priceHistory[market.id] || [];
      const yesHist = ph.map(p=>p.yes);
      const stdev   = yesHist.length >= 2
        ? Math.sqrt(yesHist.reduce((a,b)=>a+(b-(yesHist.reduce((x,y)=>x+y)/yesHist.length))**2,0)/yesHist.length).toFixed(4)
        : "N/A";
      const poolShare = calcPoolShare(DEFAULT_CAPITAL, market.liquidity);
      const res = await fetch(`${API_BASE}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          market,
          prompt: `Market: "${market.question}"
      YES: ${pct(market.yes)} | NO: ${pct(market.no)}
      Volume: ${fmtUSD(market.volume)} | Liquidity: ${fmtUSD(market.liquidity)}
      Est. APY: ~${apy}% | $50 pool share: ${poolShare}%
      Odds stdev across scans: ${stdev}
      Days left: ${daysLeft(market.endDate)}
      LP Score: ${market.score}/100 | Farm Score: ${market.farmScore}/100
      Strategy: resting maker orders near 50/50 to earn rewards. Cancel if odds drift 7¢+.
      Analyze for this specific strategy.`
       })
     });
     const data = await res.json();
     setAnalysis(data.analysis || "Analysis unavailable.");
     } catch {
       setAnalysis("Could not reach Claude API. Check your connection.");
     }
     setALoading(false);
     };

  // render market row
  const renderMarketRow = (m, indent=false) => {
    const sc       = m.score;
    const fs       = m.farmScore || 0;
    const col      = scoreColor(sc, T);
    const bg       = scoreBg(sc, T);
    const fcol     = farmColor(fs, T);
    const fbg      = farmBg(fs, T);
    const bal      = Math.round((1 - Math.abs(m.yes-0.5)*2)*100);
    const days     = daysLeft(m.endDate);
    const isActive = selected?.id === m.id;
    const starred  = watchlist.includes(m.id);
    const inPos    = positions.some(p=>p.id===m.id);
    const hist     = scoreHistory[m.id] || [];
    const yHist    = (priceHistory[m.id]||[]).map(p=>p.yes);
    const prevVol  = prevVolumes[m.id];
    const volDiff  = prevVol !== undefined ? m.volume - prevVol : 0;
    const balance  = 1 - Math.abs(m.yes-0.5)*2;
    const apy      = calcAPY(m.liquidity, balance);
    const poolShare= calcPoolShare(DEFAULT_CAPITAL, m.liquidity);

    return (
      <div key={m.id}
        className={`mkt-row fade ${isActive?"active":""} ${starred&&!isActive?"watchlisted":""}`}
        style={indent?{paddingLeft:36}:{}}
        onClick={()=>analyze(m)}
      >
        {/* dual score badges */}
        <div className="badges">
          <div className="stamp" style={{borderColor:col,background:bg,color:col}}>
            <div className="stamp-num">{sc}</div>
            <div className="stamp-lbl">LP</div>
          </div>
          <div className="stamp-mini" style={{borderColor:fcol+"66",background:fbg,color:fcol}}>
            <div className="stamp-mini-num">{fs}</div>
            <div className="stamp-mini-lbl">FARM</div>
          </div>
        </div>

        <div className="mkt-main">
          <div className="mkt-q">{m.question}</div>
          <div className="mkt-meta">
            <span className="yes-p">Y {(m.yes*100).toFixed(0)}¢</span>
            <span className="no-p">N {(m.no*100).toFixed(0)}¢</span>
            <span>Vol {fmtUSD(m.volume)}</span>
            {volDiff !== 0 && (
              <span className={volDiff>0?"vol-up":"vol-down"}>{volDiff>0?"↑":"↓"}{fmtUSD(Math.abs(volDiff))}</span>
            )}
            {apy && <span className="apy-badge">~{apy}% APY</span>}
            {fs >= 75 && <span className="farm-badge">💎 {poolShare}% share</span>}
            <span className="urgency-badge" style={{color:urgencyColor(days,T),borderColor:urgencyColor(days,T)+"44",background:urgencyBg(days,T)}}>
              {days<=7&&"🔴 "}{days<=30&&days>7&&"🟡 "}{days}d
            </span>
          </div>
        </div>

        {/* sparklines */}
        <div className="spark-col">
          <div className="spark-label">LP</div>
          <Sparkline data={hist} color={col} width={52} height={16}/>
          <div className="spark-label" style={{marginTop:2}}>PRICE</div>
          <Sparkline data={yHist} color={fcol} width={52} height={16}/>
        </div>

        <div className="bal-col">
          <div className="bal-label">Bal {bal}%</div>
          <div className="bal-track">
            <div className="bal-fill" style={{width:`${bal}%`,background:bal>70?T.green:bal>40?T.amber:T.coral}}/>
          </div>
        </div>

        <div className="cat-chip">{m.category}</div>
        <button className="star-btn" onClick={e=>toggleWatch(m.id,e)} title={starred?"Unwatch":"Watch"}>{starred?"⭐":"☆"}</button>
        {!inPos && (
          <button className="add-pos-btn" onClick={e=>addPosition(m,e)} title="Track position">+POS</button>
        )}
        {inPos && <span style={{fontSize:9,color:T.purple,fontFamily:"'DM Mono',monospace",flexShrink:0}}>◎ MON</span>}
        <div className="row-caret">›</div>
      </div>
    );
  };

  return (
    <>
      <style>{makeCSS(T, isDark)}</style>
      <div className="root">

        {/* MASTHEAD */}
        <header className="masthead">
          <div className="masthead-top">
            <div>
              <div className="masthead-title">LP <span>SCANNER</span></div>
              <div className="masthead-tagline">Polymarket · Built by NFTKING · Liquidity Intelligence</div>
            </div>
            <div className="masthead-meta">
              <div><strong>{today}</strong></div>
              {lastScan && <div>Last scan: <strong>{lastScan.toLocaleTimeString()}</strong> · Issue #{scanN}</div>}
              {backendOk===false && <div style={{color:T.amber}}>⚠ Running on mock data</div>}
            </div>
          </div>
          <div className="masthead-bottom">
            <span className="edition-tag">Daily Edition</span>
            <div style={{height:12,width:1,background:T.rule}}/>
            <span className="edition-tag">{enriched.length} Markets</span>
            <div style={{height:12,width:1,background:T.rule}}/>
            <span className="edition-tag">{prime} Prime LP</span>
            <div style={{height:12,width:1,background:T.rule}}/>
            <span className="edition-tag" style={{color:T.purple}}>{farmGems} Farm Gems</span>
            <div style={{height:12,width:1,background:T.rule}}/>
            <span className="edition-tag">{watchlist.length} Watching</span>
            {exitAlerts > 0 && <>
              <div style={{height:12,width:1,background:T.rule}}/>
              <span className="edition-tag" style={{color:T.red,fontWeight:600}}>🔴 {exitAlerts} EXIT ALERT{exitAlerts>1?"S":""}</span>
            </>}
            <div className="masthead-actions">
              {/* mode tabs */}
              <div className="mode-tabs">
                <button className={`mode-tab ${mode==="lp"?"active-lp":""}`} onClick={()=>setMode("lp")}>LP Mode</button>
                <button className={`mode-tab ${mode==="farm"?"active-farm":""}`} onClick={()=>setMode("farm")}>Farm Mode</button>
                <button className={`mode-tab ${mode==="monitor"?"active-monitor":""}`} onClick={()=>setMode("monitor")}>
                  Monitor {positions.length>0&&`(${positions.length})`}
                  {exitAlerts>0&&<span style={{color:T.red,marginLeft:4}}>🔴</span>}
                </button>
              </div>
              <button className="theme-toggle" onClick={()=>setIsDark(v=>!v)}>
                {isDark?"☀ Light":"☾ Dark"}
              </button>
              <button className={`alert-pill ${alertsOn?"on":""}`} onClick={()=>setAlertsOn(v=>!v)}>
                <div className={`alert-dot ${alertsOn?"on":""}`}/>
                {alertsOn?"Alerts On":"Alerts Off"}
              </button>
              <button className="btn btn-primary" onClick={scan} disabled={loading}>
                {loading?<span className="spin" style={{fontSize:11}}>⟳</span>:"⟳"} Scan
              </button>
            </div>
          </div>
        </header>

        <div className="body">
          <div className="left">

            {/* stats */}
            <div className="stats-strip">
              {[
                {label:"Markets",    value:enriched.length,  color:T.ink},
                {label:"Prime LP",   value:prime,            color:T.green},
                {label:"Farm Gems",  value:farmGems,         color:T.purple},
                {label:"Avg Score",  value:avgScr,           color:T.amber},
                {label:"Positions",  value:positions.length, color:T.navy},
                {label:"Exit Alerts",value:exitAlerts,       color:exitAlerts>0?T.red:T.inkFaint},
              ].map(s=>(
                <div key={s.label} className="stat-cell">
                  <div className="stat-label">{s.label}</div>
                  <div className="stat-value" style={{color:s.color,fontSize:"22px"}}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* farm mode banner */}
            {mode==="farm" && (
              <div className="farm-banner fade">
                <span>💎</span>
                <span><strong>Farm Mode</strong> — showing only markets near 50/50, ranked by Farm Score. Optimised for resting maker orders with ${DEFAULT_CAPITAL} capital. Click +POS to track any position.</span>
              </div>
            )}

            {/* monitor mode */}
            {mode==="monitor" ? (
              <div style={{flex:1,overflowY:"auto",padding:"16px 24px"}}>
                <div style={{fontFamily:"'Playfair Display',serif",fontSize:15,fontWeight:700,color:T.ink,marginBottom:4}}>
                  Position Monitor
                </div>
                <div style={{fontSize:10,color:T.inkFaint,fontFamily:"'DM Mono',monospace",marginBottom:16,letterSpacing:"0.08em"}}>
                  TRACKING {positions.length} ACTIVE POSITION{positions.length!==1?"S":""} · EXIT ALERT WHEN ODDS DRIFT ≥ THRESHOLD
                </div>
                <PositionMonitor
                  positions={positions}
                  allMarkets={enriched}
                  priceHistory={priceHistory}
                  onRemove={removePosition}
                  onUpdateThreshold={updateThreshold}
                  T={T}
                />
              </div>
            ) : (
              <>
                {/* alerts */}
                {alertsOn && (
                  <div className="threshold-bar fade">
                    <label>Alert ≥</label>
                    <input type="range" min={50} max={90} step={5}
                      value={threshold} onChange={e=>setThreshold(+e.target.value)} style={{flex:1}}/>
                    <div className="threshold-val">{threshold}</div>
                    <span style={{fontSize:9,color:T.green,letterSpacing:"0.08em"}}>30S SCAN</span>
                  </div>
                )}
                {alerts.length>0 && (
                  <div className="alerts-log">
                    {alerts.map(a=>(
                      <div key={a.id} className="alert-entry">
                        <span style={{color:T.inkFaint}}>[{a.time}]</span>
                        <span style={{color:T.green,fontWeight:500}}>▲ {a.count} above {threshold}</span>
                        <span style={{color:T.inkLight,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{a.top.slice(0,48)}…</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* toolbar */}
                <div className="toolbar">
                  {CATS.map(c=>(
                    <button key={c} className={`btn btn-pill ${category===c?"active":""}`}
                      onClick={()=>setCategory(c)}>{c}</button>
                  ))}
                  <div className="toolbar-sep"/>
                  <button className={`watchlist-btn ${showWatchlist?"on":""}`} onClick={()=>setShowWatchlist(v=>!v)}>
                    {showWatchlist?"⭐ Watchlist":"☆ Watchlist"}
                  </button>
                  <div style={{height:18,width:1,background:T.rule}}/>
                  {mode==="lp" && <>
                    <span className="sort-label">Sort:</span>
                    {SORTS.map(([v,l])=>(
                      <button key={v} className={`btn btn-outline ${sortBy===v?"active":""}`}
                        onClick={()=>setSortBy(v)}>{l}</button>
                    ))}
                    <div style={{height:18,width:1,background:T.rule}}/>
                  </>}
                  <span className="filter-label">Filter:</span>
                  <FilterDropdown label="Volume"    presets={VOL_PRESETS} selected={volIdx} onSelect={setVolIdx} T={T}/>
                  <FilterDropdown label="Liquidity" presets={LIQ_PRESETS} selected={liqIdx} onSelect={setLiqIdx} T={T}/>
                </div>

                {/* list */}
                <div className="mkt-list">
                  {loading && enriched.length===0 ? (
                    <div className="center-msg"><span className="spin">⟳</span><span>Scanning Polymarket…</span></div>
                  ) : paginated.length===0 ? (
                    <div className="center-msg">
                      {showWatchlist && watchlist.length===0
                        ? "No markets in your watchlist yet."
                        : mode==="farm" ? "No markets near 50/50 match your filters."
                        : "No markets match your filters."}
                    </div>
                  ) : paginated.map(row => {
                    if (row.renderType==="single") return renderMarketRow(row.market);
                    if (row.renderType==="group-header") {
                      const best = Math.max(...row.markets.map(m=>m.score));
                      const fbest = Math.max(...row.markets.map(m=>m.farmScore||0));
                      const isOpen = !collapsedGroups[row.key];
                      return (
                        <div key={row.key+"_hdr"} className="group-hdr"
                          onClick={()=>setCollapsedGroups(c=>({...c,[row.key]:!c[row.key]}))}>
                          <span className={`group-caret ${isOpen?"open":""}`}>▶</span>
                          <div className="group-title">
                            {row.markets[0].question.replace(/Will |will /,"").slice(0,52)}… ({row.markets.length} markets)
                          </div>
                          <span style={{fontSize:9,color:scoreColor(best,T),border:`1px solid ${scoreColor(best,T)}44`,background:scoreBg(best,T),padding:"2px 7px",borderRadius:2}}>LP {best}</span>
                          <span style={{fontSize:9,color:farmColor(fbest,T),border:`1px solid ${farmColor(fbest,T)}44`,background:farmBg(fbest,T),padding:"2px 7px",borderRadius:2,marginLeft:4}}>Farm {fbest}</span>
                          <span className="group-count">{row.markets.length} similar</span>
                        </div>
                      );
                    }
                    if (row.renderType==="group-item") return renderMarketRow(row.market, true);
                    return null;
                  })}
                </div>

                {/* pagination */}
                {flatRows.length > PAGE_SIZE && (
                  <div className="pagination">
                    <div className="page-info">
                      <strong>{(page-1)*PAGE_SIZE+1}–{Math.min(page*PAGE_SIZE,flatRows.length)}</strong> of <strong>{flatRows.length}</strong>
                      &nbsp;· Page <strong>{page}</strong> / <strong>{totalPages}</strong>
                    </div>
                    <div className="page-btns">
                      <button className="page-btn" onClick={()=>setPage(1)} disabled={page===1}>«</button>
                      <button className="page-btn" onClick={()=>setPage(p=>p-1)} disabled={page===1}>‹</button>
                      {pageNums.map(n=>(
                        <button key={n} className={`page-btn ${n===page?"current":""}`} onClick={()=>setPage(n)}>{n}</button>
                      ))}
                      <button className="page-btn" onClick={()=>setPage(p=>p+1)} disabled={page===totalPages}>›</button>
                      <button className="page-btn" onClick={()=>setPage(totalPages)} disabled={page===totalPages}>»</button>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* RIGHT PANEL */}
          <div className="right">
            <div className="right-hdr">
              <div>
                <div className="right-hdr-title">Analysis Desk</div>
                <div className="right-hdr-sub">AI-powered LP + Farm intelligence</div>
              </div>
              {selected && !aLoading && analysis && (
                <button className="btn-refresh" onClick={()=>analyze(selected)}>⟳</button>
              )}
            </div>
            {/* right tabs */}
            <div className="right-tabs">
              <button className={`right-tab ${rightTab==="analysis"?"active":""}`} onClick={()=>setRightTab("analysis")}>Analysis</button>
              <button className={`right-tab ${rightTab==="farm"?"active":""}`} onClick={()=>setRightTab("farm")}>Farm Detail</button>
            </div>

            <div className="right-body">
              {!selected ? (
                <div className="empty-state">
                  <div className="empty-ornament">❧</div>
                  <div className="empty-text">Select a market for<br/>full LP + Farm analysis.</div>
                </div>
              ) : (
                <div className="fade">

                  {rightTab==="analysis" && (
                    <>
                      <div className="detail-card">
                        <div className="detail-q">{selected.question}</div>
                        <div className="detail-metrics">
                          {[
                            {label:"LP",    value:selected.score,                        color:scoreColor(selected.score,T)},
                            {label:"YES",   value:`${(selected.yes*100).toFixed(0)}¢`,   color:T.green},
                            {label:"NO",    value:`${(selected.no*100).toFixed(0)}¢`,    color:T.coral},
                            {label:"Days",  value:daysLeft(selected.endDate),             color:urgencyColor(daysLeft(selected.endDate),T)},
                          ].map(s=>(
                            <div key={s.label} className="m-cell">
                              <div className="m-label">{s.label}</div>
                              <div className="m-val" style={{color:s.color}}>{s.value}</div>
                            </div>
                          ))}
                        </div>
                        <div className="odds-track">
                          <div className="odds-yes" style={{width:`${selected.yes*100}%`}}/>
                        </div>
                        <div className="odds-labels">
                          <span style={{color:T.green}}>YES {pct(selected.yes)}</span>
                          <span style={{color:T.coral}}>NO {pct(selected.no)}</span>
                        </div>
                        <div className="extra-metrics">
                          {[
                            {label:"Volume",   value:fmtUSD(selected.volume),  color:T.ink},
                            {label:"Liquidity",value:fmtUSD(selected.liquidity),color:T.ink},
                            {label:"Est. APY", value:`~${calcAPY(selected.liquidity,1-Math.abs(selected.yes-0.5)*2)}%`, color:T.green},
                          ].map(s=>(
                            <div key={s.label} className="extra-cell">
                              <div className="extra-label">{s.label}</div>
                              <div className="extra-val" style={{color:s.color}}>{s.value}</div>
                            </div>
                          ))}
                        </div>
                        {(scoreHistory[selected.id]||[]).length>=2 && (
                          <div style={{marginTop:8,display:"flex",alignItems:"center",gap:8}}>
                            <span style={{fontSize:9,color:T.inkFaint,fontFamily:"'DM Mono',monospace",letterSpacing:"0.08em"}}>SCORE TREND</span>
                            <Sparkline data={scoreHistory[selected.id]} color={scoreColor(selected.score,T)} width={110} height={22}/>
                          </div>
                        )}
                        <Simulator market={selected} T={T}/>
                      </div>

                      <div className="analysis-card">
                        <div className="analysis-header">LP Analysis Report</div>
                        {aLoading ? (
                          <div>
                            <div style={{fontSize:10,color:T.inkFaint,marginBottom:8}}>Generating analysis…</div>
                            <div className="typing-row">
                              <div className="t-dot"/><div className="t-dot"/><div className="t-dot"/>
                              <span style={{fontSize:10,color:T.inkFaint,marginLeft:8}}>Processing market data</span>
                            </div>
                          </div>
                        ) : (
                          <div className="analysis-text">{analysis}</div>
                        )}
                      </div>

                      {!aLoading && analysis && (
                        <div className="action-row fade">
                          <a className="btn-cta" href={`https://polymarket.com/event/${selected.slug}`} target="_blank" rel="noopener noreferrer">
                            Open on Polymarket →
                          </a>
                          <button className={`btn-watch-cta ${watchlist.includes(selected.id)?"watching":""}`}
                            onClick={()=>toggleWatch(selected.id)}>
                            {watchlist.includes(selected.id)?"⭐":"☆"}
                          </button>
                          {!positions.some(p=>p.id===selected.id) && (
                            <button className="btn-cta-farm" onClick={()=>addPosition(selected)}>
                              + Track Position
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}

                  {rightTab==="farm" && (
                    <>
                      <div className="farm-detail">
                        <div className="farm-detail-title">💎 Farm Score Breakdown</div>
                        <div className="farm-metrics">
                          {[
                            {label:"Farm Score",   value:`${selected.farmScore||0}/100`},
                            {label:"$50 Pool Share", value:`${calcPoolShare(DEFAULT_CAPITAL, selected.liquidity)}%`},
                            {label:"Est. APY",     value:`~${calcAPY(selected.liquidity, 1-Math.abs(selected.yes-0.5)*2)}%`},
                            {label:"Odds Balance", value:`${Math.round((1-Math.abs(selected.yes-0.5)*2)*100)}%`},
                            {label:"Days Left",    value:daysLeft(selected.endDate)},
                            {label:"Volume",       value:fmtUSD(selected.volume)},
                          ].map(r=>(
                            <div key={r.label} className="farm-m">
                              <div className="farm-m-label">{r.label}</div>
                              <div className="farm-m-val">{r.value}</div>
                            </div>
                          ))}
                        </div>

                        {/* price stability sparkline */}
                        {(priceHistory[selected.id]||[]).length >= 2 && (
                          <div style={{marginTop:10}}>
                            <div style={{fontSize:9,color:T.purple,fontFamily:"'DM Mono',monospace",letterSpacing:"0.08em",marginBottom:5}}>YES PRICE STABILITY</div>
                            <Sparkline
                              data={(priceHistory[selected.id]||[]).map(p=>p.yes)}
                              color={T.purple} width={340} height={36}
                            />
                            <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:T.inkFaint,marginTop:3,fontFamily:"'DM Mono',monospace"}}>
                              <span>Oldest</span>
                              <span>Latest: {((priceHistory[selected.id]||[]).slice(-1)[0]?.yes*100||0).toFixed(1)}¢</span>
                            </div>
                          </div>
                        )}

                        {/* farm guidance */}
                        <div style={{marginTop:10,padding:10,background:T.paper,borderRadius:2,border:`1px solid ${T.purple}22`}}>
                          <div style={{fontSize:9,color:T.purple,fontFamily:"'DM Mono',monospace",letterSpacing:"0.1em",marginBottom:6,textTransform:"uppercase"}}>Farm Strategy Guide</div>
                          <div style={{fontSize:11,color:T.inkMid,fontFamily:"'DM Sans',sans-serif",lineHeight:1.7}}>
                            {selected.farmScore >= 75
                              ? `Strong farm candidate. Your $${DEFAULT_CAPITAL} captures ${calcPoolShare(DEFAULT_CAPITAL, selected.liquidity)}% of the pool — significant share in a thin market. Place resting orders within 2-3¢ of current midpoint (${((selected.yes*100).toFixed(0))}¢). Set exit alert at ±7¢ drift. Check this market daily.`
                              : selected.farmScore >= 50
                              ? `Moderate farm potential. Pool share is ${calcPoolShare(DEFAULT_CAPITAL, selected.liquidity)}% — decent but not dominant. Consider smaller position ($20-30) and tighter monitoring.`
                              : `Low farm score. Either the pool is too deep for small capital to matter, or odds are too skewed. Better opportunities exist in Farm Mode.`
                            }
                          </div>
                        </div>
                      </div>

                      <Simulator market={selected} T={T}/>

                      {!positions.some(p=>p.id===selected.id) && (
                        <div style={{marginTop:10}}>
                          <button className="btn-cta-farm" style={{width:"100%",display:"block"}}
                            onClick={()=>addPosition(selected)}>
                            + Add to Position Monitor
                          </button>
                        </div>
                      )}
                      {positions.some(p=>p.id===selected.id) && (
                        <div style={{marginTop:10,padding:"8px 12px",background:T.greenBg,border:`1px solid ${T.green}44`,borderRadius:2,fontSize:10,color:T.green,fontFamily:"'DM Mono',monospace"}}>
                          ◎ Already tracking in Position Monitor
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
