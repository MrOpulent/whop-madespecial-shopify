/* Rainsong add-ons: gift box & wrap (per drum) on the buy box; 9-note offer in the cart drawer only. */
(function(){
  if(window.__rsAddons)return;window.__rsAddons=1;
  var MAIN_PID=15490220327094,WRAP='gift-box-wrap',MINI='add-1-more-rain-drum';
  var css='.rs .adds{padding:14px 16px 0;margin:0;border:0;min-width:0;max-width:100%}.rs .add .tt>span:first-child{min-width:0}.rs .adds legend{padding:0}.rs .add{display:grid;grid-template-columns:24px 52px 1fr;gap:12px;align-items:center;padding:12px 14px;border:1px solid var(--line);background:var(--card);cursor:pointer;position:relative;-webkit-tap-highlight-color:transparent;border-radius:14px;overflow:hidden}.rs .add.on{border:1.5px solid var(--ink);z-index:2;background:#fffefb}.rs .add .bx{width:22px;height:22px;border-radius:4px;border:1.5px solid #8F877A;display:grid;place-items:center;background:#fff}.rs .add.on .bx{background:var(--ink);border-color:var(--ink)}.rs .add.on .bx:after{content:"";width:11px;height:6px;border:2px solid #fff;border-top:0;border-right:0;transform:translateY(-1px) rotate(-45deg)}.rs .add .th{width:52px;height:52px;border-radius:10px;background:var(--paper-2);display:grid;place-items:center;overflow:hidden;color:var(--holly)}.rs .add .th img{width:100%;height:100%;object-fit:cover}.rs .add .tx{min-width:0}.rs .add .tt{display:flex;justify-content:space-between;gap:8px;align-items:baseline;font-size:16px;font-weight:600;color:var(--ink);line-height:1.25}.rs .add .tt .p{white-space:nowrap;font-weight:600;font-variant-numeric:tabular-nums;text-align:right;line-height:1.2}.rs .add .tt s,.rs .add .tt .u{display:block;font-weight:400;color:var(--muted);font-size:12.5px;margin:2px 0 0}.rs .add .ds{display:block;font-size:13.5px;color:var(--muted);line-height:1.35;margin-top:3px}.rs .add input:focus-visible+.bx{outline:2px solid var(--teal);outline-offset:2px}.rs .adds .ah{font-size:13px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;color:var(--gold-ink);margin:0 0 10px}';
  var dcss='#rs-mini-offer{box-sizing:border-box;display:block;width:auto;max-width:100%;height:auto!important;min-height:0;max-height:none;flex:0 0 auto;align-self:stretch;position:relative;float:none;clear:both;overflow:hidden;background:#e2ecec;border:1px solid #C9DCE3;border-radius:14px;padding:12px;margin:8px 12px 10px;font-family:inherit;color:#1F3540}#rs-mini-offer *,#rs-mini-offer *::before,#rs-mini-offer *::after{box-sizing:border-box}#rs-mini-offer .rsmo-hd{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;column-gap:8px;row-gap:6px;margin:0 0 12px;min-height:28px}#rs-mini-offer .rsmo-ht{grid-column:2;justify-self:center;min-width:0;font-size:14px;font-weight:600;text-align:center;line-height:1.3}#rs-mini-offer .rsmo-pill{grid-column:3;justify-self:end;position:static;transform:none;background:#202223;color:#fff;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;border-radius:7px;padding:4px 8px;white-space:nowrap}#rs-mini-offer .rsmo-bd{display:grid;grid-template-columns:64px minmax(0,1fr) auto;gap:10px 12px;align-items:center;width:100%;max-width:100%;min-width:0;position:relative;float:none;background:#fff;border:1px solid #C9DCE3;border-radius:10px;padding:10px 12px;overflow:hidden}#rs-mini-offer .rsmo-bd img{width:64px;height:64px;object-fit:cover;border-radius:10px;background:#f3f3f3;display:block}#rs-mini-offer .rsmo-meta{min-width:0}#rs-mini-offer .rsmo-nm{font-size:14px;font-weight:600;line-height:1.3;color:#1F3540;margin:0 0 4px;overflow-wrap:break-word}#rs-mini-offer .rsmo-pr{font-size:14px;color:#303030;font-variant-numeric:tabular-nums;margin:0 0 5px}#rs-mini-offer .rsmo-pr s{color:#616161;margin-left:6px;font-weight:400}#rs-mini-offer .rsmo-save{display:inline-block;background:#D9D9D9;color:#202223;font-size:12px;border-radius:7px;padding:2px 7px;line-height:1.3}#rs-mini-offer .rsmo-add{appearance:none;-webkit-appearance:none;border:0;background:#4A6D7C;color:#fff;font:500 13px/1 inherit;border-radius:14px;padding:10px 12px;cursor:pointer;white-space:nowrap;min-height:36px;flex-shrink:0;align-self:center}#rs-mini-offer .rsmo-add:hover{background:#3e5c69}#rs-mini-offer .rsmo-add:disabled{opacity:.6;cursor:default}@media(max-width:360px){#rs-mini-offer .rsmo-hd{display:flex;flex-wrap:wrap;justify-content:center}#rs-mini-offer .rsmo-ht{flex:1 0 100%;text-align:center}#rs-mini-offer .rsmo-pill{flex:0 0 auto}}';
  function money(c){var cur=(window.Shopify&&Shopify.currency&&Shopify.currency.active)||'USD';try{return new Intl.NumberFormat(cur==='GBP'?'en-GB':'en-US',{style:'currency',currency:cur}).format(c/100)}catch(e){return (c/100).toFixed(2)}}
  function parseMoney(t){if(!t)return 0;var n=String(t).replace(/[^0-9.,]/g,'').replace(/,/g,'');var v=parseFloat(n);return isFinite(v)?Math.round(v*100):0}
  function rf(){return window.__kachingBundlesRawFetch||window.fetch}
  function getJ(u){return fetch(u,{credentials:'same-origin',headers:{Accept:'application/json'}}).then(function(r){if(!r.ok)throw 0;return r.json()})}
  var P={},box,busy=false;
  function drums(){var s=document.querySelector('.rs .set.on');return s?Math.max(1,parseInt(s.getAttribute('data-q'),10)||1):1}
  var GIFT='<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="8" width="17" height="4"/><path d="M5 12v8h14v-8M12 8v12M12 8c-1.5-3-5-3.5-5-1.2C7 8 9.5 8 12 8zm0 0c1.5-3 5-3.5 5-1.2C17 8 14.5 8 12 8z"/></svg>';
  function row(k,th,title,price,desc){return '<label class="add" data-add="'+k+'"><input class="vh" type="checkbox" name="rs-add-'+k+'"><span class="bx" aria-hidden="true"></span><span class="th">'+th+'</span><span class="tx"><span class="tt"><span>'+title+'</span><span class="p" data-p>'+price+'</span></span><span class="ds" data-d>'+desc+'</span></span></label>'}
  function wrapDesc(){var q=drums(),w=P.wrap;var t='Arrives gift-boxed and wrapped, ready to give.';if(w&&q>1)t='All '+q+' drums arrive gift-boxed and wrapped · '+money(w.price*q)+' total.';return t}
  function wrapPrice(){return money(P.wrap.price)+'<small class="u">per drum</small>'}
  function render(){
    var buy=document.getElementById('buy');if(!buy||box)return;
    var st=document.createElement('style');st.textContent=css;document.head.appendChild(st);
    box=document.createElement('fieldset');box.className='adds';box.id='adds';
    var h='<legend class="vh">Add to your order</legend><p class="ah" aria-hidden="true">Add to your order</p>';
    if(P.wrap)h+=row('wrap',GIFT,'Gift box &amp; wrap',wrapPrice(),wrapDesc());
    box.innerHTML=h;buy.parentNode.insertBefore(box,buy.nextSibling);
    box.addEventListener('change',function(e){var l=e.target.closest('.add');if(l)l.classList.toggle('on',e.target.checked);paintBtns()});
    buy.addEventListener('click',function(){setTimeout(function(){upd();paintBtns()},60)});
    paintBtns();
  }
  function upd(){if(!box||!P.wrap)return;var d=box.querySelector('[data-add=wrap] [data-d]');if(d)d.textContent=wrapDesc()}
  function chosen(k){var i=box&&box.querySelector('[data-add='+k+'] input');return !!(i&&i.checked)}
  function baseTot(){var s=document.querySelector('.rs .set.on [data-f="tot"]');return parseMoney(s&&s.textContent)}
  var painting=false;
  function paintBtns(){
    if(painting)return;
    painting=true;
    try{
      var extra=(P.wrap&&chosen('wrap'))?P.wrap.price*drums():0;
      var shown=money(baseTot()+extra);
      var rb=document.querySelector('form.blocky-product-form [data-blocky-add-button]');
      if(rb){var cur=rb.style.getPropertyValue('--rs-price');var nxt=JSON.stringify(shown);if(cur!==nxt)rb.style.setProperty('--rs-price',nxt)}
      ['atcp2','bt2','stp'].forEach(function(id){var e=document.getElementById(id);if(e&&e.textContent!==shown)e.textContent=shown});
    }finally{painting=false}
  }
  function prep(){
    return getJ('/cart.js').then(function(c){
      var have={},xl=0;c.items.forEach(function(i){have[i.variant_id]=(have[i.variant_id]||0)+i.quantity;if(i.product_id===MAIN_PID)xl+=i.quantity});
      var add=[],chg=null;
      if(P.wrap&&chosen('wrap')){var want=xl+drums(),cur=have[P.wrap.id]||0;if(!cur)add.push({id:P.wrap.id,quantity:want});else if(cur!==want)chg={id:String(P.wrap.id),quantity:want}}
      var j=[];
      if(add.length)j.push(rf().call(window,'/cart/add.js',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({items:add})}));
      if(chg)j.push(rf().call(window,'/cart/change.js',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify(chg)}));
      return Promise.all(j);
    });
  }
  document.addEventListener('click',function(e){
    var b=e.target.closest&&e.target.closest('form.blocky-product-form [data-blocky-add-button], [data-atc]');
    if(!b||!box||b.__rsGo)return;
    if(!chosen('wrap'))return;
    e.preventDefault();e.stopImmediatePropagation();
    if(busy)return;busy=true;
    var go=function(){busy=false;b.__rsGo=1;try{b.click()}finally{b.__rsGo=0}};
    var t=setTimeout(go,4000);
    prep().catch(function(){}).then(function(){clearTimeout(t);if(busy)go()});
  },true);
  /* Keep button totals in sync when the set changes (rainsong.js repaints #stp / --rs-price). */
  document.addEventListener('click',function(e){if(e.target.closest&&e.target.closest('.rs .set, .rs .sets'))setTimeout(function(){upd();paintBtns()},80)});
  var mo=new MutationObserver(function(){
    if(painting)return;
    clearTimeout(paintBtns._t);
    paintBtns._t=setTimeout(paintBtns,50);
  });
  function watchPrices(){
    /* Observe the source price only. Never watch #atcp2/#stp — paintBtns writes those and would retrigger itself. */
    var e=document.getElementById('pp');
    if(e)mo.observe(e,{childList:true,characterData:true,subtree:true});
  }

  function saveAmt(){return Math.max(0,(P.mini&&P.mini.was>P.mini.price)?(P.mini.was-P.mini.price):0)}
  function pillTxt(){var s=saveAmt();var cur=(window.Shopify&&Shopify.currency&&Shopify.currency.active)||'USD';var sym=cur==='GBP'?'£':'$';return 'SAVE '+sym+Math.round(s/100)}
  function drawerHasMini(items){return (items||[]).some(function(i){return i.product_id===15425500709046||(P.mini&&i.variant_id===P.mini.id)})}
  function hideNativeMini(root){
    if(!root||root.getAttribute('data-rs-mini-native')==='hidden')return;
    var nodes=root.querySelectorAll('h2,h3,[class*="upsell"],[class*="offer"],[data-essential-cart-element*="upsell"]');
    for(var i=0;i<nodes.length;i++){
      var t=(nodes[i].textContent||'').replace(/\s+/g,' ').trim();
      if(t.length>500)continue;
      if(/Add One More for Gifting/.test(t) && /Add 1 More Rain Drum/.test(t)){
        var offer=nodes[i].closest('[class*="upsell"],[class*="offer"],[data-essential-cart-element*="upsell"]')||nodes[i];
        if(offer&&offer!==root){offer.style.display='none';root.setAttribute('data-rs-mini-native','hidden')}
      }
    }
  }
  function mountMini(root,items){
    var existing=document.getElementById('rs-mini-offer');
    if(!P.mini||drawerHasMini(items)){if(existing)existing.remove();hideNativeMini(root);return}
    hideNativeMini(root);
    if(existing)return;
    var el=document.createElement('div');el.id='rs-mini-offer';
    if(!document.getElementById('rs-mini-offer-css')){var st=document.createElement('style');st.id='rs-mini-offer-css';st.textContent=dcss;document.head.appendChild(st)}
    el.innerHTML='<div class="rsmo-hd"><span class="rsmo-ht">Add One More for Gifting \uD83C\uDF81</span><span class="rsmo-pill">'+pillTxt()+'</span></div><div class="rsmo-bd"><img src="'+(P.mini.img+(P.mini.img.indexOf("?")<0?"?":"&")+"width=160")+'" alt="" width="64" height="64"><div class="rsmo-meta"><div class="rsmo-nm">9-Note Rain Drum: the perfect second gift</div><div class="rsmo-pr"><b>'+money(P.mini.price)+'</b>'+(P.mini.was>P.mini.price?' <s>'+money(P.mini.was)+'</s>':'')+'</div><span class="rsmo-save">You save '+money(saveAmt())+'</span></div><button type="button" class="rsmo-add">+ Add</button></div>';
    var btn=el.querySelector('.rsmo-add');
    btn.addEventListener('click',function(){
      if(btn.disabled)return;btn.disabled=true;btn.textContent='Adding…';
      var api=window.essentialCartApi;
      var addP=(api&&typeof api.addItem==='function')?api.addItem(P.mini.id,1):rf().call(window,'/cart/add.js',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json',Accept:'application/json'},body:JSON.stringify({items:[{id:P.mini.id,quantity:1}]})});
      Promise.resolve(addP).then(function(){
        var ref=(api&&typeof api.refreshCart==='function')?api.refreshCart():null;
        return Promise.resolve(ref);
      }).then(function(){return getJ('/cart.js')}).then(function(c){mountMini(root,c.items)}).catch(function(){btn.disabled=false;btn.textContent='+ Add'});
    });
    var sc=root.querySelector('[data-scroll-lock-scrollable]');
    var anchor=root.querySelector('[data-essential-cart-element*="checkout"], [data-essential-cart-element*="footer"]');
    if(sc)sc.appendChild(el);
    else if(anchor&&anchor.parentNode)anchor.parentNode.insertBefore(el,anchor);
    else (root).appendChild(el);
    try{el.scrollIntoView({block:'nearest',inline:'nearest'})}catch(e){}
  }
  var syncingDrawer=false;
  function attachDrawer(portal){
    if(!portal)return;
    try{dmo.disconnect()}catch(e){}
    dmo.observe(portal,{childList:true,subtree:true});
  }
  function syncDrawer(){
    if(syncingDrawer)return;
    var portal=document.getElementById('essential-cart-drawer-portal');
    if(!portal||!portal.querySelector)return;
    var root=portal.querySelector('[data-essential-cart-element="cart-drawer-content"]')||portal.querySelector('[data-scroll-lock-scrollable]')||portal;
    if(!root||!root.querySelector)return;
    if(!portal.offsetParent&&getComputedStyle(portal).display==='none')return;
    syncingDrawer=true;
    try{dmo.disconnect()}catch(e){}
    getJ('/cart.js').then(function(c){
      try{mountMini(root,c.items)}finally{syncingDrawer=false;attachDrawer(document.getElementById('essential-cart-drawer-portal'))}
    }).catch(function(){syncingDrawer=false;attachDrawer(document.getElementById('essential-cart-drawer-portal'))});
  }
  var dmo=new MutationObserver(function(){
    if(syncingDrawer)return;
    clearTimeout(syncDrawer._t);syncDrawer._t=setTimeout(syncDrawer,200)
  });
  function watchDrawer(){
    var portal=document.getElementById('essential-cart-drawer-portal');
    if(!portal)return false;
    attachDrawer(portal);
    return true;
  }

  function load(){
    if(!document.getElementById('rs-gap-css')){var g=document.createElement('style');g.id='rs-gap-css';g.textContent="body:has(.rs-top),body:has(.rs-top) #MainContent,body:has(.rs-top) .shopify-section:has(.jdgm-widget),body:has(.rs-top) .shopify-section:has(.jdgm-widget) .page-width,body:has(.rs-top) .shopify-section:has(.jdgm-widget) .shopify-block,body:has(.rs-top) .jdgm-widget,body:has(.rs-top) .jdgm-header,body:has(.rs-top) .jdgm-cards-carousel{background-color:#F7F3EC!important}";document.head.appendChild(g)}
    Promise.all([getJ('/products/'+WRAP+'.js').catch(function(){return null}),getJ('/products/'+MINI+'.js').catch(function(){return null})]).then(function(r){
      var w=r[0]&&r[0].variants&&r[0].variants[0],m=r[1]&&r[1].variants&&r[1].variants[0];
      if(w&&w.available)P.wrap={id:w.id,price:w.price};
      if(m&&m.available)P.mini={id:m.id,price:m.price,was:m.compare_at_price||0,img:(r[1].featured_image||'').replace(/^\/\//,'https://')};
      if(P.wrap)render();
      watchPrices();
      if(!watchDrawer()){
        var n=0,t=setInterval(function(){if(watchDrawer()||++n>40)clearInterval(t)},250);
      }
    });
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',load);else load();
})();


