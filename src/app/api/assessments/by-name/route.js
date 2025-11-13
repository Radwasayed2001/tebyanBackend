export const runtime = 'nodejs';

import fs from 'fs';
import path from 'path';

// --- small CORS + JSON helpers ---
function corsHeaders(origin) {
    const allowedOrigin = origin || '*';
    return {
        'Access-Control-Allow-Origin': allowedOrigin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Credentials': 'true',
        'Access-Control-Max-Age': '600'
    };
}
function jsonResponse(body, { status = 200, origin } = {}) {
    const headers = { 'Content-Type': 'application/json', ...corsHeaders(origin) };
    return new Response(JSON.stringify(body), { status, headers });
}
export async function OPTIONS(request) {
    const origin = request.headers.get('origin') || '*';
    const headers = { ...corsHeaders(origin), 'Content-Length': '0' };
    return new Response(null, { status: 204, headers });
}

// --- Service account loader / admin initializer ---
let _admin = null;
let _adminInitTried = false;

function normalizeName(n) {
    if (!n) return '';
    return String(n).trim();
}

function loadServiceAccountFromPath() {
    const p = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (!p) return null;
    try {
        const full = path.isAbsolute(p) ? p : path.join(process.cwd(), p);
        const txt = fs.readFileSync(full, 'utf8');
        return JSON.parse(txt);
    } catch (err) {
        console.warn('[loadSA] failed to read SA file at', p, err?.message || err);
        return null;
    }
}

