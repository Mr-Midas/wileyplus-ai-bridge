import os
import re
import json
import requests
from flask import Flask, request, jsonify
from flask_cors import CORS
from dotenv import load_dotenv
import google.generativeai as genai

load_dotenv()

GEMINI_KEY = os.getenv("GEMINI_API_KEY")
GROQ_KEY = os.getenv("GROQ_API_KEY")
OLLAMA_ENDPOINT = "http://127.0.0.1:11434/api/generate"
GROQ_ENDPOINT = "https://api.groq.com/openai/v1/chat/completions"

if GEMINI_KEY:
    genai.configure(api_key=GEMINI_KEY)

app = Flask(__name__)
CORS(app)

def clean_answers(answers, fields):
    cleaned = []
    for i, a in enumerate(answers):
        val = str(a.get('value', '')).strip()
        sign = str(a.get('sign', '')).strip()
        unit = str(a.get('unit', '')).strip()
        correct = a.get('correct', None)
        
        field_meta = fields[i] if i < len(fields) else {}

        val = re.sub(r'[^0-9.\-]', '', val.split()[0] if ' ' in val else val)
        
        if 'to' in str(a.get('value', '')).lower() and not val.startswith('-'):
            parts = re.findall(r'[\d.]+', str(a.get('value', '')))
            if len(parts) >= 2:
                val = str((float(parts[0]) + float(parts[1])) / 2)

        if field_meta.get('hasSign'):
            if val.startswith('-'):
                sign = '-'
                val = val[1:]
            elif val.startswith('+'):
                sign = '+'
                val = val[1:]
            
            allowed_signs = field_meta.get('signOptions', [])
            if sign and allowed_signs:
                matched_sign = next((s for s in allowed_signs if s == sign or (sign == '-' and 'negative' in s.lower())), None)
                sign = matched_sign if matched_sign else allowed_signs[0]
        else:
            sign = ""

        allowed_units = field_meta.get('unitOptions', [])
        if allowed_units:
            matched_unit = next((u for u in allowed_units if u.lower() == unit.lower()), None)
            unit = matched_unit if matched_unit else allowed_units[0] 
        else:
            unit = ""

        entry = {"value": val}
        if sign: entry["sign"] = sign
        if unit: entry["unit"] = unit
        if correct is not None: entry['correct'] = correct
        
        cleaned.append(entry)

    cleaned = [a for a in cleaned if a['value'] and a['value'].replace('.','').replace('-','').replace('e','').isdigit()]
    return cleaned

def call_gemini(prompt, model_name='gemini-2.0-flash'):
    print(f"[*] Gemini ({model_name})...")
    try:
        model = genai.GenerativeModel(model_name)
        response = model.generate_content(prompt, generation_config={"response_mime_type": "application/json"})
        return json.loads(response.text)
    except Exception as e:
        print(f"[-] Gemini {model_name} failed: {e}")
        return None

def call_groq(prompt):
    if not GROQ_KEY: return None
    models_to_try = ['llama-3.3-70b-versatile', 'llama3-70b-8192']
    for model_name in models_to_try:
        print(f"[*] Groq ({model_name})...")
        try:
            resp = requests.post(GROQ_ENDPOINT, json={
                "model": model_name,
                "messages": [{"role": "user", "content": prompt + "\n\nReturn ONLY valid JSON."}],
                "temperature": 0.1
            }, headers={"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"}, timeout=60)
            if resp.status_code == 400: continue
            resp.raise_for_status()
            content = resp.json()['choices'][0]['message']['content']
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0].strip()
            elif "```" in content:
                content = content.split("```")[1].split("```")[0].strip()
            return json.loads(content)
        except Exception:
            continue
    return None

def call_ollama(prompt, model='llama3:8b'):
    print(f"[*] Local Ollama ({model})...")
    try:
        resp = requests.post(OLLAMA_ENDPOINT, json={"model": model, "prompt": prompt, "stream": False, "format": "json"}, timeout=60)
        resp.raise_for_status()
        return json.loads(resp.json().get("response"))
    except Exception:
        return None

