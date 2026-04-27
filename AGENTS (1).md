# AGENTS.md — Greencoat Hub

Read this entire file before making any change. It encodes the intent, architecture, and constraints of this project. Deviating from these rules will break a live nursery compliance system used by staff across three sites.

---

## What this project is and why it matters

Greencoat Hub is the staff compliance portal for **Greencoat Nursery CIC** (reg. 10897930), a Birmingham-based early years childcare group operating across three sites: **Sparkhill, Billesley Ark, and Bearwood**. The portal is used by frontline nursery practitioners to:

- Read and acknowledge 118 statutory and internal policy documents  
- Complete AI-powered knowledge-check quizzes on those policies  
- Access an AI compliance assistant (Gemini) grounded in policy text  
- Build an evidence trail that satisfies **Ofsted inspection requirements**

The admin console (`admin.html`) is used by the Director (Taz Khan, Organisational DSL) to monitor staff compliance, manage the policy library, and generate evidence packs for Ofsted visits. Site DSLs are Zahra Rashid (Sparkhill), Sadiyah Begum (Bearwood), and Joanna Payne (Billesley Ark). The SENCo/Inclusion Lead is Sidra Begum.

**Regulatory context:** Greencoat is an Ofsted-registered EYFS provider in England. The September 2025 EYFS Statutory Framework and the November 2025 Ofsted five-point report-card framework are the current regulatory standards. Safeguarding is now reported as a separate "met / not met" judgment with Annex C requiring evidence of how staff *apply* training, not just that they attended it. EYFS staff-to-child ratios are **legally binding** — never quote them incorrectly in any code or prompt.

---

## Architecture — The Non-Negotiables

public/

  index.html      — Staff portal (\~3,300 lines, single-file PWA app)

  admin.html      — Admin console (dark-only, separate single-file app)

  \*.docx          — 118 policy documents (static, parsed client-side)

netlify/functions/

  ai.mjs          — Gemini AI proxy        → POST /api/ai

  admin-data.mjs  — Netlify Blobs R/W      → GET|POST /api/admin-data

  track.mjs       — Activity \+ ack logging → POST /api/track

netlify.toml      — publish=public, functions=netlify/functions

                    /api/\* → /.netlify/functions/:splat

### Rules that must never be broken

1. **No build step. No bundler. No package.json.** Files in `public/` deploy as-is. Do not introduce npm, Vite, webpack, Rollup, or any compile step.  
     
2. **Functions are ES modules (`.mjs`).** Use `import`/`export`. The only external import is `@netlify/blobs` — available in the Netlify runtime without installation. Do not add other npm dependencies.  
     
3. **No frontend framework.** The UI is plain HTML/CSS/JS. Do not introduce React, Vue, Svelte, Alpine, or any other framework.  
     
4. **index.html and admin.html are intentionally single-file apps.** Do not split into separate CSS or JS files unless explicitly instructed.  
     
5. **Never hardcode secrets.** All API keys and passwords live in Netlify environment variables. Reference them as `process.env.VARIABLE_NAME`.  
     
6. **Always use `/api/*` paths in frontend code**, never `/.netlify/functions/*` directly. The `netlify.toml` redirect handles translation.  
     
7. **Do not touch the Gemini model waterfall in `ai.mjs`** unless specifically asked. The model priority order is intentional.  
     
8. **Do not modify the God Prompt** in `ai.mjs` unless specifically asked. It encodes legally binding EYFS ratio rules and nursery-specific compliance logic that is non-trivial to restore if broken.

---

## Data Architecture — Critical

### localStorage is the source of truth for staff data

The staff portal intentionally uses `localStorage` as primary storage. Netlify Blobs is an **async backup/sync target only**. All Blob writes from the staff portal are fire-and-forget (`catch(() => {})`). Never change this — it preserves offline resilience for staff on poor connections.

### localStorage key conventions (never change these)

| Key | Purpose |
| :---- | :---- |
| `gc_theme` | `'light'` or `'dark'` |
| `gc_size` | `'small'` / `'normal'` / `'large'` / `'xlarge'` |
| `gc_staff_token` | Currently logged-in staff name |
| `gc_lastStaff` | Last staff name used (for auto-restore) |
| `gc_lastSite` | Last active site filter |
| `gc_acks_<staffKey>` | JSON array of acknowledged policy IDs |
| `gc_activity_<staffKey>` | JSON array of activity log entries |
| `gc_milestone_<staffKey>` | Last milestone acknowledgement count reached |

