import { initializeApp } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/13.4.0/firebase-analytics.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-auth.js";
import {
  getFirestore,
  collection,
  query,
  orderBy,
  onSnapshot,
  writeBatch,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/13.4.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCCfjF0zFPdXZKnTvD-7MfZV45MEjL_mYk",
  authDomain: "csr-project-ea565.firebaseapp.com",
  projectId: "csr-project-ea565",
  storageBucket: "csr-project-ea565.firebasestorage.app",
  messagingSenderId: "496050903557",
  appId: "1:496050903557:web:43d552d1e79033753b5a6c",
  measurementId: "G-EXWCXZT2KG"
};

const app = initializeApp(firebaseConfig);
const analytics = getAnalytics(app);
const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();
const db = getFirestore(app);
const requestsCollection = collection(db, 'service_requests');


// Replace with your Google Cloud OAuth 2.0 Client ID
const GOOGLE_CLIENT_ID = 'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com';

// Optional: Emails listed here automatically unlock the Staff/Admin Portal on sign-in
const STAFF_EMAILS = [
  // 'admin@example.com'
];

/* =========================================================================
   APPLICATION STATE & CONSTANTS
   ========================================================================= */
const GOOGLE_USER_KEY = 'csr_google_user_v1';
const DEFAULT_PIN = 'ADMIN2026';

const AREAS_LIST = [
  'Aliwekwek',
  'Baay',
  'Balangobong',
  'Balococ',
  'Bantayan',
  'Basing',
  'Capandanan',
  'Domalandan Center',
  'Domalandan East',
  'Domalandan West',
  'Dorongan',
  'Dulag',
  'Estanza',
  'Lasip',
  'Libsong East',
  'Libsong West',
  'Malawa',
  'Malimpuec',
  'Maniboc',
  'Matalava',
  'Naguelguel',
  'Namolan',
  'Pangapisan North',
  'Pangapisan Sur',
  'Poblacion',
  'Quibaol',
  'Rosario',
  'Sabangan',
  'Talogtog',
  'Tonton',
  'Tumbar',
  'Wawa'
];
;
const CATEGORIES_LIST = [
  'Streetlight',
  'Fallen Tree',
  'Water & Drainage',
  'Garbage & Sanitation',
  'Electrical'
];

let requestsData = [];
let googleUser = null;
let staffUnlocked = false;
let pendingOnlyFilter = false;
let editingRequestId = null;
let toastTimeoutId = null;
let unsubscribeFirestore = null;

function relativeIsoDate(daysOffset) {
  const date = new Date();
  date.setDate(date.getDate() + daysOffset);
  return date.toISOString().split('T')[0];
}

function formatNowLabel() {
  const now = new Date();
  return now.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' ' + now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatTrackingId(numericId) {
  return '#CSR-' + String(numericId).padStart(6, '0');
}


/* =========================================================================
   FIREBASE FIRESTORE REAL-TIME SYNC & CRUD
   ========================================================================= */
let isInitialSnapshot = true;

function playNotificationBeep() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    gain.gain.setValueAtTime(0.08, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.35);
  } catch (e) {}
}

function notifyStaffOfNewRequest(req) {
  const isStaffViewVisible = !document.getElementById('staff-portal-view').classList.contains('hidden');
  if (!staffUnlocked || !isStaffViewVisible) return;

  showToast(`New request ${req.trackingId}: ${req.category} in ${req.area}`);
  playNotificationBeep();
}
   

function subscribeToRequests() {
  if (unsubscribeFirestore) unsubscribeFirestore();
  isInitialSnapshot = true;

  const q = query(requestsCollection, orderBy('id', 'desc'));

  unsubscribeFirestore = onSnapshot(q, (snapshot) => {
    const addedRequests = [];

    if (!isInitialSnapshot) {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          addedRequests.push(change.doc.data());
        }
      });
    }
    isInitialSnapshot = false;

    requestsData = snapshot.docs.map((docSnap) => ({
      ...docSnap.data(),
      id: Number(docSnap.data().id)
    }));

    if (staffUnlocked) {
      refreshStaffPortal();
    }

    if (addedRequests.length === 1) {
      notifyStaffOfNewRequest(addedRequests[0]);
    } else if (addedRequests.length > 1) {
      const isStaffViewVisible = !document.getElementById('staff-portal-view').classList.contains('hidden');
      if (staffUnlocked && isStaffViewVisible) {
        showToast(`${addedRequests.length} new service requests received.`);
        playNotificationBeep();
      }
    }
  }, (error) => {
    console.error("Firestore subscription error:", error);
    showToast('Error syncing with database. Check Firebase permissions.');
  });
}


