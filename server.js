// Willis Advocacy Group — Lead Capture Webhook Server v1.3.0
// Receives leads from website form, validates, sends to GoHighLevel, retains TrustedForm certs, logs locally

require('dotenv').config();
const express = require('express');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// CORS — only allow requests from the production domain
app.use((req, res, next) => {
  const allowed = [
    'https://www.willisadvocacygroup.com',
    'https://willisadvocacygroup.com',
  ];
  const origin = req.headers.origin;
  if (allowed.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const CONFIG = {
  GHL_API_KEY:            process.env.GHL_API_KEY          || '',
  GHL_LOCATION_ID:        process.env.GHL_LOCATION_ID      || '',
  TRUSTEDFORM_API_KEY:    process.env.TRUSTEDFORM_API_KEY  || '',
  PORT:                   process.env.PORT                 || 3000,
  LOG_FILE:               path.join(__dirname, 'leads.log'),
  GHL_CONTACTS_URL:       'https://services.leadconnectorhq.com/contacts/',
  GHL_OPPORTUNITIES_URL:  'https://services.leadconnectorhq.com/opportunities/',
  PIPELINE_ID:            'H6KGWf7FSl49I4gXBVlw',
};

// Pipeline stage name mapping (for custom field / display)
const PIPELINE_STAGE = {
  medicare: 'Medicare Lead - New',
  life:     'Life Insurance Lead - New',
  both:     'Medicare + Life Lead - New',
  unsure:   'Unqualified - Needs Review',
};

// Pipeline stage ID mapping (for Opportunities API)
const PIPELINE_STAGE_ID = {
  medicare: 'e9970b45-5904-45ea-9678-e11344dca803',
  life:     '5f4a59fe-4349-498b-89d6-6974980b0e37',
  both:     'eaf07843-9821-46af-b7e3-b071443f7b1b',
  unsure:   '491d2c01-b187-4920-92e1-d74019668d5e',
};

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

  // Tags: always include source tags plus interest-specific tag
  const tags = ['website-lead', lead.state, lead.interest].filter(Boolean);

  // GHL v2 Contacts API payload
  const payload = {
    firstName:   lead.firstName,
    email:       lead.email,
    phone:       lead.phone,
    state:       lead.state,
    locationId:  CONFIG.GHL_LOCATION_ID,
    source:      'Website Lead Form',
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

  // Extract cert token from URL: https://cert.trustedform.com/<token>
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

  const stageId = PIPELINE_STAGE_ID[lead.interest] || PIPELINE_STAGE_ID.unsure;
  const stageName = PIPELINE_STAGE[lead.interest] || 'Unqualified - Needs Review';

  const payload = {
    pipelineId:      CONFIG.PIPELINE_ID,
    locationId:      CONFIG.GHL_LOCATION_ID,
    name:            `${lead.firstName} — ${stageName}`,
    pipelineStageId: stageId,
    status:          'open',
    contactId:       contactId,
    monetaryValue:   0,
    source:          'Website Lead Form',
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

// ── POST /api/lead — main lead intake endpoint ──
app.post('/api/lead', async (req, res) => {
  const lead = {
    firstName:          (req.body.firstName || '').trim(),
    email:              (req.body.email     || '').trim().toLowerCase(),
    phone:              (req.body.phone     || '').trim(),
    state:              req.body.state      || '',
    interest:           req.body.interest   || '',
    source:             req.body.source     || 'Website',
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

  // Log immediately — backup even if GHL is down
  logLead(lead, 'received');

  // Fire-and-forget to GHL — don't block the browser response
  sendToGHL(lead).then(result => {
    logLead({ id: lead.email + '_' + lead.timestamp, ghlResult: result }, 'ghl_submitted');
    // Create opportunity in pipeline if contact was created successfully
    if (result.success && result.contactId) {
      createGHLOpportunity(lead, result.contactId).then(oppResult => {
        logLead({ id: lead.email + '_' + lead.timestamp, oppResult }, 'opp_submitted');
      });
    }
  });

  // Retain TrustedForm cert independently (TCPA evidence)
  if (lead.trustedFormCertUrl) {
    retainTrustedFormCert(lead.trustedFormCertUrl).then(tfResult => {
      logLead({ id: lead.email + '_' + lead.timestamp, tfResult }, 'tf_retained');
    });
  }

  res.json({
    success: true,
    message: `Thank you ${lead.firstName}! Uhia will call you personally within 1 business hour. Zero cost, zero pressure — People Over Profits. | Willis Advocacy Group | (774) 446-0701`,
  });
});

// ── GET /api/health ──
app.get('/api/health', (req, res) => {
  res.json({
    status:        'ok',
    timestamp:     new Date().toISOString(),
    ghlConfigured: !!(CONFIG.GHL_API_KEY && CONFIG.GHL_LOCATION_ID),
    version:       '1.3.0',
  });
});

// ── GET /api/leads/recent — view last 50 logged leads ──
// IMPORTANT: Add authentication before exposing in production (e.g., check a secret header)
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
      .slice(-50);
    res.json({ count: leads.length, leads });
  } catch {
    res.json({ count: 0, leads: [] });
  }
});

app.listen(CONFIG.PORT, () => {
  console.log(`[server] Willis Advocacy Group lead server v1.3.0 on port ${CONFIG.PORT}`);
  console.log(`[server] GHL API: ${CONFIG.GHL_API_KEY ? 'CONFIGURED ✓' : '✗ NOT SET — add GHL_API_KEY to .env'}`);
  console.log(`[server] GHL Location: ${CONFIG.GHL_LOCATION_ID ? CONFIG.GHL_LOCATION_ID + ' ✓' : '✗ NOT SET'}`);
  console.log(`[server] TrustedForm: ${CONFIG.TRUSTEDFORM_API_KEY ? 'CONFIGURED ✓' : '✗ NOT SET — add TRUSTEDFORM_API_KEY to .env'}`);
});
