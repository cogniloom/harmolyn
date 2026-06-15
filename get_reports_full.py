import json
import glob

agent_dirs = [
    "65bae45c-6fd5-47dd-946f-00d6b8169385",
    "9248f480-4e79-4c1e-af63-9544077607c0",
    "18381207-6b24-440c-9fc6-5f60b0501bd6",
    "a44a9343-6cb3-4499-a70d-027ab2576ad9",
    "9e75b490-9642-4004-a2ac-6ea24ce8fd9c"
]

for aid in agent_dirs:
    path = f"/home/hal9000/.gemini/antigravity-cli/brain/{aid}/.system_generated/logs/transcript_full.jsonl"
    print(f"\n\n================ {aid} ================\n")
    found = False
    try:
        with open(path, 'r') as f:
            lines = f.readlines()
        for line in reversed(lines):
            try:
                data = json.loads(line)
                if "tool_calls" in data and data["tool_calls"]:
                    for tc in data["tool_calls"]:
                        if tc["function"]["name"] == "send_message":
                            args = json.loads(tc["function"]["arguments"])
                            msg = args.get("Message", "")
                            if len(msg) > 500:
                                print(msg)
                                found = True
                                break
            except:
                pass
            if found:
                break
    except Exception as e:
        print(f"Error: {e}")