async function seedFirestoreDatabase() {
  try {
    const batch = writeBatch(db);
    const seeds = getSeedRequests();
    seeds.forEach((req) => {
      const docRef = doc(db, 'service_requests', String(req.id));
      batch.set(docRef, req);
    });
    await batch.commit();
  } catch (err) {
    console.error("Error seeding Firestore:", err);
  }
}

async function resetSampleData() {
  try {
    showToast('Restoring sample data...');
    const existingDocs = await getDocs(requestsCollection);
    const batch = writeBatch(db);

    // Delete all current documents
    existingDocs.forEach((docSnap) => {
      batch.delete(docSnap.ref);
    });

    // Re-add seed documents
    const seeds = getSeedRequests();
    seeds.forEach((req) => {
      const docRef = doc(db, 'service_requests', String(req.id));
      batch.set(docRef, req);
    });

    await batch.commit();
    showToast('Sample data restored in Firebase.');
  } catch (err) {
    console.error("Error resetting data:", err);
    showToast('Failed to restore sample data.');
  }
}

/* =========================================================================
   GOOGLE IDENTITY SERVICES (GIS) INITIALIZATION & HANDLERS
   ========================================================================= */
/* =========================================================================
   FIREBASE GOOGLE AUTHENTICATION HANDLERS
   ========================================================================= */
async function signInWithGoogle() {
  try {
    const result = await signInWithPopup(auth, googleProvider);
    const user = result.user;

    applySignedInUI({
      name: user.displayName || 'Google User',
      email: user.email || '',
      picture: user.photoURL || ''
    });

    showToast(`Signed in as ${user.displayName || user.email}`);
  } catch (err) {
    if (err.code === 'auth/popup-closed-by-user') {
      showToast('Sign-in popup was closed.');
    } else if (err.code === 'auth/popup-blocked') {
      showToast('Popup blocked by browser. Allow popups and try again.');
    } else {
      console.error('Google Sign-In error:', err);
      showToast('Google Sign-In failed.');
    }
  }
}

function signInWithDemoGoogle() {
  applySignedInUI({
    name: 'Jordan Alvarez',
    email: 'jordan.alvarez@gmail.com',
    picture: ''
  });
  showToast('Signed in with demo account');
} 

function applySignedInUI(profile) {
  googleUser = profile;

  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('header-auth-controls').classList.remove('hidden');
  document.getElementById('header-user-name').textContent = profile.name;

  const avatarImg = document.getElementById('header-user-avatar');
  const initialsEl = document.getElementById('header-user-initials');
  if (profile.picture) {
    avatarImg.src = profile.picture;
    avatarImg.referrerPolicy = 'no-referrer';
    avatarImg.classList.remove('hidden');
    initialsEl.classList.add('hidden');
  } else {
    avatarImg.classList.add('hidden');
    initialsEl.classList.remove('hidden');
    initialsEl.textContent = (profile.name || 'U').charAt(0).toUpperCase();
  }

  prefillCitizenFormFromGoogle();

  const isWhitelistedStaff = profile.email &&
    STAFF_EMAILS.map((e) => e.toLowerCase()).includes(profile.email.toLowerCase());

  if (isWhitelistedStaff) {
    staffUnlocked = true;
    document.getElementById('btn-header-staff').classList.add('hidden');
    document.getElementById('btn-header-public').classList.remove('hidden');
    showUnlockedStaffPortal();
  } else {
    openPublicView();
  }
}