def solve_with_priority(prompt):
    attempts = [
        ("Gemini 2.0 Flash", lambda: call_gemini(prompt, 'gemini-2.0-flash')),
        ("Groq Llama 3 70B", lambda: call_groq(prompt)),
        ("Gemini Flash Latest", lambda: call_gemini(prompt, 'gemini-flash-latest')),
        ("Local qwen2.5-coder", lambda: call_ollama(prompt, 'qwen2.5-coder:latest')),
        ("Local llama3", lambda: call_ollama(prompt, 'llama3:8b')),
    ]
    for name, fn in attempts:
        try:
            result = fn()
            if result:
                print(f"[+] Success with {name}")
                return result
        except Exception:
            continue
    return None

async def call_gemini_web(prompt_text):
    """Connect to Chrome via CDP, send prompt to Gemini web, extract JSON response."""
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.connect_over_cdp("http://127.0.0.1:9222")
        context = browser.contexts[0]
        page = None

        for pg in context.pages:
            if "gemini.google.com" in pg.url:
                page = pg
                break

        if not page:
            page = await context.new_page()
            await page.goto("https://gemini.google.com/app/a4cd531f81f6f26d")
            await page.wait_for_load_state("networkidle")

        await page.evaluate("""(text) => {
            const el = document.querySelector('div[contenteditable="true"][role="textbox"]');
            if (el) {
                el.focus();
                document.execCommand('insertText', false, text);
            }
        }""", prompt_text)

        send_selectors = [
            'button[aria-label="Send message"]',
            'button[data-testid="send-button"]',
            'mat-icon[fonticon="arrow_upward"]'
        ]
        for sel in send_selectors:
            try:
                btn = page.locator(sel).first
                if await btn.is_visible(timeout=2000):
                    await btn.click()
                    break
            except:
                continue

        for _ in range(30):
            await asyncio.sleep(2)
            code_blocks = await page.locator('code[data-test-id="code-content"]').all()
            for block in code_blocks:
                text = await block.inner_text()
                if '{"answers"' in text or '{"action"' in text:
                    match = re.search(r'\{.*\}', text, re.DOTALL)
                    if match:
                        return json.loads(match.group())

        return None

@app.route('/solve', methods=['POST'])
def solve():
    data = request.json
    scraped_text = data.get('text', '')
    fields = data.get('fields', [])

    if not scraped_text:
        return jsonify({"error": "No text received"}), 400

    has_sign = [f for f in fields if f.get('hasSign')]
    field_descriptions = []
    for i, f in enumerate(fields):
        parts = []
        if f.get('hasSign'):
            parts.append(f"Sign dropdown ({', '.join(f.get('signOptions', []))})")
        parts.append("Number input")
        if f.get('hasUnit'):
            parts.append(f"Unit dropdown ({', '.join(f.get('unitOptions', []))})")
        field_descriptions.append(f"Field {i+1}: " + " -> ".join(parts))

    field_summary = "\n".join(field_descriptions)

    prompt = f"""
You are a physics expert solving WileyPLUS assessments.
Analyze the following text and provide answers in JSON.

There are exactly {len(fields)} answer fields. Return EXACTLY {len(fields)} answers.

CRITICAL RULES:
- "value" must be ONLY a positive number. NO negative signs. NO ranges. NO units in value.
- If a field has a sign dropdown, put the negative sign in "sign", NOT in "value".
- "sign" must be EXACTLY "+" or "-" or empty string.
- "unit" must be EXACTLY one of the provided options for that field.

FIELD STRUCTURE:
{field_summary}

Return THIS structure only:
{{"answers":[{{"value":"number","sign":"+/-'","unit":"unit"}},...],"reasoning":"..."}}

If the answer is negative: {{"value":"45","sign":"-","unit":"m/s"}}
If the answer is positive: {{"value":"45","sign":"+","unit":"m/s"}}
If no sign dropdown: {{"value":"45","unit":"m/s"}}

TEXT:
{scraped_text}
"""

    result = solve_with_priority(prompt)
    if result:
        result['answers'] = clean_answers(result.get('answers', []), fields)
        if len(fields) and len(result['answers']) != len(fields):
            retry_prompt = prompt + f"\n\nCRITICAL: You MUST return EXACTLY {len(fields)} answers."
            retry_result = solve_with_priority(retry_prompt)
            if retry_result and len(retry_result.get('answers', [])) == len(fields):
                result = retry_result
                result['answers'] = clean_answers(result['answers'], fields)
        return jsonify(result)
    return jsonify({"error": "All models failed"}), 500

