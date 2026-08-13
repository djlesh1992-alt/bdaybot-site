require('dotenv').config();
const Sentry = require('@sentry/node');
Sentry.init({
    dsn: "https://b168d35f920e387157e3ecf9d5c323cb@o4511188637515776.ingest.de.sentry.io/4511188658290768",
    tracesSampleRate: 1.0,
});
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;

// ─── Helpers ────────────────────────────────────────────────────────────────

function normaliseNumber(number) {
    let n = number.replace(/\s+/g, '').replace(/[^0-9+]/g, '');
    if (n.startsWith('+44')) n = '44' + n.slice(3);
    else if (n.startsWith('07')) n = '44' + n.slice(1);
    else if (n.startsWith('00')) n = n.slice(2);
    return n;
}

async function sendMessage(to, message, description = 'message') {
    try {
        await axios.post(
            `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`,
            {
                messaging_product: 'whatsapp',
                to: `+${to}`,
                type: 'text',
                text: { body: message }
            },
            { headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` } }
        );
    } catch (err) {
        console.error(`[sendMessage] Failed to send "${description}" to ${to}:`, err.response?.data ?? err.message);
        console.warn(`[sendMessage] Retrying "${description}" to ${to} in 2s...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
        try {
            await axios.post(
                `https://graph.facebook.com/v19.0/${META_PHONE_NUMBER_ID}/messages`,
                {
                    messaging_product: 'whatsapp',
                    to: `+${to}`,
                    type: 'text',
                    text: { body: message }
                },
                { headers: { Authorization: `Bearer ${META_ACCESS_TOKEN}` } }
            );
        } catch (retryErr) {
            console.error(`[sendMessage] Retry also failed for "${description}" to ${to}:`, retryErr.response?.data ?? retryErr.message);
        }
    }
}

// ─── Conversation state helpers ──────────────────────────────────────────────

async function getState(personId) {
    const { data, error } = await supabase
        .from('conversations_v2')
        .select('state, draft_data')
        .eq('person_id', personId)
        .single();
    if (error || !data) return null;
    return data;
}

async function setState(personId, state, draftData = null) {
    const { error } = await supabase
        .from('conversations_v2')
        .upsert(
            { person_id: personId, state, draft_data: draftData, updated_at: new Date().toISOString() },
            { onConflict: 'person_id' }
        );
    if (error) console.error('[setState] Failed for person_id:', personId, error);
}

async function clearState(personId) {
    const { error } = await supabase
        .from('conversations_v2')
        .delete()
        .eq('person_id', personId);
    if (error) console.error('[clearState] Failed for person_id:', personId, error);
}

// ─── Phone-number routing ────────────────────────────────────────────────────
// Returns: { case: 'new' | 'known_contact' | 'existing_user', person: row | null }

async function routeIncomingNumber(phone) {
    const { data: person, error } = await supabase
        .from('people')
        .select('*')
        .eq('phone_number', phone)
        .single();

    if (error || !person) {
        return { case: 'new', person: null };
    }
    if (person.is_user) {
        return { case: 'existing_user', person };
    }
    return { case: 'known_contact', person };
}

// ─── Webhook verification ────────────────────────────────────────────────────

app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === process.env.WEBHOOK_VERIFY_TOKEN) {
        res.status(200).send(challenge);
    } else {
        res.sendStatus(403);
    }
});

// ─── Webhook ─────────────────────────────────────────────────────────────────

app.post('/webhook', async (req, res) => {
    // Acknowledge immediately — Meta requires a fast 200
    res.sendStatus(200);

    try {
        const value = req.body?.entry?.[0]?.changes?.[0]?.value;
        const messages = value?.messages;
        if (!messages || messages.length === 0) return;

        for (const message of messages) {
            const rawFrom = message.from;
            const phone = normaliseNumber(rawFrom);

            // ── STOP interception — runs before everything else ───────────────
            const rawText = message.text?.body ?? '';
            if (rawText.trim().toUpperCase() === 'STOP') {
                const { data: person } = await supabase
                    .from('people')
                    .select('id')
                    .eq('phone_number', phone)
                    .single();

                if (person) {
                    // Delete person row; links and conversations_v2 cascade via FK
                    await supabase.from('people').delete().eq('id', person.id);
                    console.log(`[STOP] Deleted all data for ${phone}`);
                }

                await sendMessage(
                    phone,
                    `You've been unsubscribed and all your data has been deleted 👋\n\nIf you ever want to start again, just send us a message!`,
                    'STOP confirmation'
                );
                continue;
            }

            // ── Flow (WhatsApp Flow) submission ───────────────────────────────
            // Delivered as interactive / nfm_reply
            if (message.type === 'interactive' && message.interactive?.type === 'nfm_reply') {
                const rawJson = message.interactive.nfm_reply?.response_json;
                let flowData = null;
                try {
                    flowData = rawJson ? JSON.parse(rawJson) : null;
                } catch (parseErr) {
                    console.error('[Flow] Failed to parse nfm_reply JSON:', rawJson, parseErr);
                }

                console.log(`[Flow] Submission from ${phone}`);
                console.log('[Flow] Fields:', JSON.stringify(flowData, null, 2));
                // TODO: DatePicker fields arrive as Unix timestamps (ms).
                //       Convert to day/month/year integers before writing to DB:
                //       const d = new Date(Number(flowData.someTimestampField));
                //       event_day = d.getDate(), event_month = d.getMonth() + 1, event_year = d.getFullYear()
                continue;
            }

            // ── Phone-number routing ──────────────────────────────────────────
            const route = await routeIncomingNumber(phone);
            console.log(`[Route] ${phone} → ${route.case}`);

            if (route.case === 'new') {
                // TODO: trigger onboarding flow
                console.log(`[Route/new] No record for ${phone} — onboarding to be built`);
                continue;
            }

            if (route.case === 'known_contact') {
                // TODO: trigger contact-conversion flow
                console.log(`[Route/known_contact] ${phone} is a known contact (is_user=false) — conversion flow to be built`);
                continue;
            }

            if (route.case === 'existing_user') {
                // TODO: route to menu / active flows
                console.log(`[Route/existing_user] ${phone} is an existing user — menu/flow routing to be built`);
                continue;
            }
        }
    } catch (err) {
        console.error('[Webhook] Unhandled error:', err);
        Sentry.captureException(err);
    }
});

// ─── Start server ─────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Remembrly running on port ${PORT}`));
