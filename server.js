// Willis Advocacy Group — Lead Capture Webhook Server v1.4.1
// Receives leads from website form, validates, sends to GoHighLevel, retains TrustedForm certs, logs locally
// v1.4.0 adds: email alerts, ManyChat handler, Synthflow call-outcome handler, dashboard stats endpoint

require('dotenv').config();
const express    = require('express');
const fetch      = require('node-fetch');
const nodemailer = require('nodemailer');
const fs         = require('fs');
const path       = require('path');
const app        = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — production domain + local dashboard access
app.use((req, res, next) => {
  const allowed = [
    'https://www.willisadvocacygroup.com',
    'https://willisadvocacygroup.com',
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:8080',
  ];
  const origin = req.headers.origin;
  if (!origin || allowed.includes(origin) || origin === 'null') {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const CONFIG = {
  GHL_API_KEY:               process.env.GHL_API_KEY               || '',
  GHL_LOCATION_ID:           process.env.GHL_LOCATION_ID           || '',
  TRUSTEDFORM_API_KEY:       process.env.TRUSTEDFORM_API_KEY       || '',
  PORT:                      process.env.PORT                      || 3000,
  LOG_FILE:                  path.join(__dirname, 'leads.log'),
  GHL_CONTACTS_URL:          'https://services.leadconnectorhq.com/contacts/',
  GHL_OPPORTUNITIES_URL:     'https://services.leadconnectorhq.com/opportunities/',
  PIPELINE_ID:               'H6KGWf7FSl49I4gXBVlw',
  // Email alerts
  EMAIL_FROM:                process.env.EMAIL_FROM                || '',
  EMAIL_TO:                  process.env.EMAIL_TO                  || 'info@willisadvocacygroup.com',
  SMTP_HOST:                 process.env.SMTP_HOST                 || 'smtp.gmail.com',
  SMTP_PORT:                 parseInt(process.env.SMTP_PORT        || '587'),
  SMTP_USER:                 process.env.SMTP_USER                 || '',
  SMTP_PASS:                 process.env.SMTP_PASS                 || '',
  // Synthflow
  SYNTHFLOW_WEBHOOK_SECRET:  process.env.SYNTHFLOW_WEBHOOK_SECRET  || '',
  // ManyChat
  MANYCHAT_VERIFY_TOKEN:     process.env.MANYCHAT_VERIFY_TOKEN     || '',
};

const PIPELINE_STAGE = {
  medicare: 'Medicare Lead - New',
  life:     'Life Insurance Lead - New',
  both:     'Medicare + Life Lead - New',
  unsure:   'Unqualified - Needs Review',
};

const PIPELINE_STAGE_ID = {
  medicare: 'e9970b45-5904-45ea-9678-e11344dca803',
  life:     '5f4a59fe-4349-498b-89d6-6974980b0e37',
  both:     'eaf07843-9821-46af-b7e3-b071443f7b1b',
  unsure:   '491d2c01-b187-4920-92e1-d74019668d5e',
};

// ── Email alert transporter (lazy-init so missing creds don't crash startup) ──
let _transporter = null;
function getTransporter() {
  if (_transporter) return _transporter;
  if (!CONFIG.SMTP_USER || !CONFIG.SMTP_PASS) return null;
  _transporter = nodemailer.createTransport({
    host:   CONFIG.SMTP_HOST,
    port:   CONFIG.SMTP_PORT,
    secure: CONFIG.SMTP_PORT === 465,
    auth:   { user: CONFIG.SMTP_USER, pass: CONFIG.SMTP_PASS },
  });
  return _transporter;
}

async function sendEmailAlert(lead, source) {
  const transporter = getTransporter();
  if (!transporter || !CONFIG.EMAIL_TO) {
    console.warn('[email] SMTP not configured — skipping alert');
    return;
  }
  const subject = `🔔 New ${source} Lead — ${lead.firstName} (${lead.state}) [${lead.interest || 'unknown'}]`;
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:520px;">
      <div style="background:#0C1B2E;padding:16px 20px;border-radius:8px 8px 0 0;">
        <span style="color:#F0C060;font-size:18px;font-weight:bold;">Willis Advocacy Group</span>
        <span style="color:rgba(255,255,255,0.5);font-size:12px;margin-left:8px;">New Lead Alert</span>
      </div>
      <div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:6px 0;color:#666;width:140px;">Name</td><td style="padding:6px 0;font-weight:bold;">${lead.firstName}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Phone</td><td style="padding:6px 0;font-weight:bold;"><a href="tel:${lead.phone}">${lead.phone}</a></td></tr>
          <tr><td style="padding:6px 0;color:#666;">Email</td><td style="padding:6px 0;"><a href="mailto:${lead.email}">${lead.email}</a></td></tr>
          <tr><td style="padding:6px 0;color:#666;">State</td><td style="padding:6px 0;">${lead.state}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Interested In</td><td style="padding:6px 0;">${lead.interest || '—'}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Source</td><td style="padding:6px 0;">${source}</td></tr>
          <tr><td style="padding:6px 0;color:#666;">Time</td><td style="padding:6px 0;">${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</td></tr>
        </table>
        <div style="margin-top:16px;padding:12px;background:#f0fdf4;border-radius:6px;font-size:13px;color:#166534;">
          ✓ Lead logged &amp; sent to GoHighLevel. Call back within 1 business hour.
        </div>
      </div>
    </div>`;

  try {
    await transporter.sendMail({
      from:    CONFIG.EMAIL_FROM || CONFIG.SMTP_USER,
      to:      CONFIG.EMAIL_TO,
      subject,
      html,
    });
    console.log(`[email] Alert sent to ${CONFIG.EMAIL_TO}`);
  } catch (err) {
    console.error('[email] Send failed:', err.message);
  }
}

function validateLead(body) {
  const errors = [];
  if (!body.firstName || body.firstName.trim().length < 2)
    errors.push('firstName: minimum 2 characters required');
  if (!body.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email))
    errors.push('email: valid email address required');
  if (!body.phone || body.phone.replace(/\D/g, '').length < 7)
    errors.push('phone: valid phone number required');
  if (!body.state)
    errors.push('state: required');
  if (!body.interest)
    errors.push('interest: required');
  return errors;
}

function logLead(data, status) {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), status, ...data }) + '\n';
  fs.appendFile(CONFIG.LOG_FILE, entry, (err) => {
    if (err) console.error('[log] write error:', err.message);
  });
}

async function sendToGHL(lead) {
  if (!CONFIG.GHL_API_KEY || !CONFIG.GHL_LOCATION_ID) {
    console.warn('[ghl] GHL_API_KEY or GHL_LOCATION_ID not set — skipping');
    return { success: false, reason: 'GHL credentials not configured' };
  }

  const baseTags = ['website-lead', lead.state, lead.interest].filter(Boolean);
  // "both" leads need medicare + life tags so both nurture sequences fire
  const extraTags = lead.interest === 'both' ? ['medicare', 'life'] : [];
  const tags = [...new Set([...baseTags, ...extraTags])];

  const payload = {
    firstName:   lead.firstName,
    email:       lead.email,
    phone:       lead.phone,
    state:       lead.state,
    locationId:  CONFIG.GHL_LOCATION_ID,
    source:      lead.source || 'Website Lead Form',
    tags,
    customFields: [
      { key: 'interest',            field_value: lead.interest },
      { key: 'pipeline_stage',      field_value: PIPELINE_STAGE[lead.interest] || 'New Lead' },
      { key: 'trusted_form_cert',   field_value: lead.trustedFormCertUrl || '' },
      { key: 'lead_source_page',    field_value: lead.page || 'https://willisadvocacygroup.com' },
    ],
  };

  try {
    const res = await fetch(CONFIG.GHL_CONTACTS_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${CONFIG.GHL_API_KEY}`,
        'Version':       '2021-07-28',
      },
      body:    JSON.stringify(payload),
      timeout: 8000,
    });
    const respBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[ghl] HTTP ${res.status}:`, JSON.stringify(respBody).slice(0, 300));
    } else {
      console.log(`[ghl] Contact created — id: ${respBody.contact?.id || 'unknown'}`);
    }
    return { success: res.ok, status: res.status, contactId: respBody.contact?.id };
  } catch (err) {
    console.error('[ghl] fetch error:', err.message);
    return { success: false, reason: err.message };
  }
}

async function retainTrustedFormCert(certUrl) {
  if (!CONFIG.TRUSTEDFORM_API_KEY || !certUrl) {
    console.warn('[tf] TrustedForm API key or cert URL missing — skipping retain');
    return { success: false, reason: 'missing key or cert URL' };
  }

  const token = certUrl.split('/').pop().split('?')[0];
  if (!token) return { success: false, reason: 'could not parse cert token' };

  const auth = Buffer.from(':' + CONFIG.TRUSTEDFORM_API_KEY).toString('base64');

  try {
    const res = await fetch(`https://api.trustedform.com/truste_form.json`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Basic ${auth}`,
      },
      body:    JSON.stringify({ cert_url: certUrl }),
      timeout: 8000,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[tf] retain HTTP ${res.status}:`, JSON.stringify(body).slice(0, 200));
    } else {
      console.log(`[tf] Cert retained — token: ${token}`);
    }
    return { success: res.ok, status: res.status, token };
  } catch (err) {
    console.error('[tf] retain error:', err.message);
    return { success: false, reason: err.message };
  }
}

async function createGHLOpportunity(lead, contactId) {
  if (!CONFIG.GHL_API_KEY || !CONFIG.GHL_LOCATION_ID) {
    console.warn('[opp] GHL credentials not set — skipping opportunity');
    return { success: false, reason: 'GHL credentials not configured' };
  }

  const stageId   = PIPELINE_STAGE_ID[lead.interest] || PIPELINE_STAGE_ID.unsure;
  const stageName = PIPELINE_STAGE[lead.interest]    || 'Unqualified - Needs Review';

  const payload = {
    pipelineId:      CONFIG.PIPELINE_ID,
    locationId:      CONFIG.GHL_LOCATION_ID,
    name:            `${lead.firstName} — ${stageName}`,
    pipelineStageId: stageId,
    status:          'open',
    contactId:       contactId,
    monetaryValue:   0,
    source:          lead.source || 'Website Lead Form',
  };

  try {
    const res = await fetch(CONFIG.GHL_OPPORTUNITIES_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${CONFIG.GHL_API_KEY}`,
        'Version':       '2021-07-28',
      },
      body:    JSON.stringify(payload),
      timeout: 8000,
    });
    const respBody = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(`[opp] HTTP ${res.status}:`, JSON.stringify(respBody).slice(0, 300));
    } else {
      console.log(`[opp] Opportunity created — id: ${respBody.opportunity?.id || 'unknown'}, stage: ${stageName}`);
    }
    return { success: res.ok, status: res.status, opportunityId: respBody.opportunity?.id };
  } catch (err) {
    console.error('[opp] fetch error:', err.message);
    return { success: false, reason: err.message };
  }
}

