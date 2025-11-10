// app/api/analyze/route.js
import fs from 'fs';
import path from 'path';

export const runtime = 'nodejs';

// helper to build CORS headers (use origin if provided)
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

// helper to return JSON response with CORS
function jsonResponse(body, { status = 200, origin } = {}) {
    const headers = {
        'Content-Type': 'application/json',
        ...corsHeaders(origin)
    };
    return new Response(JSON.stringify(body), { status, headers });
}

// respond to OPTIONS preflight
export async function OPTIONS(request) {
    const origin = request.headers.get('origin') || '*';
    const headers = {
        ...corsHeaders(origin),
        'Content-Length': '0'
    };
    return new Response(null, { status: 204, headers });
}

// safe JSON parse helper (tries to extract first JSON object inside text)
function safeParseJSON(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try {
        return JSON.parse(raw);
    } catch (e) {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
            try { return JSON.parse(match[0]); } catch (_) { return null; }
        }
    }
    return null;
}

// Ensure suggestion/customization entries are objects with a stable shape
function ensureSuggestionObjects(arr) {
    if (!Array.isArray(arr)) return [];
    return arr.map(item => {
        if (typeof item === 'string') {
            return { text: item, rationale: '', confidence: null };
        }
        if (item && typeof item === 'object') {
            return {
                text: item.text || item.title || item.label || String(item),
                rationale: item.rationale || item.reason || item.explanation || '',
                confidence: (typeof item.confidence === 'number') ? item.confidence : null
            };
        }
        return { text: String(item), rationale: '', confidence: null };
    });
}

