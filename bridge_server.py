import os
import re
import json
import asyncio
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
GEMINI_WEB_URL = "https://gemini.google.com/app/a4cd531f81f6f26d"

if GEMINI_KEY:
    genai.configure(api_key=GEMINI_KEY)

app = Flask(__name__)
CORS(app)

# Playwright browser instance (persistent)
_pw_browser = None
_pw_context = None
_pw = None

CHROME_USER_DATA = r"C:\Users\thome\AppData\Local\Google\Chrome\User Data"
CHROME_CDP_URL = "http://127.0.0.1:9222"

async def get_playwright_browser():
    global _pw_browser, _pw_context, _pw
    if _pw_browser and _pw_browser.is_connected():
        return _pw_browser, _pw_context

    from playwright.async_api import async_playwright

    # Try connecting to Chrome via CDP first (launched by run.bat)
    if _pw is None:
        _pw = await async_playwright().start()

    try:
        _pw_browser = await _pw.chromium.connect_over_cdp(CHROME_CDP_URL)
        # Use the default context (first one) which has the user's login
        if _pw_browser.contexts:
            _pw_context = _pw_browser.contexts[0]
        else:
            _pw_context = await _pw_browser.new_context()
        print(f"[Playwright] Connected to Chrome via CDP at {CHROME_CDP_URL}")
        return _pw_browser, _pw_context
    except Exception as e:
        print(f"[Playwright] CDP connection failed: {e}")
        print("[Playwright] Launching new Chromium instance (you may need to log in manually)")
        _pw_browser = await _pw.chromium.launch(headless=False)
        _pw_context = await _pw_browser.new_context()
        print("[Playwright] New browser launched")
        return _pw_browser, _pw_context