// ── Helper: run full lead intake pipeline ──
async function processLead(lead, source) {
  logLead(lead, 'received');

  sendToGHL(lead).then(result => {
    logLead({ id: lead.email + '_' + lead.timestamp, ghlResult: result }, 'ghl_submitted');
    if (result.success && result.contactId) {
      createGHLOpportunity(lead, result.contactId).then(oppResult => {
        logLead({ id: lead.email + '_' + lead.timestamp, oppResult }, 'opp_submitted');
      });
    }
  });

  if (lead.trustedFormCertUrl) {
    retainTrustedFormCert(lead.trustedFormCertUrl).then(tfResult => {
      logLead({ id: lead.email + '_' + lead.timestamp, tfResult }, 'tf_retained');
    });
  }

  sendEmailAlert(lead, source);
}

// ── POST /api/lead — website form ──
app.post('/api/lead', async (req, res) => {
  const lead = {
    firstName:          (req.body.firstName || '').trim(),
    email:              (req.body.email     || '').trim().toLowerCase(),
    phone:              (req.body.phone     || '').trim(),
    state:              req.body.state      || '',
    interest:           req.body.interest   || '',
    source:             req.body.source     || 'Website Lead Form',
    page:               req.body.page       || '',
    timestamp:          new Date().toISOString(),
    trustedFormCertUrl: req.body.xxTrustedFormCertUrl || '',
    ip:                 req.ip,
    userAgent:          req.get('User-Agent') || '',
  };

  const errors = validateLead(lead);
  if (errors.length > 0) {
    return res.status(400).json({ success: false, errors });
  }

  await processLead(lead, 'Website Form');

  res.json({
    success: true,
    message: `Thank you ${lead.firstName}! Uhia will call you personally within 1 business hour. Zero cost, zero pressure — People Over Profits. | Willis Advocacy Group | (774) 446-0701`,
  });
});

