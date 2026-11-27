/* Rainsong landing page, 6-inch L copy (product template "rainsong-6inch").
   Our set + colour picker drives the store's own Kaching Bundles widget and Blocky add-to-cart button,
   so the cart, discounts, tracking and checkout run exactly as on the standard product page.
   Nothing here changes the URL. */
(function(){
'use strict';
var $=function(id){return document.getElementById(id)};
var qa=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))};
var DATA={};try{DATA=JSON.parse(($('rs-data')||{}).textContent||'{}')}catch(e){}
var cur$=(window.Shopify&&Shopify.currency&&Shopify.currency.active)||DATA.currency||'USD';
var fmt=function(c){try{return new Intl.NumberFormat('en-US',{style:'currency',currency:cur$}).format(c/100)}catch(e){return '$'+(c/100).toFixed(2)}};
var fmt0=function(c){try{return new Intl.NumberFormat('en-US',{style:'currency',currency:cur$,maximumFractionDigits:0}).format(Math.floor(c/100))}catch(e){return '$'+Math.floor(c/100)}};
var money=function(t){var m=(t||'').replace(/,/g,'').match(/(\d+(?:\.\d{1,2})?)/);return m?Math.round(parseFloat(m[1])*100):null};
var wait=function(ms){return new Promise(function(r){setTimeout(r,ms)})};
/* resolve as soon as test() is true (checked every frame), or after max ms */
var until=function(test,max){return new Promise(function(res){var t0=performance.now();(function f(){var ok=false;try{ok=test()}catch(e){}if(ok||performance.now()-t0>max)return res();requestAnimationFrame(f)})()})};

/* ---------- state ---------- */
var sets=qa('.rs .set');
function curSet(){return document.querySelector('.rs .set.on')||sets.filter(function(x){return +x.dataset.q===1})[0]||sets[0]}
function qty(){var s=curSet();return s?+s.dataset.q:1}
function colours(){var s=curSet();return s?qa('.cl',s).map(function(cl){var r=cl.querySelector('input:checked');return r?r.value:null}):[]}

/* ---------- Kaching bridge ---------- */
function kBlock(){return document.querySelector('kaching-bundles-block .kaching-bundles__bars')?document.querySelector('kaching-bundles-block'):null}
function kSettings(){var s=document.querySelector('script.kaching-bundles-deal-block-settings');if(!s)return null;try{return JSON.parse(s.textContent)}catch(e){return null}}
var KS=null;
function barFor(q){KS=KS||kSettings();var b=kBlock();if(!KS||!b)return null;var d=(KS.dealBars||[]).filter(function(x){return +x.quantity===q})[0];return d?b.querySelector('[data-deal-bar-id="'+d.id+'"]'):null}
function kState(){var b=kBlock();if(!b)return null;var bar=b.querySelector('.kaching-bundles__bar--selected');if(!bar)return null;
  return {bar:bar,cols:qa('select.kaching-bundles__bar-variant-select',bar).map(function(s){return s.value})}}
function kMatches(){var st=kState(),want=barFor(qty());if(!st||!want)return false;if(st.bar!==want)return false;var c=colours();
  return st.cols.length===c.length&&st.cols.every(function(v,i){return v===c[i]})}
