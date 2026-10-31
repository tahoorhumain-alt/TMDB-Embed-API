/* eslint-env browser */
(function(){
  const $ = sel => document.querySelector(sel);
  
  // --- ADD YOUR CREDENTIALS HERE ---
  const AUTO_USER = 'admin'; 
  const AUTO_PASS = 'change-me'; 
  // ---------------------------------

  async function checkSession(){
    try {
      const r = await fetch('/auth/session');
      const j = await r.json();
      if (j.authenticated) {
        window.location.href = '/config.html';
      } else {
        // IF NOT LOGGED IN, TRY AUTO-LOGIN
        if (AUTO_USER && AUTO_PASS && AUTO_PASS !== 'your_actual_password_here') {
          login(AUTO_USER, AUTO_PASS);
        }
      }
    } catch(e) { 
        // If fetch fails (e.g. server is waking up), wait 3 seconds and try again
        setTimeout(checkSession, 3000); 
    }
  }

  async function login(username, password){
    const status = $('#status');
    if(status) {
        status.textContent = 'Auto-Authenticating...';
        status.className = 'status';
    }
    
    try {
      const r = await fetch('/auth/login', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ username, password }) });
      const j = await r.json();
      
      if (!j.success) {
        if(status) {
            status.textContent = 'Auto-login failed: ' + (j.error || 'Unknown');
            status.classList.add('error');
        }
        return false;
      }
      
      if(status) {
        status.textContent = 'Success! Redirecting...';
        status.classList.add('success');
      }
      setTimeout(()=>{ window.location.href = '/config.html'; }, 400);
      return true;
    } catch (e) {
      // Network error, retry in 3 seconds
      setTimeout(() => login(username, password), 3000);
      return false;
    }
  }

  // Lockout handling
  let lockoutTimer = null;
  function showLockout(retryAfterSeconds){
    if (!retryAfterSeconds || retryAfterSeconds <= 0) return;
    const banner = $('#lockoutBanner');
    const countdownEl = $('#lockoutCountdown');
    if(!banner || !countdownEl) return;
    banner.style.display = 'block';
    const end = Date.now() + (retryAfterSeconds * 1000);
    if (lockoutTimer) clearInterval(lockoutTimer);
    lockoutTimer = setInterval(()=>{
      const remain = end - Date.now();
      if (remain <= 0){
        clearInterval(lockoutTimer);
        banner.style.display = 'none';
        countdownEl.textContent = '00:00';
        return;
      }
      const sec = Math.ceil(remain/1000);
      const m = String(Math.floor(sec/60)).padStart(2,'0');
      const s = String(sec%60).padStart(2,'0');
      countdownEl.textContent = `${m}:${s}`;
    }, 1000);
  }

  async function changePassword(oldPassword, newPassword){
    const pwStatus = $('#pwStatus');
    if(!pwStatus) return;
    pwStatus.textContent = 'Updating...';
    pwStatus.className = 'status';
    try {
      const r = await fetch('/auth/change-password', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ oldPassword, newPassword }) });
      const j = await r.json();
      if (!j.success) {
        pwStatus.textContent = j.error || 'Update failed';
        pwStatus.classList.add('error');
        return;
      }
      pwStatus.textContent = 'Password updated';
      pwStatus.classList.add('success');
      setTimeout(()=>{ $('#pwForm').reset(); }, 600);
    } catch(e){
      pwStatus.textContent = 'Network error';
      pwStatus.classList.add('error');
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const params = new URLSearchParams(location.search);
    const status = $('#status');
    
    if(status) {
        if(params.has('loggedOut')) { status.textContent = 'Logged out successfully'; status.classList.add('success'); }
        else if(params.has('expired')) { status.textContent = 'Session expired. Attempting auto-login...'; status.classList.add('error'); }
        if(params.has('loggedOut') || params.has('expired')) {
          history.replaceState(null,'', location.pathname);
        }
    }
    
    // Start the auto-check/auto-login process
    checkSession();

    if($('#loginForm')) {
        $('#loginForm').addEventListener('submit', e => {
          e.preventDefault();
          const u = $('#username').value.trim();
          const p = $('#password').value;
          if (!u || !p) return;
          login(u,p);
        });
    }
    
    if($('#togglePw')) {
        $('#togglePw').addEventListener('click', () => {
          const chg = $('#pwChange');
          const visible = chg.style.display === 'block';
          chg.style.display = visible ? 'none' : 'block';
        });
    }
    
    if($('#pwForm')) {
        $('#pwForm').addEventListener('submit', e => {
          e.preventDefault();
          const oldPw = $('#oldPw').value;
          const newPw = $('#newPw').value;
          if (newPw.length < 8) {
            $('#pwStatus').textContent = 'Password too short';
            $('#pwStatus').classList.add('error');
            return;
          }
          changePassword(oldPw, newPw);
        });
    }
  });
})();