---
name: project-bot-skeleton
description: Remembrly bot v2 skeleton — what was built, what tables it uses, and what comes next
metadata:
  type: project
---

Bot skeleton (index.js) was added to the bdaybot-site repo on 2026-08-13. It is the webhook server deployed to Railway.

**Tables used (Supabase):**
- `people` — one row per phone number; `is_user` bool distinguishes users from contacts
- `links` — tracks who reminds whom; FK to people on both sides
- `conversations_v2` — state machine; FK to people.id; uses `upsert` on `person_id`

**What's built:**
- GET /webhook — Meta challenge verification (WEBHOOK_VERIFY_TOKEN)
- POST /webhook — receives Cloud API events (entry→changes→value→messages)
- STOP interception — exact-match, case-insensitive, whole message; deletes people row (cascades links + conversations_v2), sends confirmation
- routeIncomingNumber(phone) — returns `{ case: 'new'|'known_contact'|'existing_user', person }`
- Flow submission detection — interactive / nfm_reply → parses response_json, logs fields; DatePicker comes as Unix ms timestamp (noted in TODO comment)
- getState / setState / clearState helpers — operate on conversations_v2 by person_id (UUID)

**What comes next (not yet built):**
- Onboarding flow for `new` route case
- Contact-conversion flow for `known_contact` route case
- Menu / active flow routing for `existing_user` route case
- Writing Flow submission data into DB (people + links)

**Why:** Original "Birthday Bot v1" used old schema (users/contacts/birthdays/conversations tables). New schema normalises identities into `people` and tracks events in `links`.