var syncing=null;
function kSync(){
  if(syncing)return syncing;
  var p=(async function(){
    for(var attempt=0;attempt<4&&!kMatches();attempt++){
      var bar=barFor(qty());if(!bar)break;
      if(!bar.classList.contains('kaching-bundles__bar--selected')){var r=bar.querySelector('input[type=radio]');(r||bar).click();var q0=qty();await until(function(){var b=barFor(q0);return b&&b.classList.contains('kaching-bundles__bar--selected')},300)}
      bar=barFor(qty());var c=colours();
      qa('select.kaching-bundles__bar-variant-select',bar).forEach(function(s,i){if(c[i]&&s.value!==c[i]){s.value=c[i];s.dispatchEvent(new Event('input',{bubbles:true}));s.dispatchEvent(new Event('change',{bubbles:true}))}});
      await until(kMatches,200);
    }
    return kMatches();
  })();
  /* clear only after the run settles (a run that never awaits finishes before this line) */
  syncing=p;var clr=function(){if(syncing===p)syncing=null};p.then(clr,clr);return p;
}
/* read real prices from Kaching (falls back to the Liquid-rendered numbers) */
function kDealTot(d,per,q){
  var v=+d.discountValue;
  if(d.discountType!=='specific'||!(v>0))return per*q;
  var rate=(window.Shopify&&Shopify.currency&&+Shopify.currency.rate)||1;
  var native=Math.round(v*100);
  var converted=Math.round(v*100*rate);
  if(Math.abs(converted-native)<2)return converted;
  var dealCur=KS&&KS.currency,dealMarket=KS&&KS.marketId,cfg=null;
  try{
    var el=document.getElementById('kaching-bundles-config');
    if(el)cfg=JSON.parse(el.textContent);
  }catch(e){}
  var mid=function(x){return String(x||'').replace(/\D/g,'')};
  var marketCur=(cfg&&cfg.marketCurrencyCode)||(window.Shopify&&Shopify.currency&&Shopify.currency.active)||'';
  if(dealCur&&marketCur&&String(dealCur).toUpperCase()===String(marketCur).toUpperCase())return native;
  if(dealMarket&&cfg&&cfg.marketId&&mid(dealMarket)&&mid(dealMarket)===mid(cfg.marketId))return native;
  if(per){
    var ref=per*q;
    if(Math.abs(native-ref)<Math.abs(converted-ref))return native;
  }
  return converted;
}
function kPrices(){var out={};KS=KS||kSettings();if(!KS)return out;
  (KS.dealBars||[]).forEach(function(d){var bar=barFor(+d.quantity);if(!bar)return;
    var per=money((bar.querySelector('.kaching-bundles__bar-price')||{}).textContent),full=Math.max.apply(null,qa('.kaching-bundles__bar-full-price',bar).map(function(e){return money(e.textContent)||0}).concat([0]));
    var q=+d.quantity,tot=kDealTot(d,per,q);/* fixed bundle price: Kaching's exact total, not rounded per-drum x qty */
    var rw=rrpWas(q);
    if(per)out[q]={per:per,tot:tot,was:rw>tot?rw:(full&&full>tot?full:null)}});
  return out}
/* RRP per drum (owner t141u/t142u/t143u): "was" = RRP x qty in USD/GBP, same as the Liquid rs_rrp and the product compare-at.
   To remove: set RS_RRP={} (falls back to Kaching's compare-at x qty). */
var RS_RRP={USD:150,GBP:120};
function rrpWas(q){var r=RS_RRP[String(cur$||'').toUpperCase()];return r?Math.round(r*100)*q:0}/* cents, like per/tot */
/* % off rounds to the nearest whole number, same as Kaching (owner t142u "like your table": 33/47/56/58) */
function pctOff(s,w){return w>0?Math.round(s*100/w):0}
function paintPrices(){var P=kPrices();
  sets.forEach(function(s){var q=+s.dataset.q,p=P[q];if(!p)return;s._p=p;
    var set=function(f,v){var e=s.querySelector('[data-f="'+f+'"]');if(e)e.textContent=v};
    set('per',fmt(p.per));set('tot',fmt(p.tot));
    if(p.was){set('was',fmt(p.was));var sv=p.was-p.tot;set('save','Save '+fmt0(sv));set('pc',pctOff(sv,p.was)+'% off')}});
  var p4=P[4]||P[Math.max.apply(null,Object.keys(P).map(Number).concat([0]))];
  if(p4){qa('[data-f="from"]').forEach(function(e){e.textContent='From '+fmt(p4.per)});
    if(p4.was)qa('[data-f="maxoff"]').forEach(function(e){e.textContent=pctOff(p4.was-p4.tot,p4.was)+'%'});
    if(P[1])qa('[data-f="range"]').forEach(function(e){e.textContent=fmt(p4.per)+'–'+fmt(P[1].per)+' a drum'})}
  paintSummary()}
