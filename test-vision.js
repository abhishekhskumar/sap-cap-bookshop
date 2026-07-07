// test-vision.js — standalone probe: does the orchestration deployment accept images?
// Usage:  node test-vision.js "C:\\path\\to\\invoice.pdf"   (or a .png / .jpg)
// It converts page 1 of a PDF to a PNG (via pdftoppm if available), else uses the image as-is,
// then sends a multimodal message to the orchestration endpoint and prints the result.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const {
  AI_CORE_AUTH_URL: AUTH_URL,
  AI_CORE_CLIENT_ID: CLIENT_ID,
  AI_CORE_CLIENT_SECRET: CLIENT_SECRET,
  AI_CORE_DEPLOYMENT_URL: DEPLOYMENT_URL,
  AI_CORE_RESOURCE_GROUP: RESOURCE_GROUP = 'use-tax',
  AI_CORE_MODEL: MODEL = 'anthropic--claude-4.5-sonnet'
} = process.env;

async function getToken() {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET
  });
  const res = await fetch(AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error('Token failed: ' + res.status + ' ' + await res.text());
  return (await res.json()).access_token;
}

function toPngBase64(inputPath) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg') {
    return {
      media: ext === '.png' ? 'image/png' : 'image/jpeg',
      data: fs.readFileSync(inputPath).toString('base64')
    };
  }
  // PDF: try to convert page 1 to PNG using pdftoppm (poppler). If unavailable, error clearly.
  const outPrefix = path.join(path.dirname(inputPath), 'vision_test_page');
  try {
    execSync(`pdftoppm -png -r 150 -f 1 -l 1 "${inputPath}" "${outPrefix}"`, { stdio: 'ignore' });
  } catch (e) {
    throw new Error('Could not convert PDF to PNG. Install poppler (pdftoppm) OR pass a .png/.jpg directly.');
  }
  // pdftoppm outputs like vision_test_page-1.png
  const candidate = fs.readdirSync(path.dirname(inputPath))
    .filter(f => f.startsWith('vision_test_page') && f.endsWith('.png'))
    .map(f => path.join(path.dirname(inputPath), f))[0];
  if (!candidate) throw new Error('PNG not produced by pdftoppm.');
  return { media: 'image/png', data: fs.readFileSync(candidate).toString('base64') };
}

async function main() {
  const input = process.argv[2];
  if (!input) { console.error('Usage: node test-vision.js <path-to-pdf-or-image>'); process.exit(1); }

  console.log('1) Getting AI Core token...');
  const token = await getToken();
  console.log('   token OK (' + token.slice(0, 12) + '...)');

  console.log('2) Preparing image from', input);
  const img = toPngBase64(input);
  console.log('   image ready:', img.media, '(' + Math.round(img.data.length / 1024) + ' KB base64)');

  // SAP orchestration: the TEMPLATE only accepts text. Multimodal content goes in
  // messages_history as a real user message with a content array.
  const payload = {
    orchestration_config: {
      module_configurations: {
        templating_module_config: {
          template: [
            { role: 'user', content: '{{?instruction}}' }
          ]
        },
        llm_module_config: {
          model_name: MODEL,
          model_params: { max_tokens: 500 }
        }
      }
    },
    input_params: { instruction: 'Analyze the attached invoice image above.' },
    messages_history: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What invoice fields do you see in this image? List vendor name, ship-to address, and any amounts. If you can read the image, start your reply with "VISION-OK".' },
          { type: 'image_url', image_url: { url: `data:${img.media};base64,${img.data}` } }
        ]
      }
    ]
  };

  console.log('3) POST to orchestration endpoint...');
  const res = await fetch(DEPLOYMENT_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'AI-Resource-Group': RESOURCE_GROUP,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(payload)
  });

  const text = await res.text();
  console.log('4) HTTP', res.status);
  if (!res.ok) {
    console.log('--- ERROR BODY (tells us if images are rejected) ---');
    console.log(text.slice(0, 2000));
    console.log('----------------------------------------------------');
    console.log('If this says content/image not supported -> orchestration is text-only for this model.');
    return;
  }
  let json;
  try { json = JSON.parse(text); } catch { console.log('Raw:', text.slice(0, 2000)); return; }
  const content = json?.orchestration_result?.choices?.[0]?.message?.content;
  console.log('--- CLAUDE VISION REPLY ---');
  console.log(content || JSON.stringify(json).slice(0, 2000));
  console.log('---------------------------');
  if (content && content.includes('VISION-OK')) {
    console.log('\n✅ VISION WORKS on this orchestration deployment. Safe to integrate.');
  } else {
    console.log('\n⚠️ Got a reply but no VISION-OK marker — inspect the text above to judge if it actually read the image.');
  }
}

main().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