async def call_gemini_web(prompt_text):
    """Use Playwright to interact with Gemini web UI."""
    import asyncio
    browser, context = await get_playwright_browser()

    # Find or create Gemini tab
    pages = context.pages
    gemini_page = None
    for p in pages:
        if "gemini.google.com" in p.url:
            gemini_page = p
            break
    if not gemini_page:
        gemini_page = await context.new_page()
        await gemini_page.goto(GEMINI_WEB_URL, wait_until="domcontentloaded")
        print("[Playwright] Opened new Gemini tab")
    else:
        print("[Playwright] Reusing existing Gemini tab:", gemini_page.url)

    # Wait for textbox
    textbox_selector = None
    for attempt in range(20):
        selectors = [
            'div[contenteditable="true"][role="textbox"]',
            'rich-textarea div[contenteditable="true"]',
            'div[contenteditable="true"]'
        ]
        for sel in selectors:
            count = await gemini_page.locator(sel).count()
            if count > 0:
                textbox_selector = sel
                break
        if textbox_selector:
            break
        print(f"[Playwright] Waiting for textbox... attempt {attempt+1}")
        await asyncio.sleep(1)

    if not textbox_selector:
        print("[Playwright] ERROR: No textbox found")
        return None

    # Inject text instantly via evaluate (most reliable for rich text editors)
    textbox = gemini_page.locator(textbox_selector).first
    await textbox.click()
    await asyncio.sleep(0.3)
    # Use page-level evaluate to set text and trigger events
    await gemini_page.evaluate("""(args) => {
        const [selector, text] = args;
        const el = document.querySelector(selector);
        if (!el) return;
        el.focus();
        el.textContent = text;
        // Trigger all the events React/Gemini listens for
        el.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        el.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, composed: true }));
        // Also try execCommand for framework state
        document.execCommand('selectAll');
        document.execCommand('insertText', false, text);
    }""", [textbox_selector, prompt_text])
    await asyncio.sleep(1)
    print(f"[Playwright] Injected prompt ({len(prompt_text)} chars)")
    await asyncio.sleep(1)

    # Find and click send button using locators
    send_selectors = [
        'button[aria-label="Send message"]',
        'button[aria-label="Send"]',
        '[data-testid="send-button"]',
        'mat-icon[fonticon="arrow_upward"]',
        '[data-mat-icon-name="arrow_upward"]',
        'mat-icon[fonticon="send"]',
        '[data-mat-icon-name="send"]'
    ]
    sent = False
    for sel in send_selectors:
        try:
            count = await gemini_page.locator(sel).count()
            if count > 0:
                el = gemini_page.locator(sel).first
                # Check if it's a button or inside a button
                tag = await el.evaluate("e => e.tagName.toLowerCase()")
                if tag != "button":
                    btn = gemini_page.locator(f"{sel} >> xpath=ancestor::button").first
                else:
                    btn = el
                # Check disabled state
                is_disabled = await btn.evaluate("e => e.disabled || e.getAttribute('aria-disabled') === 'true'")
                if is_disabled:
                    print(f"[Playwright] Button found via {sel} but DISABLED, waiting...")
                    await asyncio.sleep(2)
                await btn.click(timeout=5000)
                sent = True
                print(f"[Playwright] Clicked send via: {sel}")
                break
        except Exception as e:
            print(f"[Playwright] Selector {sel} failed: {e}")
            continue

    if not sent:
        # Fallback: press Enter
        print("[Playwright] No send button found, pressing Enter")
        textbox = gemini_page.locator(textbox_selector).first
        await textbox.press("Enter")

    # Wait for response with JSON
    print("[Playwright] Waiting for response...")
    json_text = None
    for attempt in range(60):  # 60 x 2s = 120s max
        await asyncio.sleep(2)
        try:
            # Check for code block with answers
            code_block_count = await gemini_page.locator('code[data-test-id="code-content"]').count()
            if code_block_count > 0:
                text = await gemini_page.locator('code[data-test-id="code-content"]').first.inner_text()
                if '"answers"' in text:
                    json_text = text
                    print(f"[Playwright] Found JSON in code block (attempt {attempt+1})")
                    break

            # Check body text for JSON
            body_text = await gemini_page.inner_text("body")
            match = re.search(r'\{[\s\S]*"answers"[\s\S]*\}', body_text)
            if match:
                json_text = match.group(0)
                print(f"[Playwright] Found JSON in body text (attempt {attempt+1})")
                break

            if attempt % 5 == 0:
                print(f"[Playwright] Waiting for response... attempt {attempt+1}")
        except Exception as e:
            print(f"[Playwright] Check error: {e}")

    if not json_text:
        print("[Playwright] ERROR: No JSON response after 120s")
        return None

    # Parse JSON
    try:
        # Try direct parse
        data = json.loads(json_text)
        if "answers" in data:
            return data
    except json.JSONDecodeError:
        pass

    # Try extracting JSON from markdown code block
    match = re.search(r'```json\s*([\s\S]*?)```', json_text)
    if match:
        try:
            data = json.loads(match.group(1).strip())
            if "answers" in data:
                return data
        except json.JSONDecodeError:
            pass

    # Try brace match
    match = re.search(r'\{[\s\S]*\}', json_text)
    if match:
        try:
            data = json.loads(match.group(0))
            if "answers" in data:
                return data
        except json.JSONDecodeError:
            pass

    print("[Playwright] ERROR: Could not parse JSON:", json_text[:300])
    return None

def clean_answers(answers):
    cleaned = []
    for a in answers:
        val = str(a.get('value', '')).strip()
        unit = str(a.get('unit', '')).strip()
        correct = a.get('correct', None)

        val = re.sub(r'[^0-9.\-]', '', val.split()[0] if ' ' in val else val)
        if val.startswith('+'):
            val = val[1:]

        if 'to' in str(a.get('value', '')).lower():
            parts = re.findall(r'[\d.]+', str(a.get('value', '')))
            if len(parts) >= 2:
                val = str((float(parts[0]) + float(parts[1])) / 2)

        valid_units = ['s', 'm', 'm/s', 'm/s^2', 'cm/s^2', 'No units', 'km/h', 'km', 'min']
        if unit not in valid_units:
            unit = 'No units'

        entry = {"value": val, "unit": unit}
        if correct is not None:
            entry['correct'] = correct
        cleaned.append(entry)

    cleaned = [a for a in cleaned if a['value'] and a['value'].replace('.','').replace('-','').replace('e','').isdigit()]
    return cleaned