function txt(s,f){var e=s&&s.querySelector('[data-f="'+f+'"]');return e?e.textContent:''}
function paintSummary(){var s=curSet();if(!s)return;var n=+s.dataset.q,one=sets.filter(function(x){return +x.dataset.q===1})[0],two=sets.filter(function(x){return +x.dataset.q===2})[0];
  var set=function(id,v,h){var e=$(id);if(e){h?e.innerHTML=v:e.textContent=v}};
  var tot=txt(s,'tot');set('pp',tot);set('ps',txt(s,'was'));set('po',txt(s,'pc'));
  set('pq',n===1?'<b>'+txt(s,'tot')+' for one drum.</b> 2 drums: '+txt(two,'per')+' each.':'<b>'+n+' drums, '+txt(s,'per')+' each.</b> Or '+txt(one,'tot')+' for one.',1);
  set('atcp2',tot);var rb=realBtn();if(rb&&tot)rb.style.setProperty('--rs-price',JSON.stringify(tot));set('stp',tot);set('stn',n+(n>1?' drums':' drum'));set('bt1',n+(n>1?' drums':' drum')+' + '+(n*6)+' bonus pieces');set('bt2',tot);set('stk',(n*6)+' bonuses included')}

/* ---------- set picker ---------- */
function pick(i){var prev=drum1Colour();sets.forEach(function(s,k){s.classList.toggle('on',k===i);var r=s.querySelector('input[name=set]');if(r)r.checked=k===i});
  if(prev){var r=document.querySelector('.rs .set.on .cl input[value="'+prev+'"]');if(r)r.checked=true}
  paintSummary();syncColour();kSync()}
sets.forEach(function(s,i){var r=s.querySelector('input[name=set]');if(r)r.addEventListener('change',function(){if(r.checked)pick(i)})});
function drum1Colour(){var r=document.querySelector('.rs .set.on .cl input:checked');return r?r.value:null}

/* ---------- hero gallery ---------- */
var tr=$('track'),cur=0,N=tr?tr.children.length:0;
function setCur(i){if(!tr||(i===cur&&tr.dataset.init))return;tr.dataset.init=1;cur=i;
  var c=$('cnt');if(c)c.textContent=(i+1)+' / '+N;var tb=$('thumbs');
  if(tb){qa('button',tb).forEach(function(b,k){b.classList.toggle('on',k===i)});var b=tb.children[i];if(b)tb.scrollTo({left:b.offsetLeft-tb.clientWidth/2+b.offsetWidth/2,behavior:'smooth'})}
  var p=document.querySelector('.rs .arw.p'),n=document.querySelector('.rs .arw.n');if(p)p.disabled=i===0;if(n)n.disabled=i===N-1;
  var gal=tr.closest('.rs-gal, .gal'), sl=tr.children[i];
  var hide=!!(sl&&(sl.getAttribute('data-kit')==='1'||sl.querySelector('img.ct')));
  if(gal){gal.classList.toggle('kit-on',hide);var pill=gal.querySelector(':scope > .listen')||gal.querySelector('.listen');if(pill){pill.hidden=hide;pill.setAttribute('aria-hidden',hide?'true':'false');if(hide)pill.tabIndex=-1;else pill.removeAttribute('tabindex')}}}
function go(i){if(!tr)return;i=Math.max(0,Math.min(N-1,i));tr.scrollTo({left:i*tr.clientWidth,behavior:'smooth'});setCur(i)}
function syncColour(col){var c=col||drum1Colour();if(!c||!tr)return;var sl=Array.prototype.slice.call(tr.children);
  if(sl[cur]&&sl[cur].dataset.colour===c)return;var t=sl.findIndex(function(x){return x.dataset.render&&x.dataset.colour===c});if(t>=0)go(t)}
if(tr){var raf;tr.addEventListener('scroll',function(){cancelAnimationFrame(raf);raf=requestAnimationFrame(function(){setCur(Math.round(tr.scrollLeft/tr.clientWidth))})},{passive:true});
  var dx=null,sl0=0;tr.addEventListener('mousedown',function(e){dx=e.clientX;sl0=tr.scrollLeft;tr.style.scrollSnapType='none'});
  window.addEventListener('mousemove',function(e){if(dx!==null)tr.scrollLeft=sl0-(e.clientX-dx)});
  window.addEventListener('mouseup',function(e){if(dx===null)return;var d=e.clientX-dx;dx=null;tr.style.scrollSnapType='';go(cur+(d<-40?1:d>40?-1:0))});
  tr.addEventListener('keydown',function(e){if(e.key==='ArrowRight')go(cur+1);if(e.key==='ArrowLeft')go(cur-1)});tr.tabIndex=0;setCur(0)}
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.rs [data-go]');if(!b)return;var g=b.dataset.go;go(g==='prev'?cur-1:g==='next'?cur+1:+g)});
/* hero follows the most recent colour pick on any drum */
document.addEventListener('change',function(e){var t=e.target;if(t.matches&&t.matches('.rs .set.on .cl input')){syncColour(t.value);kSync()}});
document.addEventListener('click',function(e){var t=e.target;if(t.matches&&t.matches('.rs .set.on .cl input'))syncColour(t.value)});