`<staffKey>` is always `staffName.replace(/\s+/g, '_')`. This convention is used identically in `track.mjs` and `admin-data.mjs`. **Never change this pattern** — it is the join key between localStorage and Netlify Blobs.

### Netlify Blobs stores

| Store | Key pattern | Contents | Consistency |
| :---- | :---- | :---- | :---- |
| `gc_portal_config` | `portal_data` | Live policy list \+ portal settings | strong |
| `gc_acks` | `<staffKey>` | `{ staffName, acks[], updatedAt }` | eventual |
| `gc_activity` | `<staffKey>` | `{ staffName, entries[], updatedAt }` (max 500\) | eventual |

Use **site-scoped** stores (`getStore`), not deploy-scoped, so data survives deploys. Use `consistency: 'strong'` when reading data that was just written (e.g. after adding a new staff member in the admin console).

---

## Verified Data Contracts — Read Before Touching Any Logging or History Code

These contracts were audited and fixed. Regenerating the bug below will corrupt chat history for every staff member on login.

### `trackActivity(type, key, value)` — correct call signatures

All three activity types and their exact expected arguments:

// ✅ CORRECT — policy read

trackActivity('read', policy.id, policy.title);

// ✅ CORRECT — quiz attempt

trackActivity('quiz', policy.id, score);           // score is a number e.g. 3

// ✅ CORRECT — AI chat message

trackActivity('aichat', text.slice(0, 200), replySnippet);

// text        \= the staff member's question, truncated to 200 chars

// replySnippet \= the AI's reply, plain text, truncated to 200 chars

// ❌ WRONG — the old bug, do not reintroduce

trackActivity('aichat', Date.now().toString(), JSON.stringify({policy,question,answer,date}));

// This stored a Unix timestamp as the "user" message and a JSON blob as the

// "AI" reply. loadChatHistory() then rendered the timestamp as the user's

// question and the raw JSON as the AI response on every login.

### What `loadChatHistory()` expects from localStorage

`gc_activity_<staffKey>` is an array of entry objects. For `type === 'aichat'`:

{

  type: 'aichat',

  key: 'Did we need to update the safeguarding pol…',  // question text, ≤200 chars

  value: 'Yes, the September 2025 EYFS framework…',   // plain reply snippet, ≤200 chars

  ts: 1714000000000                                    // Date.now() timestamp

}

`loadChatHistory()` renders `entry.key` as the user bubble and `entry.value` as the AI bubble. **Both must be plain readable strings, never JSON, never timestamps.**

### What `admin-data.mjs` overview expects from Blobs activity entries

Server-side activity entries (written by `track.mjs`) use the same shape:

{

  activityType: 'aichat',      // field name is activityType, not type

  key: '...',                  // question text ≤200 chars

  value: '...',                // reply snippet ≤200 chars

  policyId: 'sg',              // optional — present for read/quiz, blank for aichat

  policyTitle: 'Safeguarding…' // optional — server path supplies this correctly

}

`admin-data.mjs` filters AI chats with `e.type === 'aichat'` (note: Blobs entries use `type`, not `activityType` — `track.mjs` maps `activityType` → `type` on save). This is correct and verified. Do not change the field name mapping in `track.mjs`.

### `loadAiQuestions` localStorage fallback — policy name column

The `loadAiQuestions` function in `admin.html` has a localStorage fallback path. In that path, **leave the policy name column blank** — do not use `e.value` as the policy name. The value field now contains reply text, not policy names. The server path correctly supplies `policyTitle` from the Blobs entry.

// ✅ CORRECT

const policyName \= entry.policyTitle || '';   // server path only; blank for local

// ❌ WRONG — the old bug

const policyName \= entry.value;  // was a JSON blob before the fix, now reply text

### Environment variables

| Variable | Function | Purpose |
| :---- | :---- | :---- |
| `GEMINI_API_KEY` | `ai.mjs` | Google Gemini API |
| `ADMIN_PASSWORD` | `admin-data.mjs` | Admin console auth via `Authorization: Bearer` |

Add any new secrets here and to the Netlify dashboard before deploying.

---

## Policy Data Structure

Policies are defined as `DEFAULT_POLICIES` in `index.html` — a hardcoded array of 118 objects with this shape:

