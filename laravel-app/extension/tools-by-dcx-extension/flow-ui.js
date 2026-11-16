(() => {
  if (window.__toolsByDcxLoaded) return;
  window.__toolsByDcxLoaded = true;
  const mount = () => {
    if (document.querySelector('[data-tools-by-dcx-badge]')) return;
    const badge = document.createElement('div');
    badge.dataset.toolsByDcxBadge = 'true';
    badge.textContent = '✦ Tools By DCX · UI bridge ready';
    Object.assign(badge.style, {position:'fixed',right:'18px',bottom:'18px',zIndex:'2147483647',padding:'9px 12px',border:'1px solid rgba(215,182,255,.38)',borderRadius:'9px',background:'#171124',color:'#eadbff',font:'600 11px Inter,system-ui,sans-serif',boxShadow:'0 10px 30px rgba(0,0,0,.3)'});
    document.documentElement.appendChild(badge);
  };
  window.addEventListener('message', (event) => {
    if (event.source !== window || event.data?.type !== 'TOOLS_BY_DCX_PAGE_READY') return;
    window.postMessage({type:'TOOLS_BY_DCX_CHECK_EXTENSION', ready:true}, '*');
  });
  const observer = new MutationObserver(mount);
  observer.observe(document.documentElement, {childList:true, subtree:true});
  mount();
})();