/* ---------- scroll links (no URL change) ---------- */
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.rs [data-scroll]');if(!b)return;e.preventDefault();var t=$(b.dataset.scroll);if(!t)return;var d=Math.abs(t.getBoundingClientRect().top);t.scrollIntoView({behavior:d>1600?'auto':'smooth',block:'start'})});

/* ---------- add to cart: always through the store's own button ---------- */
function realBtn(){return document.querySelector('form.blocky-product-form [data-blocky-add-button]')}
var passing=false;
document.addEventListener('click',function(e){var b=realBtn();if(!b||passing)return;if(!(e.target===b||b.contains(e.target)))return;
  if(!kBlock()){fallbackForm();return}           /* Kaching not on the page: plain single-line add */
  if(kMatches())return;                          /* already in sync, let Blocky + Kaching handle it */
  e.preventDefault();e.stopImmediatePropagation();
  kSync().then(function(){passing=true;try{b.click()}finally{passing=false}})},true);
function fallbackForm(){var f=document.querySelector('form.blocky-product-form');if(!f)return;var c=colours(),id=(DATA.variants||{})[c[0]];
  var i=f.querySelector('[data-blocky-variant-id]');if(i&&id)i.value=id;var q=f.querySelector('[name=quantity]');if(q)q.value=qty()}
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.rs [data-atc]');if(!b)return;e.preventDefault();var r=realBtn();if(r)r.click()});
/* sync Kaching the moment a finger/mouse goes down on any add button, so the click itself goes straight through */
['pointerdown','touchstart'].forEach(function(ev){document.addEventListener(ev,function(e){var t=e.target;if(!t.closest)return;var rb=realBtn();if(t.closest('.rs [data-atc]')||(rb&&(t===rb||rb.contains(t)))){if(kBlock()&&!kMatches())kSync()}},{passive:true,capture:true})});
/* instant feedback while the store's cart adds the items; cleared when the drawer opens (or after 4s) */
var addT=0,H=document.documentElement;function adding(on){H.classList.toggle('rs-adding',on);clearTimeout(addT);if(on)addT=setTimeout(function(){adding(false)},4000)}
document.addEventListener('click',function(e){var rb=realBtn(),t=e.target;if(!t.closest)return;if(t.closest('.rs [data-atc]')||(rb&&(t===rb||rb.contains(t))))adding(true)},true);
new MutationObserver(function(){if(H.classList.contains('essential-cart__open')&&H.classList.contains('rs-adding'))adding(false)}).observe(H,{attributes:true,attributeFilter:['class']});

/* ---------- sticky bar ---------- */
var st=$('sticky');
function initSticky(){if(!st)return;var raf2=0;
  var upd=function(){raf2=0;var btn=realBtn();if(!btn)return;var vh=innerHeight,r=btn.getBoundingClientRect(),past=r.bottom<0;
    var vis=[btn,$('buy')].concat(qa('.rs .atc, .rs [data-atc]').filter(function(x){return !st.contains(x)})).some(function(x){if(!x)return false;var q=x.getBoundingClientRect();return q.height>0&&q.bottom>8&&q.top<vh-8});
    /* t44u: don't cover the gift grid with the sticky bar */
    var grid=document.querySelector('#box .bgrid')||$('box');
    var overGrid=false;
    if(grid){var g=grid.getBoundingClientRect(),sh=Math.max(st.offsetHeight||0,72)+16;overGrid=g.bottom>vh-sh&&g.top<vh}
    var on=past&&!vis&&!overGrid;if(st.classList.contains('show')!==on){st.classList.toggle('show',on);st.inert=!on;st.setAttribute('aria-hidden',String(!on))}};
  var req=function(){if(!raf2)raf2=requestAnimationFrame(upd)};
  addEventListener('scroll',req,{passive:true});addEventListener('resize',req);st.inert=true;upd()}
