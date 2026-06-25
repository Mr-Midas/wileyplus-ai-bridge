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

if __name__ == "__main__":
    print("="*50)
    print(" WILEY BRIDGE v6.1 (Smart Escalation)")
    print(" Priority: Gemini 2.0 Flash -> Groq -> Gemini Flash -> Local")
    print("="*50)
    app.run(host='127.0.0.1', port=5000)