// normalize AI output into the canonical plan schema expected by frontend (general)
function normalizeAi(parsed, fallbackNote = '') {
    const canonical = {
        smart_goal: '',
        summary: '',
        teaching_strategy: '',
        task_analysis_steps: [],
        subgoals: [],
        activities: [],
        execution_plan: [],
        reinforcement: { type: '', schedule: '' },
        measurement: { type: '', sheet: '' },
        generalization_plan: [],
        accommodations: [],
        suggestions: [],
        customizations: [],
        parent_instructions: '',
        meta: {}
    };

    if (!parsed || typeof parsed !== 'object') {
        canonical.summary = fallbackNote || '';
        canonical.suggestions = ['لا توجد مخرجات AI صالحة؛ تم إرجاع ملخص افتراضي.'];
        return canonical;
    }

    canonical.summary = parsed.summary || parsed.smart_goal || parsed.overview || '';
    canonical.smart_goal = parsed.smart_goal || parsed.summary || parsed.goal || canonical.summary;
    canonical.teaching_strategy = parsed.teaching_strategy || parsed.strategy || parsed.customization || parsed.teaching || '';

    const tasksCandidates = parsed.task_analysis_steps || parsed.task_analysis || parsed.steps || parsed.tasks || parsed.customizations || [];
    if (Array.isArray(tasksCandidates)) {
        canonical.task_analysis_steps = tasksCandidates.map(String);
    } else if (typeof tasksCandidates === 'string' && tasksCandidates.trim()) {
        canonical.task_analysis_steps = tasksCandidates.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    }

    const subs = parsed.subgoals || parsed.goals || parsed.suggestions || parsed.phases || [];
    if (Array.isArray(subs)) canonical.subgoals = subs.map(String);
    else if (typeof subs === 'string' && subs.trim()) canonical.subgoals = subs.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    const acts = parsed.activities || parsed.activities_list || parsed.tasks_list || [];
    if (Array.isArray(acts)) {
        canonical.activities = acts.map(a => {
            if (typeof a === 'string') {
                const parts = a.split(':').map(p => p.trim());
                if (parts.length >= 2) return { type: parts[0], name: parts.slice(1).join(':') };
                return { type: 'نشاط', name: a };
            } else if (a && typeof a === 'object') {
                return {
                    type: a.type || a.kind || a.category || 'نشاط',
                    name: a.name || a.title || a.label || JSON.stringify(a)
                };
            } else {
                return { type: 'نشاط', name: String(a) };
            }
        });
    } else if (typeof acts === 'string' && acts.trim()) {
        canonical.activities = acts.split(/\r?\n/).map(s => {
            const parts = s.split(':').map(p => p.trim());
            if (parts.length >= 2) return { type: parts[0], name: parts.slice(1).join(':') };
            return { type: 'نشاط', name: s.trim() };
        }).filter(Boolean);
    }

    const execPlan = parsed.execution_plan || parsed.execution || parsed.steps_plan || [];
    if (Array.isArray(execPlan)) canonical.execution_plan = execPlan.map(String);
    else if (typeof execPlan === 'string' && execPlan.trim()) canonical.execution_plan = execPlan.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    canonical.reinforcement.type = (parsed.reinforcement && (parsed.reinforcement.type || parsed.reinforcement.name)) || parsed.reinforce || '';
    canonical.reinforcement.schedule = (parsed.reinforcement && parsed.reinforcement.schedule) || parsed.reinforce_schedule || parsed.reinforcement_schedule || '';

    canonical.measurement.type = (parsed.measurement && (parsed.measurement.type || parsed.measurement.method)) || parsed.measurement_type || '';
    canonical.measurement.sheet = (parsed.measurement && parsed.measurement.sheet) || parsed.measurement_tool || '';

    const gen = parsed.generalization_plan || parsed.generalization || parsed.generalise || [];
    if (Array.isArray(gen)) canonical.generalization_plan = gen.map(String);
    else if (typeof gen === 'string' && gen.trim()) canonical.generalization_plan = gen.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    const acc = parsed.accommodations || parsed.accommodation || parsed.adaptations || [];
    if (Array.isArray(acc)) canonical.accommodations = acc.map(String);
    else if (typeof acc === 'string' && acc.trim()) canonical.accommodations = acc.split(/\r?\n/).map(s => s.trim()).filter(Boolean);

    canonical.suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.map(String) : (typeof parsed.suggestions === 'string' ? parsed.suggestions.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : []);
    canonical.customizations = Array.isArray(parsed.customizations) ? parsed.customizations.map(String) : (typeof parsed.customizations === 'string' ? parsed.customizations.split(/\r?\n/).map(s => s.trim()).filter(Boolean) : []);

    canonical.parent_instructions = parsed.parent_instructions || parsed.caregiver_instructions || parsed.home_instructions || '';

    canonical.meta = {
        model_provided_confidence: parsed.confidence || parsed.confidence_score || null,
        notes: parsed._notes || parsed.notes || ''
    };

    if (!canonical.task_analysis_steps.length) {
        const maybe = canonical.customizations.length ? canonical.customizations : canonical.suggestions;
        if (maybe.length) canonical.task_analysis_steps = maybe.slice(0, 6);
    }
    if (!canonical.smart_goal) canonical.smart_goal = canonical.summary || `خطة بناءً على الملاحظة.`;
    if (!canonical.teaching_strategy && canonical.customizations.length) canonical.teaching_strategy = canonical.customizations[0];

    return canonical;
}