/* ---------- who's it for ---------- */
document.addEventListener('click',function(e){var c=e.target.closest&&e.target.closest('.rs [data-who]');if(!c)return;var i=+c.dataset.who;
  qa('.rs .chip').forEach(function(x,k){x.classList.toggle('on',k===i);x.setAttribute('aria-checked',k===i)});
  ['#whoimg img','#fl p','#gn i'].forEach(function(q){qa(q).forEach(function(x,k){x.classList.toggle('on',k===i)})})});
addEventListener('load',function(){(window.requestIdleCallback||setTimeout)(function(){qa('#whoimg img').forEach(function(im){var p=new Image();p.src=im.currentSrc||im.src})})});

/* ---------- customer videos: load on tap ---------- */
document.addEventListener('click',function(e){var b=e.target.closest&&e.target.closest('.rs .vc .pb');if(!b)return;var fig=b.closest('.vc');
  qa('.rs .vc video').forEach(function(v){if(!fig.contains(v))v.pause()});
  var v=fig.querySelector('video');if(!v){v=document.createElement('video');v.src=b.dataset.src;v.playsInline=true;v.controls=true;v.preload='auto';var im=fig.querySelector('img');if(im)v.poster=im.src;fig.insertBefore(v,fig.firstChild)}
  fig.classList.add('playing');v.play().catch(function(){})});


/* ---------- Judge.me testimonial arrows + dots (t36u) ---------- */
function initJdgmNav(){
  var sec=document.querySelector('body:has(.rs-top) .shopify-section:has(.jdgm-widget), body:has(.rs-top) .shopify-section:has([class*="jdgm"])');
  if(!sec||sec.dataset.rsJdgmNav)return;
  var track=sec.querySelector('.jdgm-cards-wrapper, .jdgm-videos-container, [class*="jdgm-cards"], [class*="carousel"] [class*="track"], [class*="jdgm"][class*="swiper-wrapper"]');
  /* cards are the review slides, not media-only inner bits */
  var cards=[].slice.call(sec.querySelectorAll('.jdgm-card, .jdgm-carousel-item, [class*="jdgm"][class*="card"]')).filter(function(c){return c.querySelector('.jdgm-product-name, [class*="review"], .jdgm-rev, p, blockquote')});
  if(cards.length<2){
    /* widget may load late */
    return false;
  }
  sec.dataset.rsJdgmNav=1;
  /* hide product labels (Shipping protection etc.) */
  sec.querySelectorAll('.jdgm-product-name, .jdgm-rev__prod').forEach(function(e){e.hidden=true});
  var nativeNext=sec.querySelector('[aria-label*="ext" i], [class*="arrow"][class*="next" i], [class*="jdgm"][class*="next" i], button[class*="next" i]');
  var nativePrev=sec.querySelector('[aria-label*="rev" i], [aria-label*="prev" i], [class*="arrow"][class*="prev" i], [class*="jdgm"][class*="prev" i], button[class*="prev" i]');
  /* Wrap only the card track so the heading stays full width above the arrows (t44u) */
  var host=track||cards[0].parentElement;
  if(!host)return true;
  var wrap;
  if(host.classList.contains('rs-jdgm-wrap')) wrap=host;
  else if(host.parentElement&&host.parentElement.classList.contains('rs-jdgm-wrap')) wrap=host.parentElement;
  else {wrap=document.createElement('div');wrap.className='rs-jdgm-wrap';host.parentNode.insertBefore(wrap,host);wrap.appendChild(host)}
  var header=sec.querySelector('.jdgm-header');
  if(header&&wrap.contains(header)) wrap.parentNode.insertBefore(header,wrap);
  host=wrap;
  function btn(dir,label){
    var b=document.createElement('button');b.type='button';b.className='rs-jdgm-nav '+dir;
    b.setAttribute('aria-label',label);
    b.innerHTML=dir==='prev'
      ?'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>'
      :'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>';
    return b;
  }
  var prev=btn('prev','Previous review'), next=btn('next','Next review');
  host.appendChild(prev);host.appendChild(next);
  var dots=document.createElement('div');dots.className='rs-jdgm-dots';dots.setAttribute('role','tablist');dots.setAttribute('aria-label','Reviews');
  host.appendChild(dots);
  function idx(){
    /* prefer the card most visible in the host */
    var box=host.getBoundingClientRect(),best=0,bestA=-1;
    cards.forEach(function(c,i){var r=c.getBoundingClientRect();var a=Math.max(0,Math.min(r.right,box.right)-Math.max(r.left,box.left));if(a>bestA){bestA=a;best=i}});
    return best;
  }
  function paint(){
    var i=idx();
    [].forEach.call(dots.querySelectorAll('button'),function(d,k){d.setAttribute('aria-current',k===i?'true':'false')});
  }
  cards.forEach(function(c,i){
    var d=document.createElement('button');d.type='button';d.setAttribute('role','tab');d.setAttribute('aria-label','Review '+(i+1));
    d.addEventListener('click',function(){go(i)});
    dots.appendChild(d);
  });
  function go(i){
    i=(i+cards.length)%cards.length;
    var c=cards[i];
    if(nativeNext&&nativePrev){
      var cur=idx(),step=0;
      var tick=function(){
        if(idx()===i||step++>cards.length+2){paint();return}
        (i>cur?nativeNext:nativePrev).click();
        requestAnimationFrame(function(){setTimeout(tick,80)});
      };
      if(i!==cur)tick();else paint();
      return;
    }
    if(c&&c.scrollIntoView){c.scrollIntoView({behavior:'smooth',inline:'center',block:'nearest'});setTimeout(paint,350)}
  }
  prev.addEventListener('click',function(){go(idx()-1)});
  next.addEventListener('click',function(){go(idx()+1)});
  paint();
  if(track)track.addEventListener('scroll',function(){clearTimeout(track._t);track._t=setTimeout(paint,80)},{passive:true});
  return true;
}
var jdgmTries=0;(function waitJdgm(){if(initJdgmNav()||++jdgmTries>40)return;setTimeout(waitJdgm,300)})();


