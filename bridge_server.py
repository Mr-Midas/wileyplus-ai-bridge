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

def clean_answers(answers, allowed_units=None):
    cleaned = []
    for a in answers:
        val = str(a.get('value', '')).strip()
        unit = str(a.get('unit', '')).strip()
        correct = a.get('correct', None)

        # Clean number value
        val = re.sub(r'[^0-9.\-]', '', val.split()[0] if ' ' in val else val)
        if val.startswith('+'):
            val = val[1:]

        # Handle ranges (average them)
        if 'to' in str(a.get('value', '')).lower():
            parts = re.findall(r'[\d.]+', str(a.get('value', '')))
            if len(parts) >= 2:
                val = str((float(parts[0]) + float(parts[1])) / 2)

        # Clean unit based on dynamically scraped options
        if allowed_units and len(allowed_units) > 0:
            matched_unit = next((u for u in allowed_units if u.lower() == unit.lower()), None)
            if matched_unit:
                unit = matched_unit
            else:
                unit = allowed_units[0]  # Fallback to first available option

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
        return json.loads(raw)
    except Exception as e:
        print(f"[-] Gemini {model_name} failed: {e}")
        return None

def call_groq(prompt):
    if not GROQ_KEY:
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
                continue
            resp.raise_for_status()
            content = resp.json()['choices'][0]['message']['content']
            if "```json" in content:
                content = content.split("```json")[1].split("```")[0].strip()
            elif "```" in content:
                content = content.split("```")[1].split("```")[0].strip()
            return json.loads(content)
        except Exception as e:
            continue
    return None

def call_ollama(prompt, model='llama3:8b'):
    print(f"[*] Local Ollama ({model})...")
    try:
        resp = requests.post(OLLAMA_ENDPOINT, json={"model": model, "prompt": prompt, "stream": False, "format": "json"}, timeout=60)
        resp.raise_for_status()
        raw = resp.json().get("response")
        return json.loads(raw)
    except Exception:
        return None

def solve_with_priority(prompt, retry_context=None):
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

@app.route('/solve', methods=['POST'])
def solve():
    data = request.json
    scraped_text = data.get('text', '')
    input_count = data.get('input_count', 0)
    unit_options = data.get('unit_options', [])

    if not scraped_text:
        return jsonify({"error": "No text received"}), 400

    # Flatten dynamic unit options scraped from the page
    allowed_units = list(set([item for sublist in unit_options for item in sublist]))
    unit_hint = f'CRITICAL: "unit" must be EXACTLY one of the following options: {json.dumps(allowed_units)}' if allowed_units else 'CRITICAL: "unit" must be the correct unit, or "No units"'

    prompt = f"""
You are a physics expert solving WileyPLUS assessments.
Analyze the following text and provide answers in JSON.

There are exactly {input_count} answer fields. Return EXACTLY {input_count} answers.

CRITICAL: "value" must be ONLY a number. NO ranges like "45.0 to 55.0". NO units in value. NO text.
{unit_hint}

Return THIS structure only:
{{"answers":[{{"value":"number","unit":"unit"}},...],"reasoning":"..."}}

TEXT:
{scraped_text}
"""

    result = solve_with_priority(prompt)
    if result:
        result['answers'] = clean_answers(result.get('answers', []), allowed_units)
        if input_count and len(result['answers']) != input_count:
            retry_prompt = prompt + f"\n\nCRITICAL: You MUST return EXACTLY {input_count} answers, one for each field."
            retry_result = solve_with_priority(retry_prompt)
            if retry_result and len(retry_result.get('answers', [])) == input_count:
                result = retry_result
                result['answers'] = clean_answers(result['answers'], allowed_units)
        return jsonify(result)
    return jsonify({"error": "All models failed"}), 500

@app.route('/retry', methods=['POST'])
def retry():
    data = request.json
    original_text = data.get('original_text', '')
    previous_answers = data.get('previous_answers', [])
    feedback_text = data.get('feedback_text', '')
    input_count = data.get('input_count', 0)
    unit_options = data.get('unit_options', [])

    if not original_text or not previous_answers:
        return jsonify({"error": "Missing data"}), 400

    allowed_units = list(set([item for sublist in unit_options for item in sublist]))
    unit_hint = f'CRITICAL: "unit" must be EXACTLY one of: {json.dumps(allowed_units)}' if allowed_units else ''
    prev_json = json.dumps(previous_answers, indent=2)

    prompt = f"""
You are a physics expert with self-correction.

PROBLEM:
{original_text}

YOUR PREVIOUS ANSWERS (with Correct/Incorrect status):
{prev_json}

FEEDBACK FROM SYSTEM:
{feedback_text}

The answers marked "correct": true were accepted. DO NOT change them.
Only fix the answers marked "correct": false.

Return this JSON:
{{"action":"revise","answers":[{{"value":"number","unit":"unit"}},...],"reasoning":"..."}}

If ALL answers are correct: {{"action":"done","answers":{prev_json},"reasoning":"All correct"}}

Rules:
- "value" must be ONLY a number. NO ranges. NO units in value.
{unit_hint}
- Return ALL {input_count} answers (correct ones unchanged + fixed ones in their original order).
"""
    result = solve_with_priority(prompt, retry_context=True)
    if result:
        if result.get('answers'):
            result['answers'] = clean_answers(result['answers'], allowed_units)
            for i, a in enumerate(result['answers']):
                if i < len(previous_answers) and previous_answers[i].get('correct') == True:
                    a['correct'] = True
        return jsonify(result)
    return jsonify({"error": "All retry models failed", "action": "failed"}), 500

@app.route('/gemini-web', methods=['POST'])
def gemini_web():
    """Proxy to Gemini web via Playwright."""
    data = request.json
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
    return jsonify({"status": "ok", "version": "7.1"})

if __name__ == "__main__":
    import asyncio
    print("="*50)
    print(" WILEY BRIDGE v7.1 (Dynamic Dropdowns & Smart Retry)")
    print(" Endpoints: /solve, /retry, /gemini-web, /")
    print("="*50)
    app.run(host='127.0.0.1', port=5000)