{

  id: 'sg',                          // Unique slug, used as localStorage key

  tier: 1,                           // 1 \= Essential, 2 \= Important, 3 \= Standard

  title: 'Safeguarding Children...',

  cat: 'Safeguarding',               // Category (used for nav grouping)

  sites: \['all'\],                    // or \['sparkhill'\], \['bearwood'\], \['billesley'\]

  file: 'Greencoat\_Safeguarding\_Policy\_Feb2026.docx',

  desc: 'Short description...',

  adopted: 'February 2026'

}

The admin console can override `DEFAULT_POLICIES` via the `gc_portal_config` Blob. If the loaded config has `policies.length >= DEFAULT_POLICIES.length`, the Blobs version wins. This is intentional — editing policies should always go through the admin console, never by directly editing `index.html`.

### Policy tiers

| Tier | Label | Colour | Purpose |
| :---- | :---- | :---- | :---- |
| 1 | Essential | Red (`--t1`) | Safeguarding, legal minimums — Ofsted priority |
| 2 | Important | Amber (`--t2`) | Operational policies |
| 3 | Standard | Green (`--t3`) | General / reference |

### Policy categories (current)

Safeguarding · Staffing · Child Development · Health & Safety · GDPR & Information · EYFS & Curriculum · Finance · Premises & Environment

---

## AI System — Key Details

### Gemini request body fields

| Field | Type | When used |
| :---- | :---- | :---- |
| `messages` | `Array<{role,content}>` | Always — full conversation history |
| `jsonMode` | `boolean` | `true` for quiz generation |
| `currentPolicy` | `string` | Title of currently open policy |
| `policyText` | `string` | Full extracted text of open policy |
| `policyCatalog` | `string` | All 118 policy summaries (when no doc is open) |

### Quiz generation

- Returns `{ questions: [{question, options[], correct, explanation}] }` (min 3\)  
- `correct` is coerced to integer — Gemini sometimes returns a string despite the schema  
- Minimum 3 valid questions required; falls back to hardcoded offline questions if the AI unavailable or returns \<3 valid questions  
- Offline fallback: Tier 1 policies have tailored 3-question sets; Tier 2/3 use category-based fallbacks. **Do not delete the fallback bank** — it is the reliability guarantee for staff in low-connectivity environments.

### EYFS ratios — legally binding, never alter

- Under 2 years: **1:3**  
- 2-year-olds: **1:5** (never 1:4)  
- 3+ years: **1:8** (or 1:13 if an Early Years Teacher / Level 6 is present)  
- Mixed ages: calculated proportionally — never apply the youngest ratio to all

---

## Design System

### `index.html` (Staff Portal)

Light and dark mode via `data-theme="light|dark"` on `<html>`. Text size via `data-size="small|normal|large|xlarge"` on `<html>`. Font: Inter (Google Fonts). Mammoth.js (v1.6.0 from cdnjs) parses `.docx` client-side.

**Always use CSS tokens. Never hardcode colours or sizes.**

| Token | Light value | Usage |
| :---- | :---- | :---- |
| `--gc-green` | `#1e6641` | Primary brand |
| `--gc-green-mid` | `#2d855a` | Hover/active |
| `--gc-yellow` | `#f0b429` | Accent/warning |
| `--t1` / `--t1-bg` / `--t1-border` | Red | Tier 1 / critical |
| `--t2` / `--t2-bg` / `--t2-border` | Amber | Tier 2 |
| `--t3` / `--t3-bg` / `--t3-border` | Green | Tier 3 / success |
| `--bg`, `--bg2`, `--bg3`, `--bg4` | Surface layers | Background hierarchy |
| `--text`, `--text2`, `--text3` | Text hierarchy | Primary / secondary / muted |
| `--border`, `--border2` | — | Subtle / standard borders |
| `--r-sm` `--r-md` `--r-lg` `--r-xl` `--r-full` | 8/12/16/20/999px | Border radii |
| `--shadow-xs` → `--shadow-lg` | — | Elevation |
| `--ease` | `cubic-bezier(.16,1,.3,1)` | Motion curve |
| `--duration` | `160ms` | Transition duration |

### `admin.html` (Admin Console)

**Always dark** — no light mode. Accent is **teal** (`#14b8a6` / `--teal`), not green. Same tier tokens (t1/t2/t3) with darker alpha values. Does not use mammoth.js.

---

## Routing

\[\[redirects\]\]

  from \= "/api/\*"

  to   \= "/.netlify/functions/:splat"

  status \= 200

| Frontend path | Function file |
| :---- | :---- |
| `/api/ai` | `netlify/functions/ai.mjs` |
| `/api/admin-data` | `netlify/functions/admin-data.mjs` |
| `/api/track` | `netlify/functions/track.mjs` |