async function handleGoogleSignOut() {
  try {
    if (auth.currentUser) {
      await signOut(auth);
    }
    googleUser = null;
    staffUnlocked = false;
    document.getElementById('citizen-form').reset();
    openLoginView();
    showToast('Signed out.');
  } catch (err) {
    console.error('Sign-out error:', err);
    showToast('Error signing out.');
  }
}


function prefillCitizenFormFromGoogle() {
  if (!googleUser) return;
  const nameInput = document.getElementById('reporter-name');
  if (googleUser.name) nameInput.value = googleUser.name;
}

function openLoginView() {
  document.getElementById('login-view').classList.remove('hidden');
  document.getElementById('public-view').classList.add('hidden');
  document.getElementById('staff-gate-view').classList.add('hidden');
  document.getElementById('staff-portal-view').classList.add('hidden');
  document.getElementById('header-auth-controls').classList.add('hidden');
  document.getElementById('header-context-label').textContent = 'Sign in with Google to Continue';
  closeManageModal();
}

/* =========================================================================
   VIEW SWITCHING (PUBLIC FORM <-> STAFF GATE <-> STAFF PORTAL)
   ========================================================================= */
function openPublicView() {
  if (!googleUser) {
    openLoginView();
    return;
  }
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('public-view').classList.remove('hidden');
  document.getElementById('staff-gate-view').classList.add('hidden');
  document.getElementById('staff-portal-view').classList.add('hidden');

  document.getElementById('btn-header-staff').classList.remove('hidden');
  document.getElementById('btn-header-public').classList.add('hidden');
  document.getElementById('header-context-label').textContent = 'Citizen Issue Reporting & Community Support';
  closeManageModal();
}

function openStaffPortalView() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('public-view').classList.add('hidden');
  document.getElementById('btn-header-staff').classList.add('hidden');
  document.getElementById('btn-header-public').classList.remove('hidden');

  if (staffUnlocked) {
    showUnlockedStaffPortal();
  } else {
    document.getElementById('header-context-label').textContent = 'Staff / Admin Authentication';
    document.getElementById('staff-gate-view').classList.remove('hidden');
    document.getElementById('staff-portal-view').classList.add('hidden');
    document.getElementById('err-pin').classList.add('hidden');
  }
}


function fillDefaultPin() {
  document.getElementById('staff-pin-input').value = DEFAULT_PIN;
  document.getElementById('err-pin').classList.add('hidden');
}

function handlePinLogin(event) {
  event.preventDefault();
  const pinValue = document.getElementById('staff-pin-input').value.trim();
  if (pinValue === DEFAULT_PIN) {
    staffUnlocked = true;
    document.getElementById('err-pin').classList.add('hidden');
    showUnlockedStaffPortal();
    showToast('Staff portal unlocked.');
  } else {
    document.getElementById('err-pin').classList.remove('hidden');
  }
}

function showUnlockedStaffPortal() {
  document.getElementById('staff-gate-view').classList.add('hidden');
  document.getElementById('staff-portal-view').classList.remove('hidden');
  document.getElementById('header-context-label').textContent = 'Staff / Admin Operations Portal';
  switchStaffTab('queue');
  refreshStaffPortal();
}

function switchStaffTab(tabName) {
  const queueTab = document.getElementById('staff-tab-queue');
  const reportsTab = document.getElementById('staff-tab-reports');
  const queueBtn = document.getElementById('tab-queue-btn');
  const reportsBtn = document.getElementById('tab-reports-btn');

  if (tabName === 'reports') {
    queueTab.classList.add('hidden');
    reportsTab.classList.remove('hidden');
    queueBtn.classList.remove('active');
    queueBtn.setAttribute('aria-selected', 'false');
    reportsBtn.classList.add('active');
    reportsBtn.setAttribute('aria-selected', 'true');
    renderReportsInsights();
  } else {
    queueTab.classList.remove('hidden');
    reportsTab.classList.add('hidden');
    queueBtn.classList.add('active');
    queueBtn.setAttribute('aria-selected', 'true');
    reportsBtn.classList.remove('active');
    reportsBtn.setAttribute('aria-selected', 'false');
    renderQueueList();
  }
}