// New: normalize outputs specifically for behavioral (BIP) responses
function normalizeBehavior(parsed, fallbackNote = '') {
    const splitSentences = (text) => {
        if (!text || typeof text !== 'string') return [];
        return text
            .split(/[\.\?\!\;\n]+/)
            .map(s => s.trim())
            .filter(Boolean);
    };

    const collectStrings = (obj) => {
        const out = [];
        const walk = (v) => {
            if (!v && v !== 0) return;
            if (typeof v === 'string') out.push(v);
            else if (Array.isArray(v)) v.forEach(walk);
            else if (typeof v === 'object') Object.values(v).forEach(walk);
        };
        walk(obj);
        return out;
    };

    const containsKeyword = (s, keywords) => {
        if (!s) return false;
        const low = s.toLowerCase();
        return keywords.some(k => low.includes(k));
    };

    const antecedentKeywords = ['قبل', 'عند', 'أثناء', 'مسبق', 'سابقاً', 'قبل السلوك'];
    const consequenceKeywords = ['بعد', 'عقب', 'ينتج', 'نتيجة', 'يحصل', 'يحصل على', 'يؤدي إلى', 'ثم'];

    const canonical = {
        behavior_goal: '',
        summary: '',
        antecedents: [],
        consequences: [],
        function_analysis: '',
        antecedent_strategies: [],
        replacement_behavior: { skill: '', modality: '' },
        consequence_strategies: [],
        data_collection: { metric: '', tool: '' },
        review_after_days: 14,
        safety_flag: false,
        suggestions: [],
        customizations: [],
        parent_instructions: '',
        meta: {}
    };

    if (!parsed || typeof parsed !== 'object') {
        canonical.summary = fallbackNote || '';
        canonical.suggestions = ['لا توجد مخرجات AI صالحة؛ تم إرجاع ملخص افتراضي.'];
        return canonical;
    }

    canonical.summary = parsed.summary || parsed.behavior_goal || parsed.smart_goal || parsed.overview || '';
    canonical.behavior_goal = parsed.behavior_goal || parsed.smart_goal || parsed.summary || '';

    const toArrayStrings = (v) => {
        if (!v && v !== 0) return [];
        if (Array.isArray(v)) return v.map(String).map(s => s.trim()).filter(Boolean);
        if (typeof v === 'string') return splitSentences(v);
        return [];
    };

    canonical.antecedents = toArrayStrings(parsed.antecedents || parsed.antecedent || parsed.preceding || parsed.before);
    canonical.consequences = toArrayStrings(parsed.consequences || parsed.consequence || parsed.following || parsed.after);

    canonical.function_analysis = parsed.function_analysis || parsed.behavior_function || parsed.hypothesized_function || parsed.function || '';

    canonical.antecedent_strategies = toArrayStrings(parsed.antecedent_strategies || parsed.antecedentStrategies || parsed.prevention || parsed.proactive || parsed.prep);
    canonical.consequence_strategies = toArrayStrings(parsed.consequence_strategies || parsed.consequenceStrategies || parsed.response_strategies || parsed.reactive || parsed.reinforcement);

    if (parsed.replacement_behavior && typeof parsed.replacement_behavior === 'object') {
        canonical.replacement_behavior.skill = parsed.replacement_behavior.skill || parsed.replacement_behavior.name || parsed.replacement_behavior.label || '';
        canonical.replacement_behavior.modality = parsed.replacement_behavior.modality || parsed.replacement_behavior.medium || '';
    } else if (typeof parsed.replacement_behavior === 'string') {
        const s = parsed.replacement_behavior;
        const parts = s.split(/\||\-|\:/).map(p => p.trim()).filter(Boolean);
        canonical.replacement_behavior.skill = parts[0] || s;
        canonical.replacement_behavior.modality = parts[1] || '';
    } else {
        canonical.replacement_behavior.skill = parsed.replacement || parsed.replacement_skill || '';
        canonical.replacement_behavior.modality = parsed.replacement_modality || '';
    }

    canonical.data_collection.metric = (parsed.data_collection && (parsed.data_collection.metric || parsed.data_collection.measure)) || parsed.measurement?.type || parsed.metric || '';
    canonical.data_collection.tool = (parsed.data_collection && (parsed.data_collection.tool || parsed.data_collection.instrument)) || parsed.measurement?.sheet || parsed.tool || '';

    canonical.review_after_days = parsed.review_after_days || parsed.meta?.review_after_days || parsed.review || 14;
    canonical.safety_flag = !!parsed.safety_flag || !!parsed.meta?.safety_flag || (parsed.severity === 'شديد') || false;

    canonical.suggestions = toArrayStrings(parsed.suggestions || parsed.recommendations || parsed.advice);
    canonical.customizations = toArrayStrings(parsed.customizations || parsed.tweaks || parsed.modifications);

    canonical.parent_instructions = parsed.parent_instructions || parsed.caregiver_instructions || parsed.home_instructions || '';
    canonical.meta = {
        model_provided_confidence: parsed.confidence || parsed.confidence_score || null,
        notes: parsed._notes || parsed.notes || ''
    };

    const allStrings = collectStrings(parsed).flatMap(s => splitSentences(String(s)));
    if (!canonical.antecedents.length) {
        const cand = allStrings.filter(s => containsKeyword(s, antecedentKeywords));
        if (cand.length) canonical.antecedents = cand;
    }
    if (!canonical.consequences.length) {
        const cand = allStrings.filter(s => containsKeyword(s, consequenceKeywords));
        if (cand.length) canonical.consequences = cand;
    }
    if (!canonical.antecedent_strategies.length) {
        const cand = canonical.suggestions.length ? canonical.suggestions.map(s => (typeof s === 'object' ? s.text || '' : String(s))) : [];
        canonical.antecedent_strategies = cand.slice(0, 6);
    }
    if (!canonical.consequence_strategies.length) {
        const cand = canonical.customizations.length ? canonical.customizations.map(s => (typeof s === 'object' ? s.text || '' : String(s))) : [];
        canonical.consequence_strategies = cand.slice(0, 6);
    }

    if (!canonical.consequences.length && canonical.summary) {
        const sents = splitSentences(canonical.summary).filter(Boolean);
        const cand = sents.filter(s => containsKeyword(s, consequenceKeywords));
        if (cand.length) canonical.consequences = cand;
    }

    const uniq = (arr) => Array.from(new Set((arr || []).map(String).map(s => s.trim()).filter(Boolean)));

    canonical.antecedents = uniq(canonical.antecedents);
    canonical.consequences = uniq(canonical.consequences);
    canonical.antecedent_strategies = uniq(canonical.antecedent_strategies);
    canonical.consequence_strategies = uniq(canonical.consequence_strategies);
    canonical.suggestions = uniq(canonical.suggestions);
    canonical.customizations = uniq(canonical.customizations);

    if (!canonical.antecedents.length) canonical.antecedents = [];
    if (!canonical.consequences.length) canonical.consequences = [];

    return canonical;
}


