import json

path = "/home/hal9000/.gemini/antigravity-cli/brain/825c1ef9-3661-4981-a009-b6d4785a5944/.system_generated/logs/transcript_full.jsonl"
with open(path, 'r') as f:
    for line in f:
        try:
            data = json.loads(line)
            if data.get("type") in ["USER_INPUT", "GENERIC"] and "content" in data:
                content = data["content"]
                if len(content) > 500:
                    print("======== MESSAGE START ========")
                    print(content[:500])
                    print("...")
        except:
            pass