/* =========================================================================
   PUBLIC CITIZEN FORM HANDLING (WRITES TO FIRESTORE)
   ========================================================================= */
async function handleCitizenFormSubmit(event) {
  event.preventDefault();

  const nameInput = document.getElementById('reporter-name');
  const contactInput = document.getElementById('reporter-contact');
  const areaSelect = document.getElementById('issue-area');
  const categorySelect = document.getElementById('issue-category');
  const locationInput = document.getElementById('issue-location');
  const descInput = document.getElementById('issue-description');

  const reporterName = nameInput.value.trim();
  const contactInfo = contactInput.value.trim();
  const area = areaSelect.value;
  const category = categorySelect.value;
  const location = locationInput.value.trim();
  const description = descInput.value.trim();

  let valid = true;

  const toggleError = (elId, condition) => {
    const errEl = document.getElementById(elId);
    if (condition) {
      errEl.classList.remove('hidden');
      valid = false;
    } else {
      errEl.classList.add('hidden');
    }
  };

  toggleError('err-reporter-name', !reporterName);
  toggleError('err-reporter-contact', !contactInfo);
  toggleError('err-issue-area', !area);
  toggleError('err-issue-category', !category);
  toggleError('err-issue-location', !location);
  toggleError('err-issue-description', !description);

  if (!valid) return;

  const nextNumericId = requestsData.length > 0
    ? Math.max(...requestsData.map((item) => Number(item.id) || 0)) + 1
    : 1;
  const trackingId = formatTrackingId(nextNumericId);

  const newRequest = {
    id: nextNumericId,
    trackingId,
    reporterName,
    contactInfo,
    area,
    category,
    location,
    description,
    status: 'Pending',
    assignedTeam: 'Unassigned',
    priority: 'Medium',
    dueDate: relativeIsoDate(3),
    resolutionHours: null,
    history: [
      {
        timestamp: formatNowLabel(),
        note: `Request submitted by ${reporterName} (${contactInfo}) via Public Form.`
      }
    ]
  };

  try {
    // Save to Firestore using numeric ID as the document key
    await setDoc(doc(db, 'service_requests', String(nextNumericId)), newRequest);

    document.getElementById('confirmation-tracking-id').textContent = trackingId;
    document.getElementById('confirmation-summary').innerHTML = `
      <div><strong>Reporter:</strong> ${escapeHtml(reporterName)} (${escapeHtml(contactInfo)})</div>
      <div><strong>Area / Zone:</strong> ${escapeHtml(area)}</div>
      <div><strong>Category:</strong> ${escapeHtml(category)}</div>
      <div><strong>Location:</strong> ${escapeHtml(location)}</div>
    `;

    document.getElementById('citizen-form-card').classList.add('hidden');
    document.getElementById('citizen-confirmation-card').classList.remove('hidden');
    showToast(`Submitted ${trackingId}`);
  } catch (err) {
    console.error("Firestore save error:", err);
    showToast('Failed to submit request to database.');
  }
}

function resetCitizenFormView() {
  document.getElementById('citizen-form').reset();
  prefillCitizenFormFromGoogle();
  ['err-reporter-name', 'err-reporter-contact', 'err-issue-area', 'err-issue-category', 'err-issue-location', 'err-issue-description']
    .forEach((id) => document.getElementById(id).classList.add('hidden'));

  document.getElementById('citizen-confirmation-card').classList.add('hidden');
  document.getElementById('citizen-form-card').classList.remove('hidden');
}

/* =========================================================================
   STAFF PORTAL: STATS, FILTERS, TABLE & MOBILE CARDS
   ========================================================================= */
function isCompletedStatus(status) {
  return status === 'Resolved' || status === 'Closed';
}

function refreshStaffPortal() {
  updateSummaryCards();
  renderQueueList();
  renderReportsInsights();
}