function loadServiceAccountFromEnv() {
    // try plain JSON env
    const raw = process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (raw) {
        try {
            // If already a stringified JSON or multi-line
            return typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (err) {
            console.warn('[loadSA] FIREBASE_SERVICE_ACCOUNT invalid JSON:', err?.message || err);
            // continue to try base64
        }
    }
    // try base64 env
    const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_B64;
    if (b64) {
        try {
            const parsed = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
            return parsed;
        } catch (err) {
            console.warn('[loadSA] FIREBASE_SERVICE_ACCOUNT_B64 invalid:', err?.message || err);
        }
    }
    return null;
}

async function initializeAdminIfPossible() {
    if (_adminInitTried) return _admin; // avoid repeated tries
    _adminInitTried = true;

    // try to import firebase-admin dynamically (so bundler doesn't force it for browser)
    try {
        const admin = await import('firebase-admin');
        // already initialized?
        if (admin.apps && admin.apps.length > 0) {
            _admin = admin;
            return _admin;
        }

        // find service account
        const sa = loadServiceAccountFromPath() || loadServiceAccountFromEnv();
        if (!sa) {
            console.warn('[initializeAdmin] no service account found in FIREBASE_SERVICE_ACCOUNT_PATH / FIREBASE_SERVICE_ACCOUNT[_B64]');
            return null;
        }

        try {
            admin.initializeApp({ credential: admin.credential.cert(sa) });
            _admin = admin;
            console.log('[initializeAdmin] firebase-admin initialized');
            return _admin;
        } catch (err) {
            console.error('[initializeAdmin] failed to initialize firebase-admin:', err?.message || err);
            return null;
        }
    } catch (err) {
        console.warn('[initializeAdmin] firebase-admin not installed or import failed:', err?.message || err);
        return null;
    }
}

// --- Firestore lookup ---
// helpers in route.js (server-side)
function normalizeArabicName(s) {
    if (!s) return '';
    // basic normalize: trim, collapse spaces, remove Arabic diacritics, lowercase
    const diacritics = /[\u064B-\u065F\u0610-\u061A\u06D6-\u06ED]/g;
    return String(s)
        .normalize('NFC')
        .replace(diacritics, '')        // remove tashkeel
        .replace(/\s+/g, ' ')           // collapse multiple spaces
        .trim()
        .toLowerCase();
}

async function fetchAssessmentsByChildName(childName, options = { limit: 1 }) {
    const name = String(childName || '').trim();
    if (!name) return [];

    // normalized search key
    const nameNorm = normalizeArabicName(name);

    // try admin SDK first (if available)
    try {
        if (process.env.FIREBASE_SERVICE_ACCOUNT || process.env.FIREBASE_SERVICE_ACCOUNT_PATH) {
            const admin = await import('firebase-admin');
            // initialize if needed (your existing init logic)
            if (!admin.apps || admin.apps.length === 0) {
                // please reuse your existing service account loading logic
                const saJson = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
                    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
                    : (process.env.FIREBASE_SERVICE_ACCOUNT_PATH ? require(process.env.FIREBASE_SERVICE_ACCOUNT_PATH) : null);
                admin.initializeApp({ credential: admin.credential.cert(saJson) });
            }
            const db = admin.firestore();

            // 1) exact match (fast)
            let q = db.collection('assessments').where('assessmentData.basicInfo.childName', '==', name);
            try {
                if (options.orderByCreatedAt !== false) q = q.orderBy('createdAt', 'desc');
            } catch (_) { }
            if (options.limit && options.limit > 0) q = q.limit(options.limit);
            let snap = await q.get();
            if (!snap.empty) return snap.docs.map(d => ({ id: d.id, data: d.data() }));

            // 2) try trimmed exact (in case request had extra spaces but db has trimmed or vice versa)
            q = db.collection('assessments').where('assessmentData.basicInfo.childName', '==', name.trim());
            try { if (options.orderByCreatedAt !== false) q = q.orderBy('createdAt', 'desc'); } catch (_) { }
            if (options.limit && options.limit > 0) q = q.limit(options.limit);
            snap = await q.get();
            if (!snap.empty) return snap.docs.map(d => ({ id: d.id, data: d.data() }));

            // 3) prefix range search (good for partial matches)
            // works for prefix only — less precise but may find "آلاء آدم ..." when searching "آلاء آدم"
            const start = name;
            const end = name + '\uf8ff';
            q = db.collection('assessments')
                .where('assessmentData.basicInfo.childName', '>=', start)
                .where('assessmentData.basicInfo.childName', '<=', end);
            if (options.limit && options.limit > 0) q = q.limit(options.limit);
            snap = await q.get();
            if (!snap.empty) return snap.docs.map(d => ({ id: d.id, data: d.data() }));

            // 4) fallback: fetch a reasonable window and filter client-side using normalization
            // WARNING: this reads more documents — use limit or conditions to reduce cost
            const fallbackLimit = options.fallbackLimit || 200;
            const allSnap = await db.collection('assessments').limit(fallbackLimit).get();
            const out = [];
            allSnap.forEach(doc => {
                const data = doc.data();
                const rawName = data?.assessmentData?.basicInfo?.childName || '';
                if (normalizeArabicName(rawName) === nameNorm) {
                    out.push({ id: doc.id, data });
                }
            });
            return out;
        }
    } catch (err) {
        console.warn('[fetchAssessments] admin path failed', err?.message || err);
        // fall through to client SDK path below
    }

    // If admin not available, fallback to client SDK path (similar logic)
    try {
        const { initializeApp } = await import('firebase/app');
        const { getFirestore, collection, query, where, orderBy, limit, getDocs } = await import('firebase/firestore');
        const firebaseConfig = {
            apiKey: process.env.VITE_FIREBASE_API_KEY || process.env.FIREBASE_API_KEY || '',
            authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN || process.env.FIREBASE_AUTH_DOMAIN || '',
            projectId: process.env.VITE_FIREBASE_PROJECT_ID || process.env.FIREBASE_PROJECT_ID || '',
            storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET || process.env.FIREBASE_STORAGE_BUCKET || '',
            messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID || process.env.FIREBASE_MESSAGING_SENDER_ID || '',
            appId: process.env.VITE_FIREBASE_APP_ID || process.env.FIREBASE_APP_ID || ''
        };
        try { initializeApp(firebaseConfig, `server-${firebaseConfig.projectId || 'default'}`); } catch (_) { }
        const db = getFirestore();
        // 1) exact
        let q = query(collection(db, 'assessments'), where('assessmentData.basicInfo.childName', '==', name), ...(options.limit ? [limit(options.limit)] : []));
        let snaps = await getDocs(q);
        if (!snaps.empty) return snaps.docs.map(d => ({ id: d.id, data: d.data() }));
        // 2) trimmed exact
        q = query(collection(db, 'assessments'), where('assessmentData.basicInfo.childName', '==', name.trim()), ...(options.limit ? [limit(options.limit)] : []));
        snaps = await getDocs(q);
        if (!snaps.empty) return snaps.docs.map(d => ({ id: d.id, data: d.data() }));
        // 3) prefix range (client SDK doesn't allow combining where range on same field? test in your env)
        // 4) fallback local normalization scan (be careful re: reads!)
        const fallbackLimit = options.fallbackLimit || 200;
        const allSnap = await getDocs(query(collection(db, 'assessments'), limit(fallbackLimit)));
        const out = [];
        allSnap.forEach(doc => {
            const data = doc.data();
            const rawName = data?.assessmentData?.basicInfo?.childName || '';
            if (normalizeArabicName(rawName) === nameNorm) out.push({ id: doc.id, data });
        });
        return out;
    } catch (err) {
        console.warn('[fetchAssessments] client SDK path failed', err?.message || err);
        return [];
    }
}


// --- route handlers ---
export async function POST(request) {
    const origin = request.headers.get('origin') || '*';
    try {
        const body = await request.json().catch(async () => {
            const t = await request.text().catch(() => '');
            try { return JSON.parse(t); } catch (_) { return {}; }
        });

        const childName = normalizeName(body?.childName || body?.name || '');
        const returnAll = !!body?.all;

        if (!childName) {
            return jsonResponse({ ok: false, error: 'childName is required in request body' }, { status: 400, origin });
        }

        const limit = returnAll ? 50 : 1;
        const results = await fetchAssessmentsByChildName(childName, { limit, orderByCreatedAt: true });

        return jsonResponse({ ok: true, count: (results || []).length, results }, { status: 200, origin });
    } catch (err) {
        console.error('[assessments/by-name] error:', err);
        return jsonResponse({ ok: false, error: err?.message || String(err) }, { status: 500, origin });
    }
}

export async function GET(request) {
    const origin = request.headers.get('origin') || '*';
    return jsonResponse({ ok: true, msg: 'assessments/by-name endpoint OK' }, { status: 200, origin });
}