// ── POST /api/manychat-lead — ManyChat chat widget leads ──
// Configure in ManyChat: Actions → External Request → POST https://api.willisadvocacygroup.com/api/manychat-lead
// Send fields: first_name, phone, email, state, interest (map from your bot flow variables)
app.post('/api/manychat-lead', async (req, res) => {
  // ManyChat sends subscriber data — normalize to internal format
  const body = req.body;

  const firstName = (body.first_name || body.firstName || body.name || '').trim().split(' ')[0];
  const phone     = (body.phone || body.phone_number || '').trim();
  const email     = (body.email || body.email_address || '').trim().toLowerCase();
  const state     = (body.state || body.subscriber_state || 'MA').trim().toUpperCase();
  const interest  = (body.interest || body.insurance_type || 'unsure').trim().toLowerCase();

  if (!firstName || (!phone && !email)) {
    return res.status(400).json({ success: false, error: 'first_name and phone or email required' });
  }

  const lead = {
    firstName,
    email:              email || 'no-email@manychat.lead',
    phone:              phone || 'no-phone',
    state,
    interest:           PIPELINE_STAGE[interest] ? interest : 'unsure',
    source:             'ManyChat',
    page:               'https://willisadvocacygroup.com',
    timestamp:          new Date().toISOString(),
    trustedFormCertUrl: '',
    ip:                 req.ip,
    userAgent:          'ManyChat',
    messengerUserId:    body.messenger_user_id || body.id || '',
  };

  await processLead(lead, 'ManyChat');

  // ManyChat expects a 200 with JSON — can pass dynamic content back into the bot
  res.json({
    success:  true,
    messages: [{
      type: 'text',
      text: `Thanks ${firstName}! Uhia Willis will call you within 1 business hour at ${phone || email}. People Over Profits. — (774) 446-0701`,
    }],
  });
  console.log(`[manychat] Lead received — ${firstName} | ${phone} | ${state} | ${interest}`);
});