function updateSummaryCards() {
  const pendingCount = requestsData.filter((r) => r.status === 'Pending').length;
  const inProgressCount = requestsData.filter((r) => r.status === 'In Progress' || r.status === 'Assigned').length;
  const completedItems = requestsData.filter((r) => isCompletedStatus(r.status));

  const timedItems = completedItems.filter((r) => typeof r.resolutionHours === 'number' && !Number.isNaN(r.resolutionHours));
  const avgResolution = timedItems.length > 0
    ? (timedItems.reduce((sum, r) => sum + r.resolutionHours, 0) / timedItems.length).toFixed(1) + 'h'
    : '0.0h';

  document.getElementById('stat-pending-count').textContent = pendingCount;
  document.getElementById('stat-progress-count').textContent = inProgressCount;
  document.getElementById('stat-completed-count').textContent = completedItems.length;
  document.getElementById('stat-avg-resolution').textContent = avgResolution;
}

function togglePendingOnly() {
  pendingOnlyFilter = !pendingOnlyFilter;
  const btn = document.getElementById('btn-pending-only');
  const statusSelect = document.getElementById('filter-status');

  if (pendingOnlyFilter) {
    btn.classList.add('btn-toggle-active');
    statusSelect.value = 'Pending';
  } else {
    btn.classList.remove('btn-toggle-active');
    if (statusSelect.value === 'Pending') {
      statusSelect.value = 'ALL';
    }
  }
  renderQueueList();
}

function syncStatusDropdown() {
  const statusValue = document.getElementById('filter-status').value;
  const btn = document.getElementById('btn-pending-only');
  pendingOnlyFilter = (statusValue === 'Pending');
  btn.classList.toggle('btn-toggle-active', pendingOnlyFilter);
  renderQueueList();
}

function getStatusBadgeClass(status) {
  switch (status) {
    case 'Pending': return 'st-pending';
    case 'Assigned': return 'st-assigned';
    case 'In Progress': return 'st-inprogress';
    case 'Resolved': return 'st-resolved';
    case 'Closed': return 'st-closed';
    default: return 'st-pending';
  }
}

function getPriorityBadgeClass(priority) {
  switch (priority) {
    case 'Low': return 'pr-low';
    case 'Medium': return 'pr-medium';
    case 'High': return 'pr-high';
    case 'Urgent': return 'pr-urgent';
    default: return 'pr-medium';
  }
}

function renderQueueList() {
  const searchQuery = document.getElementById('filter-search').value.trim().toLowerCase();
  const statusFilter = document.getElementById('filter-status').value;
  const categoryFilter = document.getElementById('filter-category').value;
  const areaFilter = document.getElementById('filter-area').value;

  const filtered = requestsData.filter((req) => {
    const matchesStatus = statusFilter === 'ALL' || req.status === statusFilter;
    const matchesCategory = categoryFilter === 'ALL' || req.category === categoryFilter;
    const matchesArea = areaFilter === 'ALL' || req.area === areaFilter;

    const haystack = [
      req.trackingId,
      req.reporterName,
      req.contactInfo,
      req.area,
      req.category,
      req.location,
      req.description,
      req.assignedTeam,
      req.status
    ].join(' ').toLowerCase();

    const matchesSearch = !searchQuery || haystack.includes(searchQuery);
    return matchesStatus && matchesCategory && matchesArea && matchesSearch;
  });

  document.getElementById('queue-visible-count').textContent = filtered.length;

  const tbody = document.getElementById('desktop-requests-tbody');
  const mobileList = document.getElementById('mobile-requests-list');

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center; padding:28px; color:var(--text-muted);">No matching service requests found.</td></tr>`;
    mobileList.innerHTML = `<div style="text-align:center; padding:24px; color:var(--text-muted); border:1px dashed var(--border-strong); border-radius:10px;">No matching service requests found.</div>`;
    return;
  }

  tbody.innerHTML = filtered.map((req) => `
    <tr>
      <td><strong class="tracking-code">${escapeHtml(req.trackingId)}</strong></td>
      <td>
        <div style="font-weight:700; color:var(--text-primary);">${escapeHtml(req.location)}</div>
        <div style="font-size:13px; color:var(--text-secondary); margin-top:2px;">${escapeHtml(req.description)}</div>
        <div style="font-size:12px; color:var(--text-muted); margin-top:4px;">${escapeHtml(req.reporterName)} &bull; ${escapeHtml(req.contactInfo)}</div>
      </td>
      <td>
        <div style="font-weight:600;">${escapeHtml(req.category)}</div>
        <div style="font-size:12px; color:var(--text-muted);">${escapeHtml(req.area)}</div>
      </td>
      <td><span class="badge ${getPriorityBadgeClass(req.priority)}">${escapeHtml(req.priority)}</span></td>
      <td><span class="badge ${getStatusBadgeClass(req.status)}">${escapeHtml(req.status)}</span></td>
      <td>${escapeHtml(req.assignedTeam)}</td>
      <td style="white-space:nowrap;">${escapeHtml(req.dueDate || 'Not set')}</td>
      <td>
        <button type="button" class="btn btn-outline btn-sm" onclick="openManageModal(${req.id})">Manage</button>
      </td>
    </tr>
  `).join('');

  mobileList.innerHTML = filtered.map((req) => `
    <article class="mobile-request-card">
      <div class="mobile-card-top">
        <span class="tracking-code">${escapeHtml(req.trackingId)} &bull; ${escapeHtml(req.category)}</span>
        <span class="badge ${getStatusBadgeClass(req.status)}">${escapeHtml(req.status)}</span>
      </div>
      <div class="mobile-card-title">${escapeHtml(req.location)} (${escapeHtml(req.area)})</div>
      <div class="mobile-card-desc">${escapeHtml(req.description)}</div>
      <div class="mobile-card-meta">
        <div>
          <span class="meta-label">Assigned Team</span>
          <span class="meta-val">${escapeHtml(req.assignedTeam)}</span>
        </div>
        <div>
          <span class="meta-label">Priority &amp; Due</span>
          <span class="meta-val">${escapeHtml(req.priority)} &bull; ${escapeHtml(req.dueDate || 'N/A')}</span>
        </div>
      </div>
      <button type="button" class="btn btn-outline btn-sm btn-full" onclick="openManageModal(${req.id})">Manage</button>
    </article>
  `).join('');
}