def call_gemini(prompt, model_name='gemini-2.0-flash'):
    print(f"[*] Gemini ({model_name})...")
    try:
        model = genai.GenerativeModel(model_name)
        response = model.generate_content(prompt, generation_config={"response_mime_type": "application/json"})
        raw = response.text
        print(f"[DEBUG] Gemini raw: {raw[:400]}")
        return json.loads(raw)
    except Exception as e:
        print(f"[-] Gemini {model_name} failed: {e}")
        return None

def call_groq(prompt):
    if not GROQ_KEY:
        print("[-] No GROQ_API_KEY configured")
        return None
    models_to_try = ['llama-3.3-70b-versatile', 'llama3-70b-8192', 'mixtral-8x7b-32768']
    for model_name in models_to_try:
        print(f"[*] Groq ({model_name})...")
        try:
            resp = requests.post(GROQ_ENDPOINT, json={
                "model": model_name,
                "messages": [{"role": "user", "content": prompt + "\n\nReturn ONLY valid JSON."}],
                "temperature": 0.1
            }, headers={"Authorization": f"Bearer {GROQ_KEY}", "Content-Type": "application/json"}, timeout=60)
            if resp.status_code == 400:
                print(f"[-] Groq {model_name} 400: {resp.text[:300]}")
                continue
            resp.raise_for_status()
            content = resp.json()['choices'][0]['message']['content']
            print(f"[DEBUG] Groq raw: {content[:400]}")
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0].strip()
            elif "```" in content:
                content = content.split("```")[1].split("```")[0].strip()
            return json.loads(content)
        except Exception as e:
            print(f"[-] Groq {model_name} failed: {e}")
            continue
    return None

def call_ollama(prompt, model='llama3:8b'):
    print(f"[*] Local Ollama ({model})...")
    try:
        resp = requests.post(OLLAMA_ENDPOINT, json={"model": model, "prompt": prompt, "stream": False, "format": "json"}, timeout=60)
        resp.raise_for_status()
        raw = resp.json().get("response")
        print(f"[DEBUG] Ollama raw: {raw[:400]}")
        return json.loads(raw)
    except Exception as e:
        print(f"[-] Ollama failed: {e}")
        return None

def solve_with_priority(prompt, retry_context=None):
    """Try models in priority order: Gemini 2.0 Flash -> Groq -> Gemini Flash -> Ollama"""
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
        except Exception as e:
            print(f"[-] {name} threw: {e}")
            continue
    return None

@app.route('/solve', methods=['POST'])
def solve():
    data = request.json
    scraped_text = data.get('text', '')
    input_count = data.get('input_count', 0)
    if not scraped_text:
        return jsonify({"error": "No text received"}), 400

    cleaned_lines = [l.strip() for l in scraped_text.split('\n') if l.strip()]
    scraped_text = '\n'.join(cleaned_lines)

    count_hint = f"There are exactly {input_count} answer fields. Return EXACTLY {input_count} answers." if input_count else ""

    prompt = f"""
You are a physics expert solving WileyPLUS assessments.
Analyze the following text and provide answers in JSON.

{count_hint}

CRITICAL: "value" must be ONLY a number. NO ranges like "45.0 to 55.0". NO units in value. NO text.
"unit" must be EXACTLY one of: "s", "m", "m/s", "m/s^2", "cm/s^2", "No units", "km/h", "km", "min"

Return THIS structure only:
{{"answers":[{{"value":"number","unit":"unit"}},...],"reasoning":"..."}}

TEXT:
{scraped_text}
"""

    result = solve_with_priority(prompt)
    if result:
        result['answers'] = clean_answers(result.get('answers', []))
        # Pad or trim answers to match input_count
        if input_count and len(result['answers']) != input_count:
            print(f"[-] Answer count mismatch: got {len(result['answers'])}, expected {input_count}. Retrying with stronger hint...")
            stronger_hint = f"CRITICAL: There are EXACTLY {input_count} answer fields. You MUST return EXACTLY {input_count} answers, one for each field. Do NOT return fewer or more."
            retry_prompt = prompt + "\n\n" + stronger_hint
            retry_result = solve_with_priority(retry_prompt)
            if retry_result and len(retry_result.get('answers', [])) == input_count:
                result = retry_result
                result['answers'] = clean_answers(result['answers'])
        print("[+] Solve complete")
        return jsonify(result)
    return jsonify({"error": "All models failed"}), 500

