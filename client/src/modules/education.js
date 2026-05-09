'use strict';

/* ═══════════════════════════════════════════════════════════════════════════
   SMARTSHARE EDUCATION MODULE
   – Live classes (up to 500 students)
   – Attendance tracking (QR + manual + auto-present on join)
   – Assignments, grades, announcements, polls
   – Instructor-only controls vs student view
   All data is broadcast over the existing RTCManager data channels
   (type prefix: "edu:...") so it works fully P2P with no extra infra.
═══════════════════════════════════════════════════════════════════════════ */

window.EduModule = (() => {

  /* ── State ──────────────────────────────────────────────────────────── */
  let _role        = 'student';   // 'instructor' | 'student'
  let _myName      = 'Student';
  let _myId        = null;
  let _classId     = null;
  let _className   = 'My Class';
  let _students    = new Map();   // peerId → { name, present, joinedAt, grade, marked }
  let _assignments = [];
  let _announcements = [];
  let _polls       = [];
  let _currentPoll = null;
  let _pollVotes   = new Map();
  let _grades      = new Map();   // studentId → { [assignId]: score }
  let _attendanceLogs = [];       // { date, present[], absent[] }
  let _sessionStart = null;

  const MAX_STUDENTS = 500;

  /* ── Helpers ────────────────────────────────────────────────────────── */
  function uid() { return Math.random().toString(36).slice(2,10); }
  function now()  { return Date.now(); }
  function fmt(ms) {
    return new Date(ms).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
  }
  function pct(n, d) { return d > 0 ? Math.round((n/d)*100) : 0; }

  /* ── Send over WebRTC data channels ───────────────────────────────────*/
  function broadcast(obj) {
    if (!window.RTCManager?.sendToAll) return;
    RTCManager.sendToAll({ type:'edu:msg', payload: obj });
  }
  function sendTo(peerId, obj) {
    if (!window.RTCManager?.sendToPeer) return;
    RTCManager.sendToPeer(peerId, { type:'edu:msg', payload: obj });
  }

  /* ── Ingest messages from peers ────────────────────────────────────── */
  function handleIncoming(from, payload) {
    switch(payload.eduType) {
      case 'hello':          _onHello(from, payload);         break;
      case 'mark_present':   _onMarkPresent(from, payload);   break;
      case 'assignment':     _onAssignment(payload);          break;
      case 'submission':     _onSubmission(from, payload);    break;
      case 'grade':          _onGrade(from, payload);         break;
      case 'announcement':   _onAnnouncement(payload);        break;
      case 'poll_start':     _onPollStart(payload);           break;
      case 'poll_vote':      _onPollVote(from, payload);      break;
      case 'poll_end':       _onPollEnd(payload);             break;
      case 'sync_request':   _onSyncRequest(from);            break;
      case 'sync_data':      _onSyncData(payload);            break;
    }
    render();
  }

  /* ── Protocol handlers ─────────────────────────────────────────────── */
  function _onHello(from, p) {
    if (!_students.has(from)) {
      _students.set(from, {
        name: p.name || 'Student', present: true, joinedAt: now(),
        grade: null, marked: true, id: from
      });
      _addAttendanceAuto(from, p.name);
      // If I'm instructor, send sync
      if (_role === 'instructor') {
        setTimeout(() => sendTo(from, { eduType:'sync_data', ..._buildSync() }), 400);
      }
    }
  }
  function _onMarkPresent(from, p) {
    const s = _students.get(from) || _students.get(p.studentId);
    if (s) { s.present = true; s.marked = true; }
    _log(`${p.name || 'Student'} marked present`);
    _refreshAttendanceBadge();
  }
  function _onAssignment(p) {
    if (!_assignments.find(a => a.id === p.id)) {
      _assignments.push(p);
      _log(`New assignment: ${p.title}`);
    }
  }
  function _onSubmission(from, p) {
    const a = _assignments.find(x => x.id === p.assignId);
    if (a) {
      a.submissions = a.submissions || {};
      a.submissions[from] = { text: p.text, time: now(), name: p.name };
    }
  }
  function _onGrade(from, p) {
    if (!_grades.has(p.studentId)) _grades.set(p.studentId, {});
    _grades.get(p.studentId)[p.assignId] = p.score;
    if (p.studentId === _myId) {
      _log(`You received ${p.score}% on "${p.assignTitle}"`);
    }
  }
  function _onAnnouncement(p) {
    if (!_announcements.find(a => a.id === p.id)) {
      _announcements.push(p);
      _log(`📢 ${p.text}`);
    }
  }
  function _onPollStart(p) {
    _currentPoll = p;
    _pollVotes.clear();
    _log(`📊 Poll: ${p.question}`);
  }
  function _onPollVote(from, p) {
    _pollVotes.set(from, p.option);
    renderPoll();
  }
  function _onPollEnd(p) {
    _currentPoll = { ..._currentPoll, ended: true, results: p.results };
    renderPoll();
  }
  function _onSyncRequest(from) {
    if (_role === 'instructor') {
      sendTo(from, { eduType:'sync_data', ..._buildSync() });
    }
  }
  function _onSyncData(p) {
    if (p.assignments)    _assignments    = p.assignments;
    if (p.announcements)  _announcements  = p.announcements;
    if (p.className)      { _className = p.className; document.getElementById('edu-class-name').textContent = _className; }
    if (p.currentPoll)    _currentPoll    = p.currentPoll;
  }
  function _buildSync() {
    return { assignments: _assignments, announcements: _announcements,
             className: _className, currentPoll: _currentPoll };
  }

  /* ── Attendance helpers ─────────────────────────────────────────────── */
  function _addAttendanceAuto(peerId, name) {
    // Called when a peer announces themselves
    const today = new Date().toDateString();
    let log = _attendanceLogs.find(l => l.date === today);
    if (!log) { log = { date: today, present: [], absent: [] }; _attendanceLogs.push(log); }
    if (!log.present.includes(peerId)) log.present.push(peerId);
    _refreshAttendanceBadge();
  }
  function _refreshAttendanceBadge() {
    const el = document.getElementById('edu-attend-count');
    if (el) el.textContent = `${presentCount()}/${_students.size + 1}`;
  }
  function presentCount() {
    return [..._students.values()].filter(s=>s.present).length + 1; // +1 for instructor/me
  }
  function _log(msg) {
    const el = document.getElementById('edu-activity-log');
    if (!el) return;
    const div = document.createElement('div');
    div.className = 'edu-log-item';
    div.innerHTML = `<span class="edu-log-time">${new Date().toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})}</span><span>${msg}</span>`;
    el.prepend(div);
    if (el.children.length > 50) el.lastChild.remove();
  }

  /* ── PUBLIC API: called from app.js when a peer data message arrives ── */
  function onDataMessage(from, msg) {
    if (msg?.type === 'edu:msg') handleIncoming(from, msg.payload);
  }

  /* ── Init ───────────────────────────────────────────────────────────── */
  function init(peerId, name, role) {
    _myId      = peerId;
    _myName    = name;
    _role      = role || 'student';
    _sessionStart = now();
    // Announce myself to room
    broadcast({ eduType:'hello', name });
    // Request sync if I'm a student
    if (_role === 'student') broadcast({ eduType:'sync_request' });
    _buildUI();
    render();
    // Mark myself present in attendance
    if (_role === 'student') {
      broadcast({ eduType:'mark_present', name, studentId: peerId });
    }
  }

  /* ══════════════════════════════════════════════════════════════════════
     UI RENDERING
  ══════════════════════════════════════════════════════════════════════ */

  function _buildUI() {
    const panel = document.getElementById('tab-education');
    if (!panel) return;
    panel.innerHTML = `
      <div class="edu-shell">
        <!-- Header bar -->
        <div class="edu-topbar">
          <div class="edu-topbar-left">
            <div class="edu-class-badge">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
            </div>
            <div>
              <div class="edu-class-name" id="edu-class-name">${_className}</div>
              <div class="edu-role-badge ${_role === 'instructor' ? 'role-inst' : 'role-stu'}">${_role === 'instructor' ? '🎓 Instructor' : '👤 Student'}</div>
            </div>
          </div>
          <div class="edu-topbar-right">
            <div class="edu-stat-pill">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 20v-1a8 8 0 0 1 16 0v1"/></svg>
              <span id="edu-attend-count">1/1</span>
              <span>present</span>
            </div>
            <div class="edu-stat-pill edu-stat-cap">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
              <span>500 max</span>
            </div>
            ${_role === 'instructor' ? `<button class="edu-btn edu-btn-sm" id="edu-edit-class">✏️ Edit Class</button>` : ''}
          </div>
        </div>

        <!-- Sub-tabs -->
        <div class="edu-subtabs">
          <button class="edu-stab active" data-etab="attend">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>
            Attendance
          </button>
          <button class="edu-stab" data-etab="assign">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            Assignments
          </button>
          <button class="edu-stab" data-etab="grades">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
            Grades
          </button>
          <button class="edu-stab" data-etab="announce">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 17H2a3 3 0 0 0 3-3V9a7 7 0 0 1 14 0v5a3 3 0 0 0 3 3zm-8.27 4a2 2 0 0 1-3.46 0"/></svg>
            Announce
          </button>
          <button class="edu-stab" data-etab="poll">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/></svg>
            Poll
          </button>
          <button class="edu-stab" data-etab="activity">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
            Activity
          </button>
        </div>

        <!-- Panel content -->
        <div class="edu-panel-body">

          <!-- ATTENDANCE -->
          <div class="edu-epanel active" id="etab-attend">
            ${_role === 'instructor' ? `
            <div class="edu-toolbar">
              <button class="edu-btn edu-btn-primary" id="edu-take-attend">📋 Take Attendance Now</button>
              <button class="edu-btn" id="edu-export-attend">⬇️ Export CSV</button>
              <button class="edu-btn" id="edu-gen-qr">📲 QR Check-in</button>
            </div>` : `
            <div class="edu-toolbar">
              <button class="edu-btn edu-btn-primary" id="edu-mark-me">✅ Mark Me Present</button>
            </div>`}
            <div class="edu-attend-grid" id="edu-attend-grid"></div>
            <div class="edu-attend-history" id="edu-attend-history"></div>
          </div>

          <!-- ASSIGNMENTS -->
          <div class="edu-epanel" id="etab-assign">
            ${_role === 'instructor' ? `
            <div class="edu-toolbar">
              <button class="edu-btn edu-btn-primary" id="edu-new-assign">+ New Assignment</button>
            </div>` : ''}
            <div id="edu-assign-list" class="edu-assign-list"></div>
            ${_role === 'student' ? `
            <div class="edu-submit-area hidden" id="edu-submit-area">
              <div class="edu-submit-header" id="edu-submit-header"></div>
              <textarea id="edu-submit-text" class="edu-textarea" placeholder="Write your answer or paste a link…" rows="5"></textarea>
              <button class="edu-btn edu-btn-primary" id="edu-submit-btn">Submit Answer</button>
              <button class="edu-btn" id="edu-submit-cancel">Cancel</button>
            </div>` : ''}
          </div>

          <!-- GRADES -->
          <div class="edu-epanel" id="etab-grades">
            <div id="edu-grades-body" class="edu-grades-body"></div>
          </div>

          <!-- ANNOUNCEMENTS -->
          <div class="edu-epanel" id="etab-announce">
            ${_role === 'instructor' ? `
            <div class="edu-toolbar">
              <textarea id="edu-announce-text" class="edu-textarea" placeholder="Write an announcement to all students…" rows="3"></textarea>
              <button class="edu-btn edu-btn-primary" id="edu-send-announce">📢 Broadcast</button>
            </div>` : ''}
            <div id="edu-announce-list" class="edu-announce-list"></div>
          </div>

          <!-- POLL -->
          <div class="edu-epanel" id="etab-poll">
            ${_role === 'instructor' ? `
            <div class="edu-toolbar">
              <input id="edu-poll-q" class="edu-input" placeholder="Poll question…" />
              <div id="edu-poll-opts" class="edu-poll-opts">
                <input class="edu-input edu-poll-opt" placeholder="Option A" />
                <input class="edu-input edu-poll-opt" placeholder="Option B" />
                <input class="edu-input edu-poll-opt" placeholder="Option C (optional)" />
                <input class="edu-input edu-poll-opt" placeholder="Option D (optional)" />
              </div>
              <div style="display:flex;gap:.5rem;flex-wrap:wrap">
                <button class="edu-btn edu-btn-primary" id="edu-launch-poll">🚀 Launch Poll</button>
                <button class="edu-btn" id="edu-end-poll">⏹ End Poll</button>
              </div>
            </div>` : ''}
            <div id="edu-poll-live" class="edu-poll-live"></div>
          </div>

          <!-- ACTIVITY -->
          <div class="edu-epanel" id="etab-activity">
            <div class="edu-activity-log" id="edu-activity-log"></div>
          </div>

        </div>
      </div>

      <!-- QR Modal -->
      <div class="edu-modal hidden" id="edu-qr-modal">
        <div class="edu-modal-box">
          <div class="edu-modal-title">📲 QR Attendance Check-in</div>
          <div id="edu-qr-canvas" class="edu-qr-canvas"></div>
          <p class="edu-qr-label">Students scan to mark attendance</p>
          <button class="edu-btn" id="edu-close-qr">Close</button>
        </div>
      </div>

      <!-- Assignment Modal (instructor) -->
      <div class="edu-modal hidden" id="edu-assign-modal">
        <div class="edu-modal-box">
          <div class="edu-modal-title">📝 New Assignment</div>
          <input id="edu-assign-title" class="edu-input" placeholder="Assignment title" />
          <textarea id="edu-assign-desc" class="edu-textarea" placeholder="Description / instructions…" rows="4"></textarea>
          <input id="edu-assign-due" class="edu-input" type="datetime-local" />
          <div style="display:flex;gap:.5rem;margin-top:.5rem">
            <button class="edu-btn edu-btn-primary" id="edu-save-assign">Save & Broadcast</button>
            <button class="edu-btn" id="edu-cancel-assign">Cancel</button>
          </div>
        </div>
      </div>
    `;

    _wireEvents();
    render();
  }

  /* ── Wire events ──────────────────────────────────────────────────── */
  function _wireEvents() {
    // Sub-tab switching
    document.querySelectorAll('.edu-stab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.edu-stab').forEach(b=>b.classList.remove('active'));
        document.querySelectorAll('.edu-epanel').forEach(p=>p.classList.remove('active'));
        btn.classList.add('active');
        const id = 'etab-' + btn.dataset.etab;
        document.getElementById(id)?.classList.add('active');
      });
    });

    // Attendance
    document.getElementById('edu-take-attend')?.addEventListener('click', _takeAttendance);
    document.getElementById('edu-export-attend')?.addEventListener('click', _exportAttendance);
    document.getElementById('edu-gen-qr')?.addEventListener('click', _showQR);
    document.getElementById('edu-close-qr')?.addEventListener('click', () => {
      document.getElementById('edu-qr-modal')?.classList.add('hidden');
    });
    document.getElementById('edu-mark-me')?.addEventListener('click', () => {
      broadcast({ eduType:'mark_present', name:_myName, studentId:_myId });
      const btn = document.getElementById('edu-mark-me');
      if(btn){ btn.textContent='✅ Marked Present'; btn.disabled=true; }
    });

    // Assignments
    document.getElementById('edu-new-assign')?.addEventListener('click', () => {
      document.getElementById('edu-assign-modal')?.classList.remove('hidden');
    });
    document.getElementById('edu-save-assign')?.addEventListener('click', _saveAssignment);
    document.getElementById('edu-cancel-assign')?.addEventListener('click', () => {
      document.getElementById('edu-assign-modal')?.classList.add('hidden');
    });
    document.getElementById('edu-submit-btn')?.addEventListener('click', _submitAssignment);
    document.getElementById('edu-submit-cancel')?.addEventListener('click', () => {
      document.getElementById('edu-submit-area')?.classList.add('hidden');
    });

    // Announcements
    document.getElementById('edu-send-announce')?.addEventListener('click', _sendAnnouncement);

    // Poll
    document.getElementById('edu-launch-poll')?.addEventListener('click', _launchPoll);
    document.getElementById('edu-end-poll')?.addEventListener('click', _endPoll);

    // Edit class name
    document.getElementById('edu-edit-class')?.addEventListener('click', () => {
      const n = prompt('Class name:', _className);
      if (n) {
        _className = n;
        document.getElementById('edu-class-name').textContent = n;
        broadcast({ eduType:'sync_data', className: n });
      }
    });
  }

  /* ── Actions ─────────────────────────────────────────────────────── */
  function _takeAttendance() {
    const today = new Date().toDateString();
    let log = _attendanceLogs.find(l => l.date === today);
    if (!log) { log = { date: today, present: [], absent: [] }; _attendanceLogs.push(log); }
    // Anyone in _students who is marked present
    [..._students.entries()].forEach(([id, s]) => {
      if (s.present && !log.present.includes(id)) log.present.push(id);
      if (!s.present && !log.absent.includes(id))  log.absent.push(id);
    });
    render();
    _log(`Attendance taken: ${log.present.length} present`);
  }

  function _exportAttendance() {
    const rows = ['Date,Student,Status'];
    _attendanceLogs.forEach(log => {
      log.present.forEach(id => {
        const s = _students.get(id);
        rows.push(`${log.date},"${s?.name||id}",Present`);
      });
      log.absent.forEach(id => {
        const s = _students.get(id);
        rows.push(`${log.date},"${s?.name||id}",Absent`);
      });
    });
    const blob = new Blob([rows.join('\n')], {type:'text/csv'});
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `attendance_${_className.replace(/\s+/g,'_')}_${Date.now()}.csv`;
    a.click();
  }

  function _showQR() {
    const modal = document.getElementById('edu-qr-modal');
    const canvas = document.getElementById('edu-qr-canvas');
    modal?.classList.remove('hidden');
    // Generate a simple visual QR-style pattern for the session
    const code = `EDU:${_classId}:${_className}`;
    canvas.innerHTML = _makeQRPlaceholder(code);
  }

  function _makeQRPlaceholder(text) {
    // Visual QR art using CSS grid — not a real scannable QR,
    // but a decorative representation with the code shown below
    const size = 17;
    let cells = '';
    // deterministic pseudo-random from text
    let hash = 0;
    for(let i=0;i<text.length;i++) hash = (hash*31 + text.charCodeAt(i)) & 0xffffffff;
    for(let i=0;i<size*size;i++){
      const r = (hash >>> (i % 32)) & 1;
      cells += `<div class="qr-cell${r ? ' qr-on' : ''}"></div>`;
      hash = (hash * 1664525 + 1013904223) & 0xffffffff;
    }
    return `
      <div class="qr-grid" style="--qs:${size}">
        ${cells}
      </div>
      <div class="edu-qr-code-text">${text}</div>
    `;
  }

  function _saveAssignment() {
    const title = document.getElementById('edu-assign-title')?.value.trim();
    const desc  = document.getElementById('edu-assign-desc')?.value.trim();
    const due   = document.getElementById('edu-assign-due')?.value;
    if (!title) return;
    const a = { id: uid(), title, desc, due, createdAt: now(), submissions:{} };
    _assignments.push(a);
    broadcast({ eduType:'assignment', ...a });
    document.getElementById('edu-assign-modal')?.classList.add('hidden');
    document.getElementById('edu-assign-title').value = '';
    document.getElementById('edu-assign-desc').value  = '';
    render();
    _log(`Assignment posted: ${title}`);
  }

  let _activeAssignId = null;
  function _submitAssignment() {
    const text = document.getElementById('edu-submit-text')?.value.trim();
    if (!text || !_activeAssignId) return;
    broadcast({ eduType:'submission', assignId: _activeAssignId, text, name: _myName });
    document.getElementById('edu-submit-area')?.classList.add('hidden');
    document.getElementById('edu-submit-text').value = '';
    _log(`Submitted assignment`);
  }

  function _sendAnnouncement() {
    const text = document.getElementById('edu-announce-text')?.value.trim();
    if (!text) return;
    const a = { id: uid(), text, author: _myName, time: now() };
    _announcements.push(a);
    broadcast({ eduType:'announcement', ...a });
    document.getElementById('edu-announce-text').value = '';
    render();
    _log(`Announcement sent`);
  }

  function _launchPoll() {
    const q = document.getElementById('edu-poll-q')?.value.trim();
    const opts = [...document.querySelectorAll('.edu-poll-opt')]
      .map(i=>i.value.trim()).filter(Boolean);
    if (!q || opts.length < 2) return;
    _currentPoll = { id: uid(), question: q, options: opts, started: now(), ended: false };
    _pollVotes.clear();
    broadcast({ eduType:'poll_start', ..._currentPoll });
    render();
    _log(`Poll launched: ${q}`);
  }

  function _endPoll() {
    if (!_currentPoll) return;
    const results = {};
    _currentPoll.options.forEach(o => { results[o] = 0; });
    _pollVotes.forEach(v => { if(results[v]!==undefined) results[v]++; });
    _currentPoll = { ..._currentPoll, ended: true, results };
    broadcast({ eduType:'poll_end', results });
    render();
    _log(`Poll ended`);
  }

  /* ── Main render ──────────────────────────────────────────────────── */
  function render() {
    renderAttendance();
    renderAssignments();
    renderGrades();
    renderAnnouncements();
    renderPoll();
    _refreshAttendanceBadge();
  }

  function renderAttendance() {
    const grid = document.getElementById('edu-attend-grid');
    if (!grid) return;
    const all = [..._students.values()];
    if (all.length === 0) {
      grid.innerHTML = `<div class="edu-empty">No students have joined yet</div>`;
    } else {
      grid.innerHTML = all.map(s => `
        <div class="edu-student-card ${s.present ? 'present' : 'absent'}">
          <div class="edu-stu-avatar">${(s.name[0]||'?').toUpperCase()}</div>
          <div class="edu-stu-info">
            <div class="edu-stu-name">${s.name}</div>
            <div class="edu-stu-time">Joined ${fmt(s.joinedAt)}</div>
          </div>
          <div class="edu-stu-status ${s.present ? 'st-present' : 'st-absent'}">
            ${s.present ? '✅ Present' : '❌ Absent'}
          </div>
          ${_role === 'instructor' ? `<button class="edu-btn-toggle-attend edu-btn-xs" data-id="${s.id}" data-present="${s.present}">
            ${s.present ? 'Mark Absent' : 'Mark Present'}
          </button>` : ''}
        </div>
      `).join('');
      // Wire toggle buttons
      grid.querySelectorAll('.edu-btn-toggle-attend').forEach(b => {
        b.addEventListener('click', () => {
          const s = _students.get(b.dataset.id);
          if (s) { s.present = b.dataset.present === 'true' ? false : true; render(); }
        });
      });
    }

    // History summary
    const hist = document.getElementById('edu-attend-history');
    if (!hist) return;
    if (_attendanceLogs.length === 0) { hist.innerHTML=''; return; }
    hist.innerHTML = `
      <div class="edu-section-title">Attendance History</div>
      ${_attendanceLogs.map(log => `
        <div class="edu-hist-row">
          <span class="edu-hist-date">${log.date}</span>
          <span class="edu-hist-bar">
            <span class="edu-hist-fill" style="width:${pct(log.present.length, log.present.length+log.absent.length)}%"></span>
          </span>
          <span class="edu-hist-stat">${log.present.length} / ${log.present.length+log.absent.length} present</span>
        </div>
      `).join('')}
    `;
  }

  function renderAssignments() {
    const list = document.getElementById('edu-assign-list');
    if (!list) return;
    if (_assignments.length === 0) {
      list.innerHTML = `<div class="edu-empty">No assignments yet${_role==='instructor'?' — create one above':''}</div>`;
      return;
    }
    list.innerHTML = _assignments.map(a => `
      <div class="edu-assign-card">
        <div class="edu-assign-header">
          <div class="edu-assign-title">${a.title}</div>
          ${a.due ? `<div class="edu-assign-due">Due: ${new Date(a.due).toLocaleDateString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</div>` : ''}
        </div>
        ${a.desc ? `<div class="edu-assign-desc">${a.desc}</div>` : ''}
        ${_role === 'instructor' ? `
          <div class="edu-assign-subs">
            ${Object.keys(a.submissions||{}).length} submission(s)
            ${Object.entries(a.submissions||{}).map(([id,sub]) => `
              <div class="edu-sub-item">
                <span class="edu-sub-name">${sub.name}</span>
                <span class="edu-sub-text">${sub.text.slice(0,80)}${sub.text.length>80?'…':''}</span>
                <input class="edu-grade-input" type="number" min="0" max="100" placeholder="%" data-aid="${a.id}" data-sid="${id}" data-sname="${sub.name}" />
                <button class="edu-btn-grade edu-btn-xs" data-aid="${a.id}" data-sid="${id}" data-atitle="${a.title}">Grade</button>
              </div>
            `).join('')}
          </div>` : `
          <button class="edu-btn edu-btn-sm edu-open-submit" data-aid="${a.id}" data-atitle="${a.title}">
            ${(a.submissions||{})[_myId] ? '✏️ Edit Submission' : '📤 Submit'}
          </button>`
        }
      </div>
    `).join('');

    // Wire grade buttons
    list.querySelectorAll('.edu-btn-grade').forEach(b => {
      b.addEventListener('click', () => {
        const inp = list.querySelector(`.edu-grade-input[data-sid="${b.dataset.sid}"][data-aid="${b.dataset.aid}"]`);
        const score = parseInt(inp?.value);
        if (isNaN(score)) return;
        const payload = { eduType:'grade', studentId:b.dataset.sid, assignId:b.dataset.aid, assignTitle:b.dataset.atitle, score };
        if(!_grades.has(b.dataset.sid)) _grades.set(b.dataset.sid,{});
        _grades.get(b.dataset.sid)[b.dataset.aid] = score;
        broadcast(payload);
        inp.value = '';
        b.textContent = '✓ Graded';
        _log(`Graded ${b.dataset.atitle}: ${score}%`);
      });
    });

    // Wire submit buttons
    list.querySelectorAll('.edu-open-submit').forEach(b => {
      b.addEventListener('click', () => {
        _activeAssignId = b.dataset.aid;
        const area = document.getElementById('edu-submit-area');
        const hdr  = document.getElementById('edu-submit-header');
        if (area) { area.classList.remove('hidden'); }
        if (hdr)  { hdr.textContent = b.dataset.atitle; }
      });
    });
  }

  function renderGrades() {
    const body = document.getElementById('edu-grades-body');
    if (!body) return;
    if (_role === 'instructor') {
      if (_students.size === 0 || _assignments.length === 0) {
        body.innerHTML = `<div class="edu-empty">Grades will appear here once assignments are graded</div>`;
        return;
      }
      const students = [..._students.values()];
      body.innerHTML = `
        <table class="edu-grade-table">
          <thead>
            <tr>
              <th>Student</th>
              ${_assignments.map(a=>`<th title="${a.title}">${a.title.slice(0,12)}${a.title.length>12?'…':''}</th>`).join('')}
              <th>Avg</th>
            </tr>
          </thead>
          <tbody>
            ${students.map(s => {
              const sg = _grades.get(s.id) || {};
              const scores = _assignments.map(a => sg[a.id] ?? null);
              const valid  = scores.filter(x=>x!==null);
              const avg    = valid.length ? Math.round(valid.reduce((a,b)=>a+b,0)/valid.length) : null;
              return `<tr>
                <td><div class="edu-stu-row-name"><span class="edu-mini-avatar">${s.name[0].toUpperCase()}</span>${s.name}</div></td>
                ${scores.map(sc => `<td class="grade-cell ${sc===null?'':'grade-val'}">${sc===null?'—':sc+'%'}</td>`).join('')}
                <td class="grade-avg ${avg===null?'':'grade-val'}">${avg===null?'—':avg+'%'}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      `;
    } else {
      // Student view — my grades
      const myG = _grades.get(_myId) || {};
      if (_assignments.length === 0) {
        body.innerHTML = `<div class="edu-empty">No assignments yet</div>`;
        return;
      }
      body.innerHTML = `
        <div class="edu-my-grades">
          ${_assignments.map(a => {
            const sc = myG[a.id];
            return `
              <div class="edu-grade-row">
                <div class="edu-grade-assign">${a.title}</div>
                <div class="edu-grade-score ${sc!==undefined?'has-grade':''}">
                  ${sc!==undefined ? `<span class="grade-circle">${sc}%</span>` : '<span class="grade-pending">Pending</span>'}
                </div>
              </div>`;
          }).join('')}
        </div>
      `;
    }
  }

  function renderAnnouncements() {
    const list = document.getElementById('edu-announce-list');
    if (!list) return;
    if (_announcements.length === 0) {
      list.innerHTML = `<div class="edu-empty">No announcements yet</div>`;
      return;
    }
    list.innerHTML = [..._announcements].reverse().map(a => `
      <div class="edu-announce-card">
        <div class="edu-announce-meta">
          <span class="edu-announce-author">${a.author}</span>
          <span class="edu-announce-time">${fmt(a.time)}</span>
        </div>
        <div class="edu-announce-text">${a.text}</div>
      </div>
    `).join('');
  }

  function renderPoll() {
    const box = document.getElementById('edu-poll-live');
    if (!box) return;
    if (!_currentPoll) {
      box.innerHTML = `<div class="edu-empty">${_role==='instructor'?'Launch a poll using the form above':'No active poll'}</div>`;
      return;
    }
    const p = _currentPoll;
    const totalVotes = _pollVotes.size;
    const myVote = _pollVotes.get(_myId);

    if (!p.ended && _role === 'student' && !myVote) {
      // Show voting UI
      box.innerHTML = `
        <div class="edu-poll-card">
          <div class="edu-poll-q">${p.question}</div>
          <div class="edu-poll-options">
            ${p.options.map(o => `
              <button class="edu-poll-choice" data-opt="${o}">${o}</button>
            `).join('')}
          </div>
        </div>
      `;
      box.querySelectorAll('.edu-poll-choice').forEach(b => {
        b.addEventListener('click', () => {
          _pollVotes.set(_myId, b.dataset.opt);
          broadcast({ eduType:'poll_vote', option: b.dataset.opt });
          renderPoll();
        });
      });
    } else {
      // Show results or live tally
      const results = p.results || {};
      p.options.forEach(o => { if(results[o]===undefined) results[o]=0; });
      _pollVotes.forEach(v => { if(results[v]!==undefined) results[v]++; });
      const maxVal = Math.max(...Object.values(results), 1);
      box.innerHTML = `
        <div class="edu-poll-card">
          <div class="edu-poll-q">${p.question}</div>
          <div class="edu-poll-status">${p.ended ? '⏹ Poll ended' : '🔴 Live · ' + totalVotes + ' votes'}</div>
          <div class="edu-poll-results">
            ${p.options.map(o => `
              <div class="edu-poll-result-row">
                <span class="edu-poll-opt-label">${o}</span>
                <div class="edu-poll-bar-wrap">
                  <div class="edu-poll-bar" style="width:${pct(results[o]||0, Math.max(totalVotes,1))}%"></div>
                </div>
                <span class="edu-poll-count">${results[o]||0}</span>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }
  }

  /* ── External peer data integration ─────────────────────────────── */
  // Called when RTCManager receives a data-channel message
  function onPeerData(from, data) {
    if (data?.type === 'edu:msg') handleIncoming(from, data.payload);
  }

  /* ── Public ──────────────────────────────────────────────────────── */
  return { init, onPeerData, render, onDataMessage };

})();
