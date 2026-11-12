'use strict';

const START="rnbqkbnrpppppppp................................PPPPPPPPRNBQKBNR".split("").map(c=>c==="."?"":c);
const N=[[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
const K=[[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
const RD=[[-1,0],[1,0],[0,-1],[0,1]],BD=[[-1,-1],[-1,1],[1,-1],[1,1]],QD=RD.concat(BD);
const V={p:100,n:320,b:330,r:500,q:900,k:0};

function gen(s,col,att){
  const b=s.b,out=[],W=col==="w",opp=W?"b":"w";
  for(let i=0;i<64;i++){
    const p=b[i];if(!p||(p<"a")!==W)continue;
    const t=p.toLowerCase(),r=i>>3,f=i&7;
    const add=(to,x)=>out.push(Object.assign({from:i,to},x));
    if(t==="p"){
      const d=W?-1:1,nr=r+d;if(nr<0||nr>7)continue;
      const pm=to=>{if(nr===0||nr===7)for(const pr of"qrbn")add(to,{promo:pr});else add(to)};
      for(const df of[-1,1]){
        const nf=f+df;if(nf<0||nf>7)continue;
        const to=nr*8+nf,q=b[to];
        if(att||(q&&(q<"a")!==W))pm(to);
        else if(to===s.ep)add(to,{ep:1});
      }
      if(!att){const to=nr*8+f;if(!b[to]){pm(to);if(r===(W?6:1)&&!b[to+d*8])add(to+d*8,{dbl:1})}}
    }else if(t==="n"||t==="k"){
      for(const[dr,df]of(t==="n"?N:K)){
        const nr=r+dr,nf=f+df;if(nr<0||nr>7||nf<0||nf>7)continue;
        const to=nr*8+nf,q=b[to];
        if(att||!q||(q<"a")!==W)add(to);
      }
    }else{
      for(const[dr,df]of(t==="r"?RD:t==="b"?BD:QD)){
        let nr=r+dr,nf=f+df;
        while(nr>=0&&nr<8&&nf>=0&&nf<8){
          const to=nr*8+nf,q=b[to];
          if(att||!q||(q<"a")!==W)add(to);
          if(q)break;nr+=dr;nf+=df;
        }
      }
    }
  }
  if(!att){
    const hr=W?56:0,ki=hr+4;
    if(b[ki]===(W?"K":"k")&&!isAtt(s,ki,opp)){
      if(s.c.includes(W?"K":"k")&&!b[hr+5]&&!b[hr+6]&&b[hr+7]===(W?"R":"r")&&!isAtt(s,hr+5,opp))out.push({from:ki,to:hr+6,castle:1});
      if(s.c.includes(W?"Q":"q")&&!b[hr+1]&&!b[hr+2]&&!b[hr+3]&&b[hr]===(W?"R":"r")&&!isAtt(s,hr+3,opp))out.push({from:ki,to:hr+2,castle:1});
    }
  }
  return out;
}
const isAtt=(s,sq,by)=>gen(s,by,true).some(m=>m.to===sq);
const inCheck=(s,col)=>isAtt(s,s.b.indexOf(col==="w"?"K":"k"),col==="w"?"b":"w");

function apply(s,m){
  const b=s.b.slice(),p=b[m.from],W=p<"a",cap=b[m.to];
  b[m.to]=p;b[m.from]="";
  if(m.ep)b[m.to+(W?8:-8)]="";
  if(m.castle){const hr=W?56:0;if(m.to>m.from){b[hr+5]=b[hr+7];b[hr+7]=""}else{b[hr+3]=b[hr];b[hr]=""}}
  if(m.promo)b[m.to]=W?m.promo.toUpperCase():m.promo;
  let c=s.c;const rm=x=>{c=c.replace(x,"")};
  if(p==="K"){rm("K");rm("Q")}if(p==="k"){rm("k");rm("q")}
  for(const q of[m.from,m.to]){if(q===0)rm("q");if(q===7)rm("k");if(q===56)rm("Q");if(q===63)rm("K")}
  return{b,t:W?"b":"w",c,ep:m.dbl?(m.from+m.to)/2:-1,hm:(p.toLowerCase()==="p"||cap||m.ep)?0:s.hm+1};
}
const legal=s=>gen(s,s.t).filter(m=>!inCheck(apply(s,m),s.t));

function san(s,m,ls){
  const p=s.b[m.from],t=p.toLowerCase(),F="abcdefgh",sq=i=>F[i&7]+(8-(i>>3));
  if(m.castle)return m.to>m.from?"O-O":"O-O-O";
  const cap=s.b[m.to]||m.ep;let o="";
  if(t==="p"){if(cap)o=F[m.from&7]+"x";o+=sq(m.to);if(m.promo)o+="="+m.promo.toUpperCase();return o}
  o=t.toUpperCase();
  const am=ls.filter(x=>x!==m&&s.b[x.from]===p&&x.to===m.to);
  if(am.length)o+=am.some(x=>(x.from&7)===(m.from&7))?(am.some(x=>(x.from>>3)===(m.from>>3))?sq(m.from):8-(m.from>>3)):F[m.from&7];
  return o+(cap?"x":"")+sq(m.to);
}
const key=s=>{
  const W=s.t==="w",ep=s.ep>=0&&[-1,1].some(d=>{const f=(s.ep&7)+d;return f>=0&&f<8&&s.b[s.ep+(W?8:-8)+d]===(W?"P":"p")})?s.ep:-1;
  return s.b.map(p=>p||".").join("")+s.t+s.c+ep;
};
const castleOf=b=>(b[60]==="K"&&b[63]==="R"?"K":"")+(b[60]==="K"&&b[56]==="R"?"Q":"")+(b[4]==="k"&&b[7]==="r"?"k":"")+(b[4]==="k"&&b[0]==="r"?"q":"");
function fenOf(s){
  const r=[];
  for(let y=0;y<8;y++){let q="",e=0;for(let x=0;x<8;x++){const p=s.b[y*8+x];if(p){if(e){q+=e;e=0}q+=p}else e++}if(e)q+=e;r.push(q)}
  return r.join("/")+" "+s.t+" "+(s.c||"-")+" "+(s.ep>=0?"abcdefgh"[s.ep&7]+(8-(s.ep>>3)):"-")+" "+s.hm+" 1";
}
function parseFen(f){
  const p=f.trim().split(/\s+/),rows=p[0].split("/"),b=[];
  if(rows.length!==8)return null;
  for(const r of rows){
    let n=0;
    for(const ch of r){if(/[1-8]/.test(ch)){for(let k=0;k<+ch;k++)b.push("");n+=+ch}else if("pnbrqkPNBRQK".includes(ch)){b.push(ch);n++}else return null}
    if(n!==8)return null;
  }
  if(b.filter(x=>x==="K").length!==1||b.filter(x=>x==="k").length!==1)return null;
  if(b.slice(0,8).concat(b.slice(56)).some(x=>x==="P"||x==="p"))return null;
  const s={b,t:p[1]==="b"?"b":"w",c:[...(p[2]||"")].filter(x=>castleOf(b).includes(x)).join(""),ep:-1,hm:+p[4]||0};
  if(/^[a-h][36]$/.test(p[3]||"")){const e=(8-p[3][1])*8+"abcdefgh".indexOf(p[3][0]);if(s.t==="w"?(p[3][1]==="6"&&b[e+8]==="p"&&!b[e]):(p[3][1]==="3"&&b[e-8]==="P"&&!b[e]))s.ep=e}
  if(inCheck(s,s.t==="w"?"b":"w"))return null;
  return s;
}

// Is the game over? S = current position, hist = the positions before it (same rules as the page).
function endOf(S, hist) {
  const ls = legal(S);
  if (!ls.length) return inCheck(S, S.t) ? { result: S.t === 'w' ? '0-1' : '1-0', reason: 'checkmate' } : { result: '1/2-1/2', reason: 'stalemate' };
  if (S.hm >= 100) return { result: '1/2-1/2', reason: '50-move rule' };
  const k = key(S), pcs = S.b.filter(p => p && p.toLowerCase() !== 'k');
  if (hist.filter(h => key(h) === k).length >= 2) return { result: '1/2-1/2', reason: 'repetition' };
  if (pcs.length === 0 || (pcs.length === 1 && /[bn]/i.test(pcs[0])) ||
      (pcs.length > 1 && pcs.every(p => /b/i.test(p)) && new Set(S.b.map((p, i) => p && /b/i.test(p) ? ((i >> 3) + (i & 7)) % 2 : -1).filter(x => x >= 0)).size === 1))
    return { result: '1/2-1/2', reason: 'insufficient material' };
  return null;
}
const startState = () => ({ b: START.slice(), t: 'w', c: 'KQkq', ep: -1, hm: 0 });

module.exports = { START, legal, apply, san, inCheck, key, fenOf, parseFen, endOf, startState };