@app.route('/retry', methods=['POST'])
def retry():
    data = request.json
    original_text = data.get('original_text', '')
    previous_answers = data.get('previous_answers', [])
    feedback_text = data.get('feedback_text', '')
    attempt = data.get('attempt', 1)
    input_count = data.get('input_count', 0)

    if not original_text or not previous_answers:
        return jsonify({"error": "Missing data"}), 400

    count_hint = f"\nCRITICAL: There are EXACTLY {input_count} answer fields. Return EXACTLY {input_count} answers." if input_count else ""

    cleaned_feedback = '\n'.join([l.strip() for l in feedback_text.split('\n') if l.strip()])
    prev_json = json.dumps(previous_answers, indent=2)

    # Separate correct and incorrect answers
    correct_answers = [a for a in previous_answers if a.get('correct') == True]
    incorrect_answers = [a for a in previous_answers if a.get('correct') == False]
    unknown_answers = [a for a in previous_answers if a.get('correct') is None]

    prompt = f"""
You are a physics expert with self-correction.

PROBLEM:
{original_text}

YOUR PREVIOUS ANSWERS (with Correct/Incorrect status):
{prev_json}

FEEDBACK:
{cleaned_feedback}

The answers marked "correct": true were accepted. DO NOT change them.
Only fix the answers marked "correct": false.

Return this JSON:
{{"action":"revise","answers":[{{"value":"number","unit":"unit"}},...],"reasoning":"..."}}

If ALL answers are correct: {{"action":"done","answers":{prev_json},"reasoning":"All correct"}}

Rules:
- "value" must be ONLY a number. NO ranges. NO units in value.
- "unit": "s", "m", "m/s", "m/s^2", "cm/s^2", "No units", "km/h", "km", "min"
- Return ALL answers (correct ones unchanged + fixed ones)
{count_hint}
"""
    result = solve_with_priority(prompt, retry_context=True)
    if result:
        if result.get('answers'):
            result['answers'] = clean_answers(result['answers'])
            # Preserve correct flags from input
            for i, a in enumerate(result['answers']):
                if i < len(previous_answers) and previous_answers[i].get('correct') == True:
                    a['correct'] = True
        print(f"[+] Retry attempt {attempt}: {result.get('action')}")
        return jsonify(result)
    return jsonify({"error": "All retry models failed", "action": "failed"}), 500

@app.route('/gemini-web', methods=['POST'])
def gemini_web():
    """Proxy to Gemini web via Playwright. Sends prompt, returns JSON."""
    data = request.json
    prompt_text = data.get('prompt', '')
    if not prompt_text:
        return jsonify({"error": "No prompt"}), 400

    print(f"[Server] /gemini-web request, prompt length={len(prompt_text)}")
    try:
        result = asyncio.run(call_gemini_web(prompt_text))
        if result:
            print(f"[Server] /gemini-web success, answers={len(result.get('answers', []))}")
            return jsonify(result)
        else:
            print("[Server] /gemini-web returned None")
            return jsonify({"error": "Gemini web returned no JSON"}), 500
    except Exception as e:
        print(f"[Server] /gemini-web error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route('/', methods=['GET'])
def health():
    return jsonify({"status": "ok", "version": "7.0"})

if __name__ == "__main__":
    print("="*50)
    print(" WILEY BRIDGE v7.0 (Playwright Gemini)")
    print(" Endpoints: /solve, /retry, /gemini-web, /")
    print("="*50)
    app.run(host='127.0.0.1', port=5000)