/* =========================================================================
   MANAGE REQUEST MODAL & DELETE FUNCTION (UPDATES / DELETES IN FIRESTORE)
   ========================================================================= */
function openManageModal(requestId) {
  const req = requestsData.find((item) => item.id === requestId);
  if (!req) return;

  editingRequestId = requestId;
  document.getElementById('modal-title').textContent = `Manage Request ${req.trackingId}`;
  document.getElementById('modal-request-summary').innerHTML = `
    <div><strong>Category &amp; Area:</strong> ${escapeHtml(req.category)} &mdash; ${escapeHtml(req.area)}</div>
    <div><strong>Location:</strong> ${escapeHtml(req.location)}</div>
    <div><strong>Reporter:</strong> ${escapeHtml(req.reporterName)} (${escapeHtml(req.contactInfo)})</div>
    <div style="margin-top:4px; color:var(--text-primary);"><strong>Description:</strong> ${escapeHtml(req.description)}</div>
  `;

  document.getElementById('modal-status').value = req.status;
  document.getElementById('modal-team').value = req.assignedTeam || 'Unassigned';
  document.getElementById('modal-priority').value = req.priority || 'Medium';
  document.getElementById('modal-due-date').value = req.dueDate || '';
  document.getElementById('modal-status-note').value = '';

  cancelDeleteRequest();
  renderModalHistory(req);
  document.getElementById('manage-modal').classList.remove('hidden');
}

function renderModalHistory(req) {
  const listEl = document.getElementById('modal-history-list');
  const entries = Array.isArray(req.history) ? req.history : [];
  if (entries.length === 0) {
    listEl.innerHTML = `<div style="font-size:13px; color:var(--text-muted);">No history entries recorded yet.</div>`;
    return;
  }
  listEl.innerHTML = entries.map((entry) => `
    <div class="history-item">
      <span class="history-timestamp">${escapeHtml(entry.timestamp)}</span>
      <div>${escapeHtml(entry.note)}</div>
    </div>
  `).join('');
}

function closeManageModal() {
  cancelDeleteRequest();
  document.getElementById('manage-modal').classList.add('hidden');
  editingRequestId = null;
}