// ── POST /api/synthflow — Synthflow AI call outcome webhook ──
// Configure in Synthflow: Settings → Webhooks → Add Endpoint → POST https://api.willisadvocacygroup.com/api/synthflow
app.post('/api/synthflow', async (req, res) => {
  const body = req.body;

  // Verify webhook secret if configured
  if (CONFIG.SYNTHFLOW_WEBHOOK_SECRET) {
    const sig = req.headers['x-synthflow-signature'] || req.headers['x-webhook-secret'] || '';
    if (sig !== CONFIG.SYNTHFLOW_WEBHOOK_SECRET) {
      console.warn('[synthflow] Invalid webhook signature');
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const callId      = body.call_id      || body.id         || 'unknown';
  const callStatus  = body.call_status  || body.status     || 'unknown';
  const contactPhone = (body.contact_phone || body.phone_number || body.contact?.phone_number || '').replace(/\D/g, '');
  const contactName  = body.contact_name  || body.contact?.name || 'Unknown';
  const duration     = body.call_duration_seconds || body.duration || 0;
  const summary      = body.summary      || body.call_summary || '';
  const outcome      = body.outcome      || body.disposition  || 'unknown';

  console.log(`[synthflow] Call ${callId} — status: ${callStatus}, outcome: ${outcome}, phone: ${contactPhone}, duration: ${duration}s`);

  logLead({
    callId, callStatus, contactPhone, contactName,
    duration, summary, outcome,
  }, 'synthflow_call');

  // If call completed and we have a phone, update the GHL contact note
  if (callStatus === 'completed' && contactPhone && CONFIG.GHL_API_KEY && CONFIG.GHL_LOCATION_ID) {
    // Search for contact by phone
    try {
      const searchRes = await fetch(
        `https://services.leadconnectorhq.com/contacts/?locationId=${CONFIG.GHL_LOCATION_ID}&phone=${encodeURIComponent('+1' + contactPhone)}`,
        {
          headers: {
            'Authorization': `Bearer ${CONFIG.GHL_API_KEY}`,
            'Version':       '2021-07-28',
          },
          timeout: 8000,
        }
      );
      const searchData = await searchRes.json().catch(() => ({}));
      const contact    = searchData.contacts?.[0];

      if (contact?.id) {
        // Add note to contact with call summary
        const notePayload = {
          body: `[Synthflow AI Call — ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET]\nOutcome: ${outcome}\nDuration: ${Math.round(duration / 60)}m ${duration % 60}s\n\n${summary}`,
        };
        await fetch(`https://services.leadconnectorhq.com/contacts/${contact.id}/notes`, {
          method: 'POST',
          headers: {
            'Content-Type':  'application/json',
            'Authorization': `Bearer ${CONFIG.GHL_API_KEY}`,
            'Version':       '2021-07-28',
          },
          body:    JSON.stringify(notePayload),
          timeout: 8000,
        });
        console.log(`[synthflow] Note added to GHL contact ${contact.id}`);

        // If call resulted in a qualified lead, advance pipeline stage
        if (['qualified', 'interested', 'callback_requested'].includes(outcome.toLowerCase())) {
          await fetch(`https://services.leadconnectorhq.com/contacts/${contact.id}`, {
            method: 'PUT',
            headers: {
              'Content-Type':  'application/json',
              'Authorization': `Bearer ${CONFIG.GHL_API_KEY}`,
              'Version':       '2021-07-28',
            },
            body: JSON.stringify({ tags: ['synthflow-qualified', 'callback-needed'] }),
            timeout: 8000,
          });
        }
      }
    } catch (err) {
      console.error('[synthflow] GHL update error:', err.message);
    }
  }

  res.json({ success: true, callId });
});

// ── POST /api/soa — CMS Scope of Appointment submission ──
// Receives signed SOA from soa.html, logs to soa.log, emails Uhia, notes GHL contact
app.post('/api/soa', async (req, res) => {
  const body = req.body;
  const timestamp = body.timestamp || new Date().toISOString();

  // Save signature image to soa-signatures/ folder (separate from log to keep log readable)
  const sigData = body.signature_data || '';
  let sigFile = '';
  if (sigData && sigData.startsWith('data:image/png;base64,')) {
    const sigDir = path.join(__dirname, 'soa-signatures');
    if (!fs.existsSync(sigDir)) fs.mkdirSync(sigDir);
    const fname = `soa-${body.phone?.replace(/\D/g, '') || 'unknown'}-${Date.now()}.png`;
    sigFile = path.join(sigDir, fname);
    fs.writeFileSync(sigFile, sigData.replace(/^data:image\/png;base64,/, ''), 'base64');
    console.log(`[soa] Signature saved: ${fname}`);
  }

  // Log SOA record (without raw base64 signature)
  const record = {
    timestamp,
    type:         'scope_of_appointment',
    firstName:    body.first_name  || '',
    lastName:     body.last_name   || '',
    phone:        body.phone       || '',
    email:        body.email       || '',
    dob:          body.dob         || '',
    apptDate:     body.appt_date   || '',
    apptMethod:   body.appt_method || 'phone',
    topics:       body.topics      || [],
    agent:        body.agent       || 'Uhia Willis — Willis Advocacy Group',
    cmsCompliant: body.cms_compliant !== false,
    signatureSaved: !!sigFile,
    ip:           req.ip,
    userAgent:    req.get('User-Agent') || '',
  };

  const soaLog = path.join(__dirname, 'soa.log');
  fs.appendFile(soaLog, JSON.stringify(record) + '\n', err => {
    if (err) console.error('[soa] log error:', err.message);
  });
  console.log(`[soa] SOA received — ${record.firstName} ${record.lastName} | ${record.phone} | ${record.apptDate} | ${record.topics.join(', ')}`);

  // Email alert to Uhia
  const transporter = getTransporter();
  if (transporter && CONFIG.EMAIL_TO) {
    const subject = `📋 New SOA Signed — ${record.firstName} ${record.lastName} | Appt: ${record.apptDate}`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:540px;">
        <div style="background:#0C1B2E;padding:16px 20px;border-radius:8px 8px 0 0;">
          <span style="color:#F0C060;font-size:18px;font-weight:bold;">Willis Advocacy Group</span>
          <span style="color:rgba(255,255,255,0.5);font-size:12px;margin-left:8px;">Scope of Appointment</span>
        </div>
        <div style="border:1px solid #ddd;border-top:none;padding:20px;border-radius:0 0 8px 8px;">
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="padding:5px 0;color:#666;width:160px;">Name</td><td style="font-weight:bold;">${record.firstName} ${record.lastName}</td></tr>
            <tr><td style="padding:5px 0;color:#666;">Phone</td><td><a href="tel:${record.phone}">${record.phone}</a></td></tr>
            <tr><td style="padding:5px 0;color:#666;">Email</td><td>${record.email || '—'}</td></tr>
            <tr><td style="padding:5px 0;color:#666;">Date of Birth</td><td>${record.dob}</td></tr>
            <tr><td style="padding:5px 0;color:#666;">Appointment Date</td><td><strong>${record.apptDate}</strong></td></tr>
            <tr><td style="padding:5px 0;color:#666;">Method</td><td>${record.apptMethod}</td></tr>
            <tr><td style="padding:5px 0;color:#666;">Topics Approved</td><td>${record.topics.join('<br>')}</td></tr>
            <tr><td style="padding:5px 0;color:#666;">Signed</td><td>${new Date(timestamp).toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</td></tr>
            <tr><td style="padding:5px 0;color:#666;">Signature</td><td>${record.signatureSaved ? '✓ Saved on server' : 'Not captured'}</td></tr>
          </table>
          <div style="margin-top:16px;padding:12px;background:#fff8e6;border-radius:6px;font-size:12px;color:#5a4010;border:1px solid #f0c060;">
            ⚖️ CMS-Compliant SOA on file. Keep this record for 10 years per CMS guidelines.
          </div>
        </div>
      </div>`;
    transporter.sendMail({
      from:    CONFIG.EMAIL_FROM || CONFIG.SMTP_USER,
      to:      CONFIG.EMAIL_TO,
      subject,
      html,
    }).catch(err => console.error('[soa] email error:', err.message));
  }

  // Try to add SOA note to matching GHL contact by phone
  if (record.phone && CONFIG.GHL_API_KEY && CONFIG.GHL_LOCATION_ID) {
    const cleanPhone = record.phone.replace(/\D/g, '');
    fetch(
      `https://services.leadconnectorhq.com/contacts/?locationId=${CONFIG.GHL_LOCATION_ID}&phone=${encodeURIComponent('+1' + cleanPhone)}`,
      { headers: { 'Authorization': `Bearer ${CONFIG.GHL_API_KEY}`, 'Version': '2021-07-28' }, timeout: 8000 }
    ).then(r => r.json()).then(data => {
      const contact = data.contacts?.[0];
      if (contact?.id) {
        const note = `[SOA Signed — ${new Date(timestamp).toLocaleDateString('en-US')}]\nTopics: ${record.topics.join(', ')}\nAppointment: ${record.apptDate} via ${record.apptMethod}\nCMS-compliant SOA on file.`;
        fetch(`https://services.leadconnectorhq.com/contacts/${contact.id}/notes`, {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${CONFIG.GHL_API_KEY}`, 'Version': '2021-07-28' },
          body:    JSON.stringify({ body: note }),
          timeout: 8000,
        }).then(() => console.log(`[soa] GHL note added to contact ${contact.id}`))
          .catch(err => console.error('[soa] GHL note error:', err.message));
      }
    }).catch(err => console.error('[soa] GHL lookup error:', err.message));
  }

  res.json({ success: true, message: 'Scope of Appointment recorded. Thank you.' });
});

// ── GET /api/health ──
app.get('/api/health', (req, res) => {
  res.json({
    status:           'ok',
    timestamp:        new Date().toISOString(),
    ghlConfigured:    !!(CONFIG.GHL_API_KEY && CONFIG.GHL_LOCATION_ID),
    emailConfigured:  !!(CONFIG.SMTP_USER && CONFIG.SMTP_PASS),
    version:          '1.4.1',
  });
});

// ── GET /api/stats — public aggregate stats for dashboard (no PII) ──
app.get('/api/stats', (req, res) => {
  try {
    const raw    = fs.readFileSync(CONFIG.LOG_FILE, 'utf8');
    const lines  = raw.trim().split('\n').map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const leads  = lines.filter(l => l.status === 'received');

    const now    = new Date();
    const today  = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const week   = new Date(today); week.setDate(week.getDate() - 7);

    const leadsToday  = leads.filter(l => new Date(l.timestamp) >= today).length;
    const leadsWeek   = leads.filter(l => new Date(l.timestamp) >= week).length;
    const leadsTotal  = leads.length;
    const byInterest  = leads.reduce((acc, l) => { acc[l.interest || 'unsure'] = (acc[l.interest || 'unsure'] || 0) + 1; return acc; }, {});
    const byState     = leads.reduce((acc, l) => { if (l.state) acc[l.state] = (acc[l.state] || 0) + 1; return acc; }, {});

    const lastLead    = leads.length > 0 ? leads[leads.length - 1] : null;

    res.json({
      leadsToday,
      leadsWeek,
      leadsTotal,
      byInterest,
      byState,
      lastLeadAt: lastLead?.timestamp || null,
    });
  } catch {
    res.json({ leadsToday: 0, leadsWeek: 0, leadsTotal: 0, byInterest: {}, byState: {}, lastLeadAt: null });
  }
});

// ── GET /api/leads/recent — protected, returns last 50 log entries ──
app.get('/api/leads/recent', (req, res) => {
  const secret = req.headers['x-admin-key'];
  if (!secret || secret !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const raw   = fs.readFileSync(CONFIG.LOG_FILE, 'utf8');
    const leads = raw.trim().split('\n')
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .filter(l => l.status === 'received')
      .slice(-50)
      .reverse();
    res.json({ count: leads.length, leads });
  } catch {
    res.json({ count: 0, leads: [] });
  }
});

app.listen(CONFIG.PORT, () => {
  console.log(`[server] Willis Advocacy Group lead server v1.4.1 on port ${CONFIG.PORT}`);
  console.log(`[server] GHL API:       ${CONFIG.GHL_API_KEY       ? 'CONFIGURED ✓' : '✗ NOT SET'}`);
  console.log(`[server] GHL Location:  ${CONFIG.GHL_LOCATION_ID   ? CONFIG.GHL_LOCATION_ID + ' ✓' : '✗ NOT SET'}`);
  console.log(`[server] TrustedForm:   ${CONFIG.TRUSTEDFORM_API_KEY ? 'CONFIGURED ✓' : '✗ NOT SET'}`);
  console.log(`[server] Email alerts:  ${CONFIG.SMTP_USER && CONFIG.SMTP_PASS ? CONFIG.EMAIL_TO + ' ✓' : '✗ NOT SET — add SMTP_USER + SMTP_PASS to .env'}`);
  console.log(`[server] Synthflow:     ${CONFIG.SYNTHFLOW_WEBHOOK_SECRET ? 'Secret set ✓' : 'No secret (open)'}`);
});
