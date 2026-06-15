import json

aids = [
    "65bae45c-6fd5-47dd-946f-00d6b8169385",
    "9248f480-4e79-4c1e-af63-9544077607c0",
    "18381207-6b24-440c-9fc6-5f60b0501bd6",
    "a44a9343-6cb3-4499-a70d-027ab2576ad9",
    "9e75b490-9642-4004-a2ac-6ea24ce8fd9c"
]

for aid in aids:
    path = f"/home/hal9000/.gemini/antigravity-cli/brain/{aid}/.system_generated/logs/transcript_full.jsonl"
    with open(path, 'r') as f:
        for line in f:
            try:
                data = json.loads(line)
                if data.get("type") == "PLANNER_RESPONSE" and "tool_calls" in data:
                    for tc in data["tool_calls"]:
                        if tc.get("function", {}).get("name") == "default_api:send_message" or tc.get("function", {}).get("name") == "send_message":
                            args = json.loads(tc["function"]["arguments"])
                            msg = args.get("Message", "")
                            print(f"\n\n================ REPORT FROM {aid} ================\n")
                            print(msg)
            except Exception as e:
                pass