function handleModalBackdropClick(event) {
  if (event.target.id === 'manage-modal') {
    closeManageModal();
  }
}

function promptDeleteRequest() {
  if (editingRequestId === null) return;
  const req = requestsData.find((item) => item.id === editingRequestId);
  const label = req ? `${req.trackingId} (${req.location})` : 'this request';
  document.getElementById('delete-confirm-text').textContent = `Delete ${label}? This cannot be undone.`;
  document.getElementById('delete-confirm-box').classList.remove('hidden');
  document.getElementById('btn-prompt-delete').classList.add('hidden');
}

function cancelDeleteRequest() {
  document.getElementById('delete-confirm-box').classList.add('hidden');
  document.getElementById('btn-prompt-delete').classList.remove('hidden');
}

async function deleteRequestById(requestId) {
  const target = requestsData.find((item) => item.id === requestId);
  if (!target) return null;

  await deleteDoc(doc(db, 'service_requests', String(requestId)));
  return target;
}

async function confirmDeleteRequest() {
  if (editingRequestId === null) return;
  try {
    const deleted = await deleteRequestById(editingRequestId);
    closeManageModal();
    if (deleted) {
      showToast(`Deleted request ${deleted.trackingId}.`);
    }
  } catch (err) {
    console.error("Delete error:", err);
    showToast('Failed to delete request.');
  }
}

async function saveRequestManagementChanges() {
  if (editingRequestId === null) return;
  const req = requestsData.find((item) => item.id === editingRequestId);
  if (!req) return;

  const nextStatus = document.getElementById('modal-status').value;
  const nextTeam = document.getElementById('modal-team').value;
  const nextPriority = document.getElementById('modal-priority').value;
  const nextDueDate = document.getElementById('modal-due-date').value;
  const noteInput = document.getElementById('modal-status-note').value.trim();
  const stamp = formatNowLabel();

  const changes = [];
  let updatedResolutionHours = req.resolutionHours;

  if (req.status !== nextStatus) {
    changes.push(`Status changed from "${req.status}" to "${nextStatus}".`);
    if (isCompletedStatus(nextStatus) && typeof updatedResolutionHours !== 'number') {
      updatedResolutionHours = 8.0;
    }
  }
  if (req.assignedTeam !== nextTeam) {
    changes.push(`Assigned team updated to "${nextTeam}".`);
  }
  if (req.priority !== nextPriority) {
    changes.push(`Priority set to "${nextPriority}".`);
  }
  if ((req.dueDate || '') !== nextDueDate) {
    changes.push(`Due date set to "${nextDueDate || 'None'}".`);
  }
  if (noteInput) {
    changes.push(`Note: ${noteInput}`);
  }

  if (changes.length === 0) {
    changes.push('Request reviewed with no field changes.');
  }

  const updatedHistory = Array.isArray(req.history) ? [...req.history] : [];
  changes.forEach((msg) => {
    updatedHistory.push({ timestamp: stamp, note: msg });
  });

  try {
    const docRef = doc(db, 'service_requests', String(editingRequestId));
    await updateDoc(docRef, {
      status: nextStatus,
      assignedTeam: nextTeam,
      priority: nextPriority,
      dueDate: nextDueDate,
      resolutionHours: updatedResolutionHours,
      history: updatedHistory
    });

    closeManageModal();
    showToast(`Saved updates for ${req.trackingId}.`);
  } catch (err) {
    console.error("Update error:", err);
    showToast('Failed to save updates to database.');
  }
}

/* =========================================================================
   REPORTS & INSIGHTS
   ========================================================================= */
