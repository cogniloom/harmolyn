import json

path = "/home/hal9000/.gemini/antigravity-cli/brain/825c1ef9-3661-4981-a009-b6d4785a5944/.system_generated/logs/transcript_full.jsonl"
with open(path, 'r') as f:
    for line in f:
        try:
            data = json.loads(line)
            if data.get("type") == "SYSTEM" and "content" in data:
                content = data["content"]
                if "Message from" in content or "Subagent" in content or "Findings:" in content:
                    print("------------------------")
                    print(content[:1000]) # Print beginning to see if it's a report
                    print("... (truncated)")
        except:
            pass