/* ---------- countdown copy (owner t128u) ----------
   6-inch L only: the store-wide Essential banner says "up to 30% OFF"; this page shows its own true max instead
   (RRP t141u: 4 drums $249.99 vs $600 = 58.3% -> "up to 58% OFF"; UK £199.99 vs £480 = 58.3% -> 58%).
   The number comes from this page's own [data-f="maxoff"] (Liquid, then repainted from Kaching), so it always matches
   the pack prices. Same approach as the XL's 30%->65% swap in rainsong.js; the app and other pages are unchanged. */
function rsMaxOff(){var e=document.querySelector('.rs [data-f="maxoff"]');var m=e&&String(e.textContent).match(/(\d{1,2})\s*%/);return m?+m[1]:0}
function swapCountdownOff(){
  var root=document.querySelector('.essential_countdown_annoucement_bar_wrapper, [class*="essential_countdown"]');
  var n=rsMaxOff();if(!root||!n)return false;var hit=false;
  (function walk(node){if(!node)return;
    if(node.nodeType===3){var v=node.nodeValue;
      if(v&&/\b\d{1,2}%\s*OFF/i.test(v)){var w=v.replace(/\b\d{1,2}%(\s*OFF)/ig,n+'%$1');if(w!==v){node.nodeValue=w}hit=true}}
    else{if(node.shadowRoot)walk(node.shadowRoot);var ch=node.childNodes;if(ch)for(var i=0;i<ch.length;i++)walk(ch[i])}})(root);
  return hit}
(function watchCountdown(){
  if(!document.querySelector('.rs-top'))return;
  var tries=0,obs=null,busy=false;
  function arm(){var root=document.querySelector('.essential_countdown_annoucement_bar_wrapper, [class*="essential_countdown"]');
    if(!root||!rsMaxOff()){if(++tries<120)setTimeout(arm,250);return}
    swapCountdownOff();
    obs=new MutationObserver(function(){if(busy)return;busy=true;try{swapCountdownOff()}finally{busy=false}});
    obs.observe(root,{subtree:true,childList:true,characterData:true});
    var mo=document.querySelector('.rs [data-f="maxoff"]');if(mo)new MutationObserver(swapCountdownOff).observe(mo,{subtree:true,childList:true,characterData:true})}
  arm()})();

/* ---------- boot ---------- */
paintSummary();syncColour();initSticky();
var tries=0;(function boot(){if(kBlock()&&qa('.kaching-bundles__bar-price').length){paintPrices();kSync();
  new MutationObserver(function(){clearTimeout(boot.t);boot.t=setTimeout(paintPrices,80)}).observe(kBlock(),{subtree:true,childList:true,characterData:true});return}
  if(++tries<80)setTimeout(boot,150)})();
})();
