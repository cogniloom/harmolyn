import json
import glob
import sys

agent_dirs = [
    "65bae45c-6fd5-47dd-946f-00d6b8169385", # Panels and Modals
    "9248f480-4e79-4c1e-af63-9544077607c0", # Social Features
    "18381207-6b24-440c-9fc6-5f60b0501bd6", # Server Features
    "a44a9343-6cb3-4499-a70d-027ab2576ad9", # Media and Misc
    "9e75b490-9642-4004-a2ac-6ea24ce8fd9c"  # Voice Events
]

for aid in agent_dirs:
    path = f"/home/hal9000/.gemini/antigravity-cli/brain/{aid}/.system_generated/logs/transcript.jsonl"
    try:
        with open(path, 'r') as f:
            lines = f.readlines()
        
        last_response = ""
        for line in reversed(lines):
            try:
                data = json.loads(line)
                if data.get("type") == "PLANNER_RESPONSE" and data.get("content"):
                    if "I have " in data["content"] or "review" in data["content"].lower():
                        last_response = data["content"]
                        if len(last_response) > 500:
                            break
            except:
                pass
        print(f"\n\n================ {aid} ================\n")
        print(last_response)
    except Exception as e:
        print(f"Error {aid}: {e}")