---

## Known Issues to Fix (Prioritised)

1. **`admin.html` is broken** — cannot add staff, compliance overview non-functional. Needs a full rebuild. See the admin spec below.  
     
2. **No service worker / manifest** — `manifest.json` is referenced but does not exist. PWA install never fires. Offline does not work.  
     
3. **God Prompt needs Sept 2025 EYFS update** — Annex C, new safeguarding standards, professional-references-only rule, 2-hour absence follow-up. Do not change the EYFS ratios — those are already correct.  
     
4. **Policy reader is too narrow on mobile** — the document viewer needs a full-screen overlay mode on viewports below 768px, not a constrained panel.

---

## Admin Console Rebuild Spec

When rebuilding `admin.html`, implement these features in order of priority:

### Must have

- **Staff management** — add/edit/deactivate staff. Fields: name, email, role (Room Leader / Practitioner / Apprentice / DSL / Manager / Director), sites (multi-select: Sparkhill / Billesley Ark / Bearwood), start date  
- **Compliance grid** — one row per staff member, columns per policy category, cells colour-coded green/amber/red by acknowledgement status. Sortable. Filterable by site.  
- **Hero row** — overall compliance %, overdue count (red), items due in 14 days (amber). Always visible at top.  
- **Per-staff drill-down** — full profile, all policy ack dates, all quiz scores  
- **PFA Certificate Register** — staff name, certificate type, issue date, expiry date, traffic-light status (green \= \>6 months, amber \= \<6 months, red \= expired). Paediatric first aiders must be on premises at all times — this is Ofsted-critical.

### Should have

- **Expiry watch panel** — DBS, First Aid, Safeguarding refresher due within 60 days  
- **Activity feed** — last 10 events across all staff  
- **Policy manager** — add/edit policy metadata so policies can be managed without editing `index.html`  
- **"Send reminder" action** — marks a staff member as needing to read specific policies (shown as a banner when they next log in)

### Nice to have

- **One-click Ofsted evidence export** — CSV of staff compliance matrix \+ PFA register  
- **Site-level overview** — compliance score per site (Sparkhill / Billesley / Bearwood)

### Admin auth pattern

All admin actions require `Authorization: Bearer <ADMIN_PASSWORD>` header. The current implementation in `admin-data.mjs` is the reference — mirror it for any new endpoints. Return `{ error: 'Unauthorised' }` with status 401 on failure.

---

## Audited — Known-Good State (April 2026\)

A full cross-audit of frontend calls vs function expectations was completed. The following are **verified correct** — do not "fix" them:

| Area | Status | Notes |
| :---- | :---- | :---- |
| `ai.mjs` model waterfall | ✅ Correct | Gemini 3.1 → 2.5-flash → 2.5-pro, intentional |
| `ai.mjs` JSON schema enforcement | ✅ Correct | `correct` coerced to int, min 3 questions validated |
| `ai.mjs` CORS \+ timeout | ✅ Correct | 26s timeout, CORS headers present |
| `admin-data.mjs` auth guard | ✅ Correct | Bearer token on all write actions |
| `admin-data.mjs` overview aggregation | ✅ Correct | `e.type === 'aichat'` filter matches `track.mjs` output |
| `track.mjs` sync\_acks | ✅ Correct | Matches `index.html` call signature |
| `track.mjs` log\_activity | ✅ Correct | Matches `index.html` call signature post-fix |
| `track.mjs` get\_acks | ✅ Correct | Matches `index.html` call signature |
| `trackActivity('aichat', ...)` | ✅ Fixed | Was: timestamp+JSON. Now: question text \+ reply snippet |
| `loadAiQuestions` policy column | ✅ Fixed | Was: `e.value`. Now: blank for localStorage path |

**Do not modify any of the above without a documented reason. Any agent run that touches logging, history, or activity tracking must re-read the Verified Data Contracts section above before writing a single line.**

---

## What Agent Runs Should Never Do

- Add a build step, package manager, or bundler  
- Install npm packages or add a `package.json`  
- Introduce a frontend framework (React, Vue, etc.)  
- Split `index.html` or `admin.html` into multiple files  
- Change the `gc_acks_<staffKey>` localStorage key pattern  
- Change the Gemini model waterfall order  
- Modify the God Prompt EYFS ratio rules  
- Make Blobs the primary storage instead of localStorage for the staff portal  
- Add CORS headers to functions without confirming the cross-origin use case  
- Deploy directly to production — always use PR \+ Deploy Preview first