function renderReportsInsights() {
  const total = requestsData.length || 1;

  const comboMap = {};
  requestsData.forEach((req) => {
    const key = `${req.area}|||${req.category}`;
    if (!comboMap[key]) {
      comboMap[key] = { area: req.area, category: req.category, count: 0, ids: [] };
    }
    comboMap[key].count += 1;
    comboMap[key].ids.push(req.trackingId);
  });

  const recurringList = Object.values(comboMap).filter((item) => item.count >= 2);
  const recurringBox = document.getElementById('recurring-issues-box');

  if (recurringList.length === 0) {
    recurringBox.innerHTML = `<p style="font-size:14px; color:var(--text-muted);">No recurring area + category combinations (2+ reports) detected right now.</p>`;
  } else {
    recurringBox.innerHTML = recurringList.map((item) => `
      <div class="recurring-alert">
        <strong>Recurring Issue:</strong> <strong>${escapeHtml(item.category)}</strong> in <strong>${escapeHtml(item.area)}</strong>
        has <strong>${item.count} reports</strong> (${escapeHtml(item.ids.join(', '))}).
      </div>
    `).join('');
  }

  document.getElementById('report-by-area').innerHTML = AREAS_LIST.map((area) => {
    const count = requestsData.filter((r) => r.area === area).length;
    const pct = requestsData.length > 0 ? Math.round((count / total) * 100) : 0;
    return `
      <div class="bar-row">
        <div class="bar-labels">
          <span>${escapeHtml(area)}</span>
          <span>${count} (${pct}%)</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill" style="width:${pct}%;"></div>
        </div>
      </div>
    `;
  }).join('');

  document.getElementById('report-by-category').innerHTML = CATEGORIES_LIST.map((category) => {
    const count = requestsData.filter((r) => r.category === category).length;
    const pct = requestsData.length > 0 ? Math.round((count / total) * 100) : 0;
    return `
      <div class="bar-row">
        <div class="bar-labels">
          <span>${escapeHtml(category)}</span>
          <span>${count} (${pct}%)</span>
        </div>
        <div class="bar-track">
          <div class="bar-fill alt" style="width:${pct}%;"></div>
        </div>
      </div>
    `;
  }).join('');

  const completedCount = requestsData.filter((r) => isCompletedStatus(r.status)).length;
  const openCount = requestsData.length - completedCount;
  const avgText = document.getElementById('stat-avg-resolution').textContent;

  document.getElementById('report-resolution-summary').innerHTML = `
    <p style="margin-bottom:8px;">
      <strong>Total Requests:</strong> ${requestsData.length} &nbsp;&bull;&nbsp;
      <strong>Open / Active:</strong> ${openCount} &nbsp;&bull;&nbsp;
      <strong>Completed (Resolved / Closed):</strong> ${completedCount}
    </p>
    <p>
      <strong>Average Resolution Time:</strong> ${escapeHtml(avgText)} across completed requests.
    </p>
  `;
}

/* =========================================================================
   HELPERS (HTML ESCAPING & TOAST)
   ========================================================================= */
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showToast(message) {
  const toastEl = document.getElementById('toast-banner');
  toastEl.textContent = message;
  toastEl.classList.remove('hidden');

  if (toastTimeoutId) {
    clearTimeout(toastTimeoutId);
  }
  toastTimeoutId = setTimeout(() => {
    toastEl.classList.add('hidden');
  }, 2600);
}

/* =========================================================================
   EXPOSE FUNCTIONS TO WINDOW (REQUIRED FOR INLINE HTML ONCLICK/ONSUBMIT)
   ========================================================================= */
Object.assign(window, {
  resetSampleData,
  signInWithGoogle,
  signInWithDemoGoogle,
  handleGoogleSignOut,
  openPublicView,
  openStaffPortalView,
  fillDefaultPin,
  handlePinLogin,
  switchStaffTab,
  handleCitizenFormSubmit,
  resetCitizenFormView,
  togglePendingOnly,
  syncStatusDropdown,
  renderQueueList,
  openManageModal,
  closeManageModal,
  handleModalBackdropClick,
  promptDeleteRequest,
  cancelDeleteRequest,
  confirmDeleteRequest,
  saveRequestManagementChanges
});

window.addEventListener('DOMContentLoaded', () => {
  subscribeToRequests();

  onAuthStateChanged(auth, (user) => {
    if (user) {
      applySignedInUI({
        name: user.displayName || 'Google User',
        email: user.email || '',
        picture: user.photoURL || ''
      });
    } else if (!googleUser) {
      openLoginView();
    }
  });
});