@app.route('/retry', methods=['POST'])
def retry():
    data = request.json
    original_text = data.get('original_text', '')
    previous_answers = data.get('previous_answers', [])
    feedback_text = data.get('feedback_text', '')
    fields = data.get('fields', [])
    diagnostics = data.get('diagnostics', None)

    if not original_text or not previous_answers:
        return jsonify({"error": "Missing data"}), 400

    prev_json = json.dumps(previous_answers, indent=2)

    field_descriptions = []
    for i, f in enumerate(fields):
        parts = []
        if f.get('hasSign'):
            parts.append(f"Sign dropdown ({', '.join(f.get('signOptions', []))})")
        parts.append("Number input")
        if f.get('hasUnit'):
            parts.append(f"Unit dropdown ({', '.join(f.get('unitOptions', []))})")
        field_descriptions.append(f"Field {i+1}: " + " -> ".join(parts))

    field_summary = "\n".join(field_descriptions)

    prompt = f"""
You are a physics expert with self-correction.

PROBLEM:
{original_text}

YOUR PREVIOUS ANSWERS (with Correct/Incorrect status):
{prev_json}

FEEDBACK FROM SYSTEM:
{feedback_text}

FIELD STRUCTURE:
{field_summary}

The answers marked "correct": true were accepted. DO NOT change them.
Only fix the answers marked "correct": false.

CRITICAL RULES:
- "value" must be ONLY a positive number. NO negative signs in value.
- If a field has a sign dropdown, use "sign": "-" for negative answers.
- "sign" must be "+", "-", or empty string.
- "unit" must match the exact options for that field.

Return this JSON:
{{"action":"revise","answers":[{{"value":"number","sign":"+/-'","unit":"unit"}},...],"reasoning":"..."}}

If ALL answers are correct: {{"action":"done","answers":{prev_json},"reasoning":"All correct"}}

Return ALL {len(fields)} answers (correct ones unchanged + fixed ones in their original order).
"""

    if diagnostics:
        prompt += f"""
====================================================
CRITICAL DOM DIAGNOSTICS (ATTEMPT 3 FAILING)
====================================================
The extension is failing to submit or fill correctly. Analyze the structural layout of the live page's scripts, inputs, and buttons to determine why:
{json.dumps(diagnostics)}

Look for:
1. Are there hidden inputs we are accidentally trying to fill? (Adapt your answers array to skip them).
2. Is the submit button disabled because a specific format is required?
3. Are we misinterpreting the framework (MUI, Ant Design)?
4. Are the sign dropdowns being skipped?

Return an EXTRA field in your JSON called "diagnostics_alert" containing a short technical explanation of what is breaking the submission.
"""

    result = solve_with_priority(prompt)
    if result:
        if result.get('answers'):
            result['answers'] = clean_answers(result['answers'], fields)
            for i, a in enumerate(result['answers']):
                if i < len(previous_answers) and previous_answers[i].get('correct') == True:
                    a['correct'] = True
        return jsonify(result)
    return jsonify({"error": "All retry models failed", "action": "failed"}), 500

@app.route('/gemini-web', methods=['GET', 'POST'])
def gemini_web():
    """Proxy to Gemini web via Playwright."""
    import asyncio
    data = request.json or {}
    prompt_text = data.get('prompt', '')
    if not prompt_text:
        return jsonify({"error": "No prompt"}), 400
    try:
        result = asyncio.run(call_gemini_web(prompt_text))
        if result:
            return jsonify(result)
        return jsonify({"error": "Gemini web returned no JSON"}), 500
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/', methods=['GET'])
def health():
    return jsonify({"status": "ok", "version": "8.0"})

if __name__ == "__main__":
    import asyncio
    print("="*50)
    print(" WILEY BRIDGE v8.0 (Grouped Fields: Sign+Number+Unit)")
    print(" Endpoints: /solve, /retry, /gemini-web, /")
    print("="*50)
    app.run(host='127.0.0.1', port=5000)