export async function POST(request) {
    const origin = request.headers.get('origin') || '*';

    try {
        const body = await request.json().catch(async () => {
            // if not JSON, try text body
            const txt = await request.text().catch(() => '');
            return safeParseJSON(txt) || {};
        });

        const {
            textNote,
            currentActivity,
            energyLevel,
            tags = [],
            sessionDuration = 0,
            curriculumQuery,
            audioUrl,
            analysisType = 'general', // NEW: frontend can send analysisType: 'behavior'
            planType, // Alternative parameter name for plan type
            messagesForModel // optional override from client
        } = body || {};

        // Support both analysisType and planType parameters
        const effectiveAnalysisType = planType === 'behavioral' ? 'behavior' : analysisType;

        if (!textNote && !audioUrl) {
            return jsonResponse({ error: 'لا يوجد نص أو رابط صوتي للتحليل' }, { status: 400, origin });
        }

        // load curriculum data if exists
        const dataPath = path.join(process.cwd(), 'data', 'curriculum.json');
        let curriculum = [];
        try {
            const rawFile = fs.readFileSync(dataPath, 'utf8');
            curriculum = JSON.parse(rawFile);
        } catch (e) {
            curriculum = [];
            console.warn('[analyze] failed to read curriculum.json or file missing:', e.message);
        }

        const query = (curriculumQuery || textNote || '').toLowerCase().trim();
        const matched = query
            ? curriculum.filter(c => (c.title + ' ' + c.content).toLowerCase().includes(query))
            : [];

        const relevant = matched
            .slice(0, 3)
            .map(c => `Title: ${c.title}\n${c.content}`)
            .join('\n\n---\n\n')
            .slice(0, 3000);

        console.log('--- analyze request body ---');
        console.log({ textNote: textNote?.slice(0, 200), currentActivity, energyLevel, tags, sessionDuration, curriculumQuery, audioUrl, analysisType, planType, effectiveAnalysisType });
        console.log('--- relevant (truncated) ---');
        console.log(relevant ? relevant.slice(0, 1000) : '(no relevant curriculum)');

        // Build prompts and few-shot depending on analysisType
        let baseSystemPromptLines = [
            'أنت مساعد خبير في علم نفس وتطوير الطفل وموجه للمعلمات (Arabic).',
            '**المهمة:** اقرأ الملاحظة والبيانات المرفقة (Relevant curriculum إن وُجد) ثم أعد ناتجًا بصيغة JSON فقط — وصِف خطة تعليمية عملية ومفصّلة قابلة للتطبيق من قِبل معلمة أو ولي أمر.',
            '',
            '**Output MUST be valid JSON** and must contain the following keys (use empty array or empty string if غير متوفر):',
            '{',
            '  "smart_goal", "teaching_strategy", "task_analysis_steps", "subgoals", "activities",',
            '  "execution_plan", "reinforcement", "measurement", "generalization_plan", "accommodations",',
            '  "suggestions", "customizations", "summary", "parent_instructions"',
            '}',
            '',
            'Return JSON ONLY — no extra text. Keep arrays short and items actionable.'
        ];
        let systemPrompt = baseSystemPromptLines.join('\n');
        let exampleUser = [
            'Example note:',
            'Child: هاجر',
            'Age: 5',
            'Domain: التواصل/اللغة',
            'Goal: طلب الشيء (باستخدام جملة قصيرة)',
            'Observation: الطفل يستخدم كلمات منفردة فقط، يحتاج دعم للتواصل التلقائي.'
        ].join('\n');
        let exampleAssistant = JSON.stringify({
            smart_goal: "خلال شهر، سيقوم الطفل هاجر بطلب الشيء باستخدام جملة قصيرة مكوّنة من كلمتين مـعتمدة في 80% من المحاولات.",
            teaching_strategy: "التلقين البصري واللفظي مع التحفيز الاجتماعي",
            task_analysis_steps: ["تحديد الشيء", "إشارة", "نموذج لفظي 'أريد + اسم'", "تشجيع ومكافأة"],
            subgoals: ["الأسبوع 1: نموذج لفظي + بصري", "الأسبوع 2: تقليل المساعدة"],
            activities: [{ type: "بطاقات", name: "بطاقات تسلسل الطلب" }],
            execution_plan: ["تهيئة (2 دقيقة)", "تطبيق (4-6 محاولات)"],
            reinforcement: { type: "مكافأة فورية", schedule: "بعد كل نجاحين" },
            measurement: { type: "Accuracy", sheet: "تسجيل (+/P/-)" },
            generalization_plan: ["التطبيق في المنزل مع ولي الأمر"],
            accommodations: ["مؤقت بصري"],
            suggestions: ["استخدام نموذج لفظي ثابت"],
            customizations: ["تقسيم النشاط"],
            summary: "الطفل يحتاج نمذجة لفظية وبصرية متكررة.",
            parent_instructions: "تمرن 5 دقائق يوميًا مع ولي الأمر"
        }, null, 2);

        if (effectiveAnalysisType === 'behavior') {
            systemPrompt = [
                'أنت خبير تحليل سلوكي (BCBA-like) ومصمم خطط تدخل سلوكي (BIP) باللغة العربية.',
                '**المهمة:** اقرأ الملاحظة والبيانات ثم أعد ناتجًا بصيغة JSON ONLY. يجب أن يُرجع JSON بمخطط BIP واضح وقابل للتطبيق من قبل معلمة أو ولي أمر.',
                '',
                '**قواعد صارمة:**',
                '1. لا تكرر نص الملاحظة الأصلية في أي حقل',
                '2. كل حقل يجب أن يحتوي على محتوى جديد ومفيد',
                '3. استخدم لغة مختصرة ومحددة',
                '4. تجنب العبارات العامة مثل "لا توجد بيانات"',
                '5. قدم حلول عملية قابلة للتطبيق',
                '',
                '**Output MUST be valid JSON** and must contain these keys:',
                '{',
                '  "behavior_goal": "هدف سلوكي محدد وقابل للقياس",',
                '  "summary": "ملخص مختصر للسلوك والوظيفة",',
                '  "antecedents": ["قائمة المثيرات التي تسبق السلوك"],',
                '  "consequences": ["قائمة العواقب التي تلي السلوك"],',
                '  "function_analysis": "تحليل وظيفة السلوك (انتباه/هروب/حصول على شيء/حسي)",',
                '  "antecedent_strategies": ["استراتيجيات منع السلوك قبل حدوثه"],',
                '  "replacement_behavior": {"skill": "المهارة البديلة", "modality": "طريقة التطبيق"},',
                '  "consequence_strategies": ["استراتيجيات الاستجابة للسلوك"],',
                '  "data_collection": {"metric": "طريقة القياس", "tool": "أداة التسجيل"},',
                '  "review_after_days": 14,',
                '  "safety_flag": false,',
                '  "suggestions": ["اقتراحات إضافية للتحسين"],',
                '  "customizations": ["تعديلات مخصصة للطفل"],',
                '  "parent_instructions": "تعليمات واضحة لولي الأمر"',
                '}',
                '',
                'Return JSON ONLY — nothing else.'
            ].join('\n');

            exampleUser = [
                'Example note:',
                'Child: أحمد',
                'Age: 8',
                'Domain: سلوك',
                'Observation: الطفل لا يصلي عند سماع الأذان ويفضل اللعب حتى يُذكّر عدة مرات.',
                'Antecedent: سماع الأذان، انشغال باللعب',
                'Behavior: تجاهل الأذان والاستمرار في اللعب',
                'Consequence: تذكير متكرر من الأهل، انتباه إضافي'
            ].join('\n');

            exampleAssistant = JSON.stringify({
                behavior_goal: "خلال أسبوعين، سيقوم الطفل بأداء الصلاة فور سماع الأذان في 85% من المرات دون تذكير",
                summary: "السلوك يظهر لتجنب الصلاة والاستمرار في اللعب؛ الوظيفة: هروب من المطالب الدينية",
                antecedents: ["سماع الأذان", "انشغال باللعب", "عدم وجود روتين صلاة ثابت"],
                consequences: ["تذكير متكرر من الأهل", "انتباه إضافي عند التأخير", "تأجيل الصلاة"],
                function_analysis: "الوظيفة: هروب/تجنب من مطالب الصلاة",
                antecedent_strategies: ["إعداد بيئة صلاة هادئة قبل الأذان", "إنشاء روتين بصري للصلاة", "تذكير بصري قبل الأذان بـ5 دقائق"],
                replacement_behavior: { skill: "الذهاب للصلاة فور سماع الأذان", modality: "حركة مستقلة" },
                consequence_strategies: ["تعزيز فوري عند الصلاة في الوقت", "تجاهل التأخير وتذكير مرة واحدة فقط", "مكافأة خاصة للصلاة في الوقت"],
                data_collection: { metric: "نسبة الصلاة في الوقت", tool: "جدول يومي بسيط" },
                review_after_days: 14,
                safety_flag: false,
                suggestions: ["استخدام مؤقت بصري للصلاة", "ربط الصلاة بنشاط محبب"],
                customizations: ["تبسيط خطوات الوضوء", "استخدام سجادة صلاة ملونة"],
                parent_instructions: "تطبيق نفس الروتين في المنزل، مكافأة فورية عند الصلاة في الوقت"
            }, null, 2);
        }

        const noteContent = [
            `Child activity: ${currentActivity || 'غير محدد'}`,
            `Energy level: ${energyLevel || ''}`,
            `Tags: ${tags.join(', ') || 'لا يوجد'}`,
            `Session duration: ${sessionDuration} دقيقة`,
            `Note text: ${textNote || ''}`
        ].join('\n');

        // Use provided messagesForModel if client passed them, else build messages
        const messages = messagesForModel && Array.isArray(messagesForModel) && messagesForModel.length
            ? messagesForModel
            : [
                { role: 'system', content: systemPrompt + (relevant ? ("\n\nRelevant curriculum:\n" + relevant) : '') },
                { role: 'user', content: exampleUser },
                { role: 'assistant', content: exampleAssistant },
                {
                    role: 'user', content: effectiveAnalysisType === 'behavior'
                        ? `حللي الملاحظة التالية سلوكياً وارجعي JSON مطابق للـ schema أعلاه. تأكد من:\n1. عدم تكرار نص الملاحظة\n2. ملء جميع الحقول بمحتوى مفيد\n3. تقديم حلول عملية قابلة للتطبيق\n\n${noteContent}`
                        : `حللي الملاحظة التالية وارجعي JSON مطابق للـ schema أعلاه (لا تخرجي عن شكل JSON):\n\n${noteContent}`
                }
            ];

        console.log('--- messages preview ---');
        console.log(messages.map(m => ({ role: m.role, content: (m.content || '').slice(0, 800) })));

        // -----------------------
        // NEW: call n8n webhook instead of OpenAI directly
        // -----------------------
        const N8N_URL = process.env.N8N_WEBHOOK_URL;
        if (!N8N_URL) {
            return jsonResponse({ error: 'N8N_WEBHOOK_URL not configured' }, { status: 500, origin });
        }

        // Build payload for n8n - include messages so agent can use them
        const n8nPayload = {
            textNote,
            currentActivity,
            energyLevel,
            tags,
            sessionDuration,
            curriculumQuery,
            analysisType: effectiveAnalysisType,
            messagesForModel: messages
        };

        // Send to n8n webhook (with abort timeout)
        const controller = new AbortController();
        const timeoutMs = parseInt(process.env.N8N_TIMEOUT_MS || '60000', 10);
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        let n8nRawText = null;
        let n8nJson = null;
        try {
            const nres = await fetch(N8N_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(n8nPayload),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            const txt = await nres.text().catch(() => '');
            n8nRawText = txt;
            // try parse JSON
            try { n8nJson = JSON.parse(txt); } catch (e) { n8nJson = txt; }
        } catch (err) {
            clearTimeout(timeoutId);
            console.error('[analyze] n8n webhook call failed:', err.message || err);
            return jsonResponse({ error: 'Failed to call n8n webhook', detail: String(err.message || err) }, { status: 500, origin });
        }

        // n8n may return:
        // - { output: "...." }   OR
        // - [ { output: "..." } ]  OR
        // - raw string that is JSON
        // - already parsed object that is the desired JSON
        let parsed = null;
        let rawUsedForDebug = n8nJson;

        try {
            if (Array.isArray(n8nJson)) {
                // common pattern: [ { output: "..." } ]
                const first = n8nJson[0] || {};
                // try fields in order
                if (first.output) {
                    const candidate = first.output;
                    parsed = (typeof candidate === 'object') ? candidate : safeParseJSON(String(candidate)) || (() => {
                        try { return JSON.parse(String(candidate)); } catch (_) { return null; }
                    })();
                } else if (first.body && typeof first.body === 'string') {
                    parsed = safeParseJSON(first.body) || null;
                } else if (typeof first === 'object' && Object.keys(first).length && !first.output) {
                    // maybe the agent already returned parsed object inside first
                    parsed = first;
                } else {
                    // fallback: try parse whole array as string content
                    parsed = safeParseJSON(JSON.stringify(n8nJson)) || null;
                }
            } else if (typeof n8nJson === 'object') {
                // e.g. { output: "..." }  or already parsed object
                if (n8nJson.output && typeof n8nJson.output === 'string') {
                    parsed = safeParseJSON(n8nJson.output) || null;
                    if (!parsed) {
                        try { parsed = JSON.parse(n8nJson.output); } catch (_) { parsed = null; }
                    }
                } else {
                    // assume it's already the parsed AI JSON
                    parsed = n8nJson;
                }
            } else if (typeof n8nJson === 'string') {
                // raw string - try to extract JSON
                parsed = safeParseJSON(n8nJson) || null;
            } else {
                parsed = null;
            }
        } catch (err) {
            console.error('[analyze] parsing n8n response failed', err);
            parsed = null;
        }

        // If still not parsed, try a last-ditch regex on raw text
        if (!parsed) {
            const rawText = typeof n8nRawText === 'string' ? n8nRawText : (typeof n8nJson === 'string' ? n8nJson : JSON.stringify(n8nJson || ''));
            const attempt = safeParseJSON(rawText);
            if (attempt) parsed = attempt;
        }

        if (!parsed) {
            // return helpful debug info so you can paste execution output here
            console.error('[analyze] n8n returned non-parseable JSON. raw:', n8nRawText);
            return jsonResponse({
                error: 'n8n response not parseable as JSON',
                hint: 'n8n often returns { output: "...." } or an array. Paste raw execution output here for debugging.',
                raw: n8nRawText,
                usedCurriculum: !!relevant
            }, { status: 500, origin });
        }

        // At this point `parsed` should be an object representing the AI JSON
        // Choose correct normalizer based on requested analysisType
        let normalized;
        if (effectiveAnalysisType === 'behavior') {
            normalized = normalizeBehavior(parsed, String(parsed.summary || parsed.behavior_goal || parsed.smart_goal || '').slice(0, 400));
            normalized.suggestions = ensureSuggestionObjects(normalized.suggestions || parsed.suggestions || []);
            normalized.customizations = ensureSuggestionObjects(normalized.customizations || parsed.customizations || []);
        } else {
            normalized = normalizeAi(parsed, String(parsed.summary || parsed.smart_goal || '').slice(0, 400));
            normalized.suggestions = ensureSuggestionObjects(normalized.suggestions || parsed.suggestions || []);
            normalized.customizations = ensureSuggestionObjects(normalized.customizations || parsed.customizations || []);
        }

        // convenience top-level text arrays
        const suggestionsText = (Array.isArray(normalized.suggestions) ? normalized.suggestions.map(s => (typeof s === 'object' ? s.text || '' : String(s))) : []);
        const customizationsText = (Array.isArray(normalized.customizations) ? normalized.customizations.map(c => (typeof c === 'object' ? c.text || '' : String(c))) : []);

        // Confidence (best-effort)
        const confidences = (Array.isArray(normalized.suggestions) ? normalized.suggestions.map(s => typeof s.confidence === 'number' ? s.confidence : null).filter(c => c !== null) : []);
        const confidenceOverall = confidences.length ? (confidences.reduce((a, b) => a + b, 0) / confidences.length) : (normalized.meta && normalized.meta.model_provided_confidence ? normalized.meta.model_provided_confidence : null);

        const result = {
            ai: {
                raw: parsed,
                normalized: {
                    ...normalized,
                    meta: { ...(normalized.meta || {}), confidence_overall: confidenceOverall }
                },
                suggestions: suggestionsText,
                customizations: customizationsText
            },
            meta: { sentAt: new Date().toISOString(), usedCurriculum: !!relevant, analysisType: effectiveAnalysisType }
        };

        return jsonResponse(result, { status: 200, origin });
    } catch (err) {
        console.error('[analyze] fatal error:', err);
        return jsonResponse({ error: err.message }, { status: 500, origin: request.headers.get('origin') || '*' });
    }
}

// Health check — helpful for dev/debugging
export async function GET(request) {
    const origin = request.headers.get('origin') || '*';
    return jsonResponse({ ok: true, msg: 'analyze endpoint OK', runtime: 'nodejs', analysisHint: 'POST JSON to analyze' }, { status: 200, origin });
}
