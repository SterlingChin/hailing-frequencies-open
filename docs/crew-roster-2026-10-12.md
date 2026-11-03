# Crew roster: what the CRM knows about a caller

Drafted October 12, 2026 from Sterling's list: identity, authorization code, when they talked to us, name, rank, starship, area of the ship. Implemented in migration `003_crew_roster.sql`, exposed through the safe profile, and seeded by `npm run db:seed:roster`. Everything is fictional.

## Schema: one crew member

| Field | Type | Example | Notes |
| --- | --- | --- | --- |
| `display_name` | text | Tavi Rourke | Spoken back to the caller. |
| `rank` | text | Lieutenant | Free text; spoken back. |
| `ship` | text | USS Wayfinder | Current posting's ship. |
| `department` | enum | sciences | One of command, operations, engineering, sciences, security, medical. |
| `section` | text | Astrophysics | The area inside the department. Free text so the fiction can grow. |
| `clearance_level` | 1 to 10 | 5 | What the access desk checks against. Captain is 10, ensign is 2. |
| `posting` | text | Deck 11, Astrophysics Lab 2 | Where they work. Doubles as the default equipment location. |
| `service_number` | text | SF-S-4471 | Unique, pattern `SF-<letter>-<4 digits>`. Safe to read aloud; not a secret. |
| `status` | enum | active | active, on_leave or transferred. The bundle mentions it only when not active. |
| `language` | text | English | Already existed. |
| `auth_code_hash` | sha256 | | The authorization phrase, hashed. The plaintext never reaches the database, the model or a log. |
| `is_demo` | boolean | true | Seeds only touch rows marked demo. |

Related records that already existed and still carry the rest of the picture: `contact_points` (phone numbers, returned to the model as IDs only), `channel_preferences` (voice, sms or screen per topic), `equipment` (what they own and where), `cases`, `interactions`.

## "When they talked to us" is derived, not stored

Every call or text is an `interactions` row. The safe profile now computes from finished interactions:

- `contact_count`: how many finished contacts.
- `last_contact`: when, by which channel, inbound or outbound, and which case. Null on first contact.

The context bundle turns that into one line, for example "Last contact: 3 days ago by voice about HF-031; 1 prior contact(s)." The current call is excluded because it has not ended.

## Authorization phrases

Phrases normalise before hashing: separators are dropped, digit words become digits, and "alpha" and "beta" become A and B. Nothing else is mapped, so a phrase uses only letters from the name plus digits, A and B. Michael Watson's demo phrase is **"Watson, Michael, five nine alpha"**. Three wrong attempts per interaction lock the profile for that call.

## The roster (all fictional)

| Name | Rank | Ship | Department / section | Clearance | Posting | Phrase | History |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Tavi Rourke | Lieutenant | USS Wayfinder | sciences / Astrophysics | 5 | Deck 11, Astrophysics Lab 2 | ROURKE-TAVI-27A4B1 | Called 3 days ago; HF-031 open, access desk pending |
| Michael Watson | Ensign | USS Wayfinder | sciences / Exobiology | 2 | Deck 11, Exobiology Lab | Watson, Michael, five nine alpha | First contact |
| Imani Okafor | Lieutenant Commander | USS Wayfinder | engineering / Warp propulsion | 8 | Deck 16, Main Engineering | OKAFOR-IMANI-7B21A | Called 3 weeks ago; HF-021 closed |
| Bram Halloran | Chief Petty Officer | USS Wayfinder | operations / Transporter maintenance | 4 | Deck 6, Transporter Room 2 | HALLORAN-BRAM-3A80B | Texted 10 days ago; HF-027 resolved |
| Sorrel Vance | Lieutenant | USS Wayfinder | security / Tactical | 6 | Deck 4, Armory | VANCE-SORREL-91B3A | First contact |
| Nadia Petrov | Commander | USS Wayfinder | medical / Sickbay | 7 | Deck 5, Sickbay | PETROV-NADIA-5A06B | Called 6 days ago; HF-033 open, maintenance pending |
| Elowen Marsh | Captain | USS Wayfinder | command / Bridge | 10 | Deck 1, Bridge | MARSH-ELOWEN-0A77B | First contact |
| Kai Delacroix | Ensign | USS Caldera | operations / Helm | 2 | Deck 1, Helm | DELACROIX-KAI-2B19A | Called 30 days ago, no case; transferred |
| Bethany Ann | Ensign | USS Nebraska | operations | 2 | USS Nebraska | Ann, Bethany, seven two alpha | Demo identity loads; Decisions rejects the nonexistent USS Nebraska with `404 crew_member_not_found` |

Avery Chen, the original demo profile, is now a Commander in engineering / Environmental systems, clearance 7, service number SF-E-1180. The scenario seed still owns that record.

Phones are reserved fictional numbers in the 555-01xx range. The roster seed is idempotent: it removes and reinserts each roster member's own records and nothing else.

## Seeding

Locally, with `DATABASE_URL` in `.env` pointing at a loopback Postgres:

```bash
node --env-file=.env crm/roster.mjs
```

Nothing reads `.env` on its own, so `npm run db:seed:roster` only works when `DATABASE_URL` is already in the shell environment.

For Railway, the roster seed accepts an explicit opt-in. It refuses any non-loopback host unless you type that exact hostname, and it only ever removes and reinserts rows marked `is_demo`. Migrations 002 and 003 must already be applied there, which the app's pre-deploy command does on the next deploy of `main`.

```bash
node crm/roster.mjs --remote-host <public hostname of the Postgres service>
```

With no `DATABASE_URL` in the environment, the script asks for the URL at a hidden prompt in the terminal, so the password stays out of shell history. Paste it once and press Enter. Turn the Postgres service's public networking off again afterwards; the app reaches it over the private network.

The scenario seed (`crm/seed.mjs`, Avery Chen's returning-caller history) stays loopback-only.

## Still to decide

- Whether `clearance_level` alone drives the access desk, or whether resources carry their own required level. Today nothing reads it except the context bundle.
- Whether `section` should become an enum once the fiction settles.
- Whether a transferred crew member can still open cases on their old ship. Nothing prevents it today.
